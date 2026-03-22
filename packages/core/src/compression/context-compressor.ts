/**
 * ContextCompressor - AI-based context compression for chat history (Issue #1311).
 *
 * Replaces hard truncation with intelligent summarization:
 * 1. When history exceeds threshold, split into older and recent parts
 * 2. Use AI to summarize older messages
 * 3. Return compressed context (summary + recent messages intact)
 *
 * Architecture:
 * ```
 * Pilot → doLoadPersistedHistory()
 *               ↓
 *         ContextCompressor.compress()
 *               ↓
 *         getProvider() → queryOnce() → summary
 *               ↓
 *         "## Summary\n...\n\n## Recent\n..."
 * ```
 *
 * Integration point: Called from Pilot.doLoadPersistedHistory()
 * to replace the current `history.slice(-maxContextLength)` truncation.
 */

import type pino from 'pino';
import type {
  ContextCompressionConfig,
  CompressionResult,
  MessageBoundary,
  CompressionStats,
} from './types.js';
import { CONTEXT_COMPRESSION } from '../constants/index.js';

/**
 * Configuration with defaults applied.
 */
interface ResolvedCompressionConfig {
  enabled: boolean;
  threshold: number;
  keepRecentMessages: number;
  summaryMaxTokens: number;
}

/**
 * Prompt template for AI-based summarization.
 */
const SUMMARY_PROMPT = `You are a conversation context compressor. Your task is to summarize the following chat history into a concise, informative summary.

## Rules:
- Preserve key facts, decisions, and conclusions
- Keep important names, numbers, and technical details
- Note any ongoing tasks or pending actions
- Use the same language as the original conversation
- Be concise but informative (target: ~{maxTokens} tokens)
- Format as a brief narrative, not a list

## Chat History to Summarize:
{history}

## Summary:`;

/**
 * ContextCompressor provides AI-based context compression.
 *
 * Instead of hard-truncating history (which loses all older context),
 * this module:
 * 1. Keeps the most recent N messages intact for continuity
 * 2. Summarizes older messages using AI
 * 3. Combines summary + recent messages
 *
 * This preserves the semantic meaning of older conversations while
 * reducing token usage.
 */
export class ContextCompressor {
  private readonly logger: pino.Logger;
  private readonly config: ResolvedCompressionConfig;
  private stats: CompressionStats = {
    totalCompressions: 0,
    totalCharsSaved: 0,
  };

  constructor(config: ContextCompressionConfig, logger: pino.Logger) {
    this.logger = logger;
    this.config = {
      enabled: config.enabled ?? CONTEXT_COMPRESSION.DEFAULT_ENABLED,
      threshold: config.threshold ?? CONTEXT_COMPRESSION.DEFAULT_THRESHOLD,
      keepRecentMessages: config.keepRecentMessages ?? CONTEXT_COMPRESSION.DEFAULT_KEEP_RECENT_MESSAGES,
      summaryMaxTokens: config.summaryMaxTokens ?? CONTEXT_COMPRESSION.DEFAULT_SUMMARY_MAX_TOKENS,
    };
  }

  /**
   * Check if compression is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get compression configuration.
   */
  getConfig(): ResolvedCompressionConfig {
    return { ...this.config };
  }

  /**
   * Get compression statistics.
   */
  getStats(): CompressionStats {
    return { ...this.stats };
  }

  /**
   * Compress chat history using AI-based summarization.
   *
   * If the history is shorter than the threshold, returns it unchanged.
   * Otherwise, splits into older and recent parts, summarizes the older
   * part using AI, and combines them.
   *
   * @param history - Raw chat history text
   * @param summarizeFn - Async function that takes a prompt and returns a summary string
   * @returns Compression result with the processed content
   */
  async compress(
    history: string,
    summarizeFn: (prompt: string) => Promise<string>
  ): Promise<CompressionResult> {
    const originalLength = history.length;

    // If history is short enough or compression is disabled, return as-is
    if (!this.config.enabled || originalLength <= this.config.threshold) {
      return {
        compressed: false,
        content: history,
        originalLength,
        compressedLength: originalLength,
        summaryLength: 0,
      };
    }

    this.logger.info(
      { originalLength, threshold: this.config.threshold, keepRecent: this.config.keepRecentMessages },
      'Context compression triggered'
    );

    try {
      // Split history into messages
      const messages = this.splitIntoMessages(history);

      if (messages.length <= this.config.keepRecentMessages) {
        // Not enough messages to split - just truncate
        this.logger.debug(
          { messageCount: messages.length, keepRecent: this.config.keepRecentMessages },
          'Not enough messages to compress, falling back to truncation'
        );
        const truncated = history.slice(-this.config.threshold);
        return {
          compressed: true,
          content: truncated,
          originalLength,
          compressedLength: truncated.length,
          summaryLength: 0,
        };
      }

      // Split into older and recent messages
      const splitIndex = messages.length - this.config.keepRecentMessages;
      const olderMessages = messages.slice(0, splitIndex);
      const recentMessages = messages.slice(splitIndex);

      // Build older history text for summarization
      const olderText = olderMessages.map(m => m.content).join('\n---\n');

      // Generate AI summary of older messages
      const prompt = SUMMARY_PROMPT
        .replace('{maxTokens}', String(this.config.summaryMaxTokens))
        .replace('{history}', olderText);

      const summary = await summarizeFn(prompt);

      // Combine summary with recent messages
      const recentText = recentMessages.map(m => m.content).join('\n---\n');
      const compressedContent = this.formatCompressedContent(summary, recentText);

      const compressedLength = compressedContent.length;

      // Update stats
      this.stats.totalCompressions++;
      this.stats.totalCharsSaved += (originalLength - compressedLength);
      this.stats.lastCompressedAt = Date.now();

      this.logger.info(
        {
          originalLength,
          compressedLength,
          charsSaved: originalLength - compressedLength,
          olderMessageCount: olderMessages.length,
          recentMessageCount: recentMessages.length,
          summaryLength: summary.length,
        },
        'Context compression completed'
      );

      return {
        compressed: true,
        content: compressedContent,
        originalLength,
        compressedLength,
        summaryLength: summary.length,
      };
    } catch (error) {
      this.logger.error(
        { err: error, originalLength },
        'Context compression failed, falling back to truncation'
      );

      // Fallback to hard truncation
      const truncated = history.slice(-this.config.threshold);
      return {
        compressed: true,
        content: truncated,
        originalLength,
        compressedLength: truncated.length,
        summaryLength: 0,
      };
    }
  }

  /**
   * Split history text into individual messages based on separators.
   *
   * The history format uses `---` as message boundaries.
   * Each message typically starts with an emoji (👤/🤖) and timestamp.
   *
   * @param history - Raw chat history text
   * @returns Array of message boundaries with content
   */
  splitIntoMessages(history: string): MessageBoundary[] {
    const messages: MessageBoundary[] = [];

    // Split by message separator (--- on its own line)
    // The history format is:
    // 👤 [timestamp] (messageId)\ncontent\n\n---\n🤖 [timestamp] (messageId)\ncontent\n\n---
    const separator = '\n---\n';
    let searchStart = 0;

    while (searchStart < history.length) {
      let separatorIndex = history.indexOf(separator, searchStart);

      if (separatorIndex === -1) {
        // No more separators - rest is the last message
        if (searchStart < history.length) {
          const content = history.slice(searchStart).trim();
          if (content) {
            messages.push({
              start: searchStart,
              end: history.length,
              content,
            });
          }
        }
        break;
      }

      // Extract message content (from searchStart to separatorIndex)
      const content = history.slice(searchStart, separatorIndex).trim();
      if (content) {
        messages.push({
          start: searchStart,
          end: separatorIndex,
          content,
        });
      }

      searchStart = separatorIndex + separator.length;
    }

    return messages;
  }

  /**
   * Format the compressed content with summary and recent messages.
   *
   * @param summary - AI-generated summary of older messages
   * @param recentText - Recent messages kept intact
   * @returns Formatted compressed content
   */
  private formatCompressedContent(summary: string, recentText: string): string {
    const parts: string[] = [];

    parts.push('## 📋 Earlier Conversation Summary');
    parts.push('');
    parts.push(summary);
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('## 💬 Recent Messages');
    parts.push('');
    parts.push(recentText);

    return parts.join('\n');
  }
}
