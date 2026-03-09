/**
 * History Compressor - AI-based context compression for chat history.
 *
 * Issue #1213: Implements AI-based summarization to reduce token usage
 * while preserving semantic information from conversation history.
 *
 * Strategy:
 * - Keep recent N messages in full detail
 * - Compress older messages into a semantic summary
 * - Preserve key decisions, conclusions, and user preferences
 */

import type { Logger } from 'pino';
import { CONTEXT_COMPRESSION } from '../../config/constants.js';

/**
 * Parsed message from history
 */
export interface ParsedMessage {
  timestamp: string;
  direction: 'user' | 'bot';
  messageId: string;
  senderId: string;
  messageType: string;
  content: string;
}

/**
 * Result of history compression
 */
export interface CompressionResult {
  /** Compressed history text */
  compressedHistory: string;
  /** Original character count */
  originalLength: number;
  /** Compressed character count */
  compressedLength: number;
  /** Number of messages processed */
  messageCount: number;
  /** Number of messages kept in full */
  keptMessageCount: number;
  /** Whether compression was applied */
  wasCompressed: boolean;
}

/**
 * Summarization request for LLM
 */
interface SummarizationRequest {
  oldMessages: ParsedMessage[];
  summaryMaxLength: number;
}

/**
 * History Compressor - compresses chat history using AI summarization.
 */
export class HistoryCompressor {
  private readonly logger: Logger;
  private readonly summaryGenerator: (request: SummarizationRequest) => Promise<string>;

  constructor(
    logger: Logger,
    summaryGenerator: (request: SummarizationRequest) => Promise<string>
  ) {
    this.logger = logger;
    this.summaryGenerator = summaryGenerator;
  }

  /**
   * Compress chat history if it exceeds the threshold.
   *
   * @param history - Raw history text from MessageLogger
   * @returns Compression result with compressed text and metadata
   */
  async compress(history: string): Promise<CompressionResult> {
    const originalLength = history.length;

    // Check if compression is enabled and needed
    if (!CONTEXT_COMPRESSION.ENABLED) {
      this.logger.debug('Context compression is disabled');
      return {
        compressedHistory: history,
        originalLength,
        compressedLength: originalLength,
        messageCount: 0,
        keptMessageCount: 0,
        wasCompressed: false,
      };
    }

    if (originalLength < CONTEXT_COMPRESSION.THRESHOLD) {
      this.logger.debug(
        { length: originalLength, threshold: CONTEXT_COMPRESSION.THRESHOLD },
        'History below compression threshold'
      );
      return {
        compressedHistory: history,
        originalLength,
        compressedLength: originalLength,
        messageCount: 0,
        keptMessageCount: 0,
        wasCompressed: false,
      };
    }

    // Parse messages
    const messages = this.parseMessages(history);
    const messageCount = messages.length;

    this.logger.info(
      { originalLength, messageCount, threshold: CONTEXT_COMPRESSION.THRESHOLD },
      'Starting history compression'
    );

    // If we have fewer messages than we want to keep, no compression needed
    if (messageCount <= CONTEXT_COMPRESSION.KEEP_RECENT_MESSAGES) {
      this.logger.debug(
        { messageCount, keepCount: CONTEXT_COMPRESSION.KEEP_RECENT_MESSAGES },
        'Not enough messages to compress'
      );
      return {
        compressedHistory: history,
        originalLength,
        compressedLength: originalLength,
        messageCount,
        keptMessageCount: messageCount,
        wasCompressed: false,
      };
    }

    // Split messages: keep recent, compress old
    const keepCount = CONTEXT_COMPRESSION.KEEP_RECENT_MESSAGES;
    const recentMessages = messages.slice(-keepCount);
    const oldMessages = messages.slice(0, -keepCount);

    // Generate summary for old messages
    const summary = await this.generateSummary(oldMessages);

    // Reconstruct history with summary
    const compressedHistory = this.reconstructHistory(summary, recentMessages);
    const compressedLength = compressedHistory.length;

    this.logger.info(
      {
        originalLength,
        compressedLength,
        compressionRatio: `${((1 - compressedLength / originalLength) * 100).toFixed(1)  }%`,
        messageCount,
        keptMessageCount: keepCount,
        oldMessageCount: oldMessages.length,
      },
      'History compression complete'
    );

    return {
      compressedHistory,
      originalLength,
      compressedLength,
      messageCount,
      keptMessageCount: keepCount,
      wasCompressed: true,
    };
  }

  /**
   * Parse messages from Markdown history format.
   *
   * Expected format:
   * ## [timestamp] 📥/📤 User/Bot (message_id: xxx)
   * **Sender**: xxx
   * **Type**: xxx
   * content
   * ---
   */
  parseMessages(history: string): ParsedMessage[] {
    const messages: ParsedMessage[] = [];

    // Split by message headers (## [timestamp])
    const parts = history.split(/(?=## \[)/);

    for (const part of parts) {
      if (!part.trim()) {continue;}

      // Match message header
      const headerMatch = part.match(/## \[([^\]]+)\] ([📥📤]) (User|Bot) \(message_id: ([^)]+)\)/);
      if (!headerMatch) {
        continue;
      }

      const [, timestamp, , role, messageId] = headerMatch;
      const direction = role === 'User' ? 'user' : 'bot';

      // Extract sender
      const senderMatch = part.match(/\*\*Sender\*\*:\s*(.+)/);
      const senderId = senderMatch ? senderMatch[1].trim() : 'unknown';

      // Extract type
      const typeMatch = part.match(/\*\*Type\*\*:\s*(.+)/);
      const messageType = typeMatch ? typeMatch[1].trim() : 'text';

      // Extract content (between Type line and ---)
      const contentMatch = part.match(/\*\*Type\*\*:[^\n]*\n([\s\S]*?)\n---/);
      const content = contentMatch ? contentMatch[1].trim() : '';

      messages.push({
        timestamp,
        direction,
        messageId,
        senderId,
        messageType,
        content,
      });
    }

    return messages;
  }

  /**
   * Generate a summary of old messages using the configured summarizer.
   */
  private async generateSummary(oldMessages: ParsedMessage[]): Promise<string> {
    if (oldMessages.length === 0) {
      return '';
    }

    try {
      const summary = await this.summaryGenerator({
        oldMessages,
        summaryMaxLength: CONTEXT_COMPRESSION.SUMMARY_MAX_LENGTH,
      });

      return summary;
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to generate history summary');

      // Fallback: create a simple list summary
      return this.createFallbackSummary(oldMessages);
    }
  }

  /**
   * Create a simple fallback summary without LLM.
   */
  private createFallbackSummary(oldMessages: ParsedMessage[]): string {
    const keyPoints: string[] = [];

    for (const msg of oldMessages) {
      // Extract first line or first 100 chars as key point
      const [firstLine] = msg.content.split('\n');
      const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)  }...` : firstLine;

      if (preview.trim()) {
        keyPoints.push(`- [${msg.direction.toUpperCase()}]: ${preview}`);
      }
    }

    const summary = `## Previous Conversation Summary

${keyPoints.slice(0, 10).join('\n')}
${keyPoints.length > 10 ? `\n... and ${keyPoints.length - 10} more messages` : ''}

---
`;

    return summary.slice(0, CONTEXT_COMPRESSION.SUMMARY_MAX_LENGTH);
  }

  /**
   * Reconstruct history with summary and recent messages.
   */
  private reconstructHistory(summary: string, recentMessages: ParsedMessage[]): string {
    const parts: string[] = [];

    // Add summary header if we have a summary
    if (summary) {
      parts.push(summary);
    }

    // Add recent messages in original format
    for (const msg of recentMessages) {
      const emoji = msg.direction === 'user' ? '📥' : '📤';
      const role = msg.direction === 'user' ? 'User' : 'Bot';

      parts.push(`

## [${msg.timestamp}] ${emoji} ${role} (message_id: ${msg.messageId})

**Sender**: ${msg.senderId}
**Type**: ${msg.messageType}

${msg.content}

---
`);
    }

    return parts.join('\n');
  }
}

/**
 * Create a summary generator function that uses a simple LLM call.
 *
 * This is a default implementation that can be overridden for more sophisticated
 * summarization strategies.
 */
export function createDefaultSummaryGenerator(
  logger: Logger
): (request: SummarizationRequest) => Promise<string> {
  return (request: SummarizationRequest): Promise<string> => {
    const { oldMessages, summaryMaxLength } = request;

    // Format messages for summarization
    const formattedMessages = oldMessages
      .map(msg => `[${msg.direction.toUpperCase()}]: ${msg.content}`)
      .join('\n\n');

    // Note: In a real implementation, this would call the LLM API
    // For now, we return a placeholder that will be replaced by actual LLM call
    // The prompt below shows what would be sent to the LLM
    const _summarizationPrompt = `Please summarize the following conversation history, preserving:
1. Key decisions and conclusions
2. Important context and preferences
3. Main topics discussed

Conversation history:
${formattedMessages}

Summary (concise, max ${Math.floor(summaryMaxLength / 4)} words):`;

    logger.debug({
      messageCount: oldMessages.length,
      promptLength: _summarizationPrompt.length,
    }, 'Summary generation requested');

    // Return a simple summary as fallback
    // The actual implementation should use the LLM to generate a proper summary
    return `## Previous Conversation Summary
This is a summary of ${oldMessages.length} earlier messages in this conversation.
The conversation covered various topics and decisions.

> Note: Enable LLM-based summarization for more detailed summaries.

---`;
  };
}
