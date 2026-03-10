/**
 * History Compressor - AI-based chat history compression.
 *
 * Issue #1311: AI-based Context Compression independent solution.
 * Issue #1213: Context compression for session restoration.
 *
 * Compresses chat history using AI summarization to reduce token usage
 * while preserving semantic context. Keeps recent messages intact and
 * generates a summary of older messages.
 *
 * @module agents/pilot/history-compressor
 */

import { BaseAgent } from '../base-agent.js';
import type { BaseAgentConfig } from '../types.js';
import { Config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('HistoryCompressor');

/**
 * Configuration for HistoryCompressor.
 */
export interface HistoryCompressorConfig extends BaseAgentConfig {
  /** Character threshold to trigger compression (default: 10000) */
  threshold?: number;
  /** Number of recent messages to keep un-compressed (default: 4) */
  keepRecentMessages?: number;
  /** Maximum length of generated summary in characters (default: 2000) */
  summaryMaxLength?: number;
}

/**
 * Parsed message from chat history.
 */
interface ParsedMessage {
  timestamp: string;
  direction: 'user' | 'bot';
  messageId: string;
  content: string;
}

/**
 * History Compressor Agent.
 *
 * Uses LLM to compress chat history into a concise summary while
 * preserving key information like decisions, context, and user preferences.
 *
 * @example
 * ```typescript
 * const compressor = new HistoryCompressor(config);
 *
 * const compressed = await compressor.compress(longHistory);
 * // Returns: summary + recent messages
 * ```
 */
export class HistoryCompressor extends BaseAgent {
  readonly type = 'skill' as const;
  readonly name = 'HistoryCompressor';

  private readonly threshold: number;
  private readonly keepRecentMessages: number;
  private readonly summaryMaxLength: number;

  constructor(config: HistoryCompressorConfig) {
    super(config);
    this.threshold = config.threshold ?? 10000;
    this.keepRecentMessages = config.keepRecentMessages ?? 4;
    this.summaryMaxLength = config.summaryMaxLength ?? 2000;
  }

  protected getAgentName(): string {
    return 'HistoryCompressor';
  }

  /**
   * Compress chat history if it exceeds threshold.
   *
   * @param history - Raw chat history string
   * @returns Compressed history with summary + recent messages, or original if under threshold
   */
  async compress(history: string): Promise<string> {
    // Skip compression if history is under threshold
    if (history.length <= this.threshold) {
      logger.debug(
        { historyLength: history.length, threshold: this.threshold },
        'History under threshold, skipping compression'
      );
      return history;
    }

    logger.info(
      { historyLength: history.length, threshold: this.threshold },
      'Starting history compression'
    );

    try {
      // Parse messages from history
      const messages = this.parseMessages(history);

      if (messages.length <= this.keepRecentMessages) {
        logger.debug(
          { messageCount: messages.length, keepRecent: this.keepRecentMessages },
          'Not enough messages to compress, returning original'
        );
        return history;
      }

      // Split into old and recent
      const recentMessages = messages.slice(-this.keepRecentMessages);
      const oldMessages = messages.slice(0, -this.keepRecentMessages);

      // Generate summary for old messages
      const summary = await this.generateSummary(oldMessages);

      // Combine summary with recent messages
      const compressed = this.formatCompressedHistory(summary, recentMessages);

      logger.info(
        {
          originalLength: history.length,
          compressedLength: compressed.length,
          compressionRatio: `${((1 - compressed.length / history.length) * 100).toFixed(1)}%`,
        },
        'History compression complete'
      );

      return compressed;
    } catch (error) {
      logger.error({ err: error, historyLength: history.length }, 'History compression failed, returning original');
      // Return original history on error to avoid data loss
      return history;
    }
  }

  /**
   * Parse messages from markdown-formatted history.
   *
   * Expected format:
   * ## [timestamp] 📥/📤 User/Bot (message_id: xxx)
   * **Sender**: xxx
   * **Type**: xxx
   * content
   * ---
   */
  private parseMessages(history: string): ParsedMessage[] {
    const messages: ParsedMessage[] = [];

    // Split by message header pattern
    const messagePattern = /## \[([^\]]+)\] (📥|📤) (User|Bot) \(message_id: ([^)]+)\)/g;
    const parts = history.split(messagePattern);

    // parts[0] is header content before first message
    // Then alternating: timestamp, emoji, direction, messageId, content
    for (let i = 1; i < parts.length; i += 5) {
      const timestamp = parts[i]?.trim();
      const emoji = parts[i + 1]?.trim();
      const direction = parts[i + 2]?.trim();
      const messageId = parts[i + 3]?.trim();
      const content = parts[i + 4]?.trim() || '';

      if (timestamp && direction && messageId) {
        // Clean content: remove metadata lines and separator
        const cleanContent = content
          .replace(/\*\*Sender\*\*:.*\n?/g, '')
          .replace(/\*\*Type\*\*:.*\n?/g, '')
          .replace(/\n---\s*$/g, '')
          .trim();

        messages.push({
          timestamp,
          direction: emoji === '📥' ? 'user' : 'bot',
          messageId,
          content: cleanContent,
        });
      }
    }

    logger.debug({ messageCount: messages.length }, 'Parsed messages from history');
    return messages;
  }

  /**
   * Generate AI summary of old messages.
   */
  private async generateSummary(messages: ParsedMessage[]): Promise<string> {
    // Format messages for summarization
    const formattedHistory = messages
      .map((m) => `[${m.timestamp}] ${m.direction === 'user' ? '👤 User' : '🤖 Bot'}: ${m.content}`)
      .join('\n\n');

    const prompt = this.buildSummaryPrompt(formattedHistory);

    // Query LLM for summary
    const options = this.createSdkOptions({
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
    });

    let summary = '';
    for await (const { parsed } of this.queryOnce(prompt, options)) {
      if (parsed.content) {
        summary += parsed.content;
      }
      if (parsed.type === 'result') {
        break;
      }
    }

    // Truncate if too long
    if (summary.length > this.summaryMaxLength) {
      summary = `${summary.slice(0, this.summaryMaxLength)}...`;
    }

    return summary;
  }

  /**
   * Build prompt for summary generation.
   */
  private buildSummaryPrompt(history: string): string {
    return `# Chat History Summarization

Please compress the following conversation history into a concise summary. Keep:
1. Key decisions and conclusions
2. Important context information (user preferences, constraints, project details)
3. Action items or pending tasks
4. Any unresolved questions

Conversation history:
${history}

Requirements:
- Output ONLY the summary, no explanations or meta-commentary
- Maximum ${this.summaryMaxLength} characters
- Use bullet points for clarity
- Preserve important names, dates, and numbers
- Focus on information useful for continuing the conversation`;
  }

  /**
   * Format compressed history with summary and recent messages.
   */
  private formatCompressedHistory(summary: string, recentMessages: ParsedMessage[]): string {
    const recentFormatted = recentMessages
      .map((m) => {
        const emoji = m.direction === 'user' ? '📥' : '📤';
        const label = m.direction === 'user' ? 'User' : 'Bot';
        return `## [${m.timestamp}] ${emoji} ${label} (message_id: ${m.messageId})

**Sender**: ${m.direction === 'user' ? 'user' : 'bot'}
**Type**: text

${m.content}

---`;
      })
      .join('\n\n');

    return `## 📋 Conversation Summary (Compressed)

${summary}

---

## Recent Messages

${recentFormatted}`;
  }
}

/**
 * Create a HistoryCompressor instance with config from Config.getSessionRestoreConfig().
 */
export function createHistoryCompressor(): HistoryCompressor {
  const agentConfig = Config.getAgentConfig();
  const compressionConfig = Config.getSessionRestoreConfig().compression;

  return new HistoryCompressor({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    provider: agentConfig.provider,
    threshold: compressionConfig.threshold,
    keepRecentMessages: compressionConfig.keepRecentMessages,
    summaryMaxLength: compressionConfig.summaryMaxLength,
  });
}
