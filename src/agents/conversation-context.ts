/**
 * ConversationContext - Manages conversation context for Pilot.
 *
 * Extracts context management concerns from Pilot:
 * - Thread root tracking (for reply chains)
 * - Message metadata (chatId, messageId, senderOpenId)
 *
 * This class provides a clean interface for managing the contextual
 * information needed for proper message handling and replies.
 */

import type pino from 'pino';

/**
 * Message context information.
 */
export interface MessageContext {
  /** Platform-specific chat identifier */
  chatId: string;
  /** Unique message identifier */
  messageId: string;
  /** Sender's open_id for @ mentions (optional) */
  senderOpenId?: string;
}

/**
 * Configuration for ConversationContext.
 */
export interface ConversationContextConfig {
  /** Logger instance */
  logger: pino.Logger;
}

/**
 * ConversationContext - Manages conversation context state.
 *
 * Primary responsibility is tracking thread roots for each chatId,
 * which enables proper reply threading in platforms like Feishu.
 */
export class ConversationContext {
  private readonly logger: pino.Logger;
  /** Map of chatId → thread root message ID */
  private readonly threadRoots = new Map<string, string>();

  constructor(config: ConversationContextConfig) {
    this.logger = config.logger;
  }

  /**
   * Set the thread root for a chatId.
   * This is the message ID that subsequent replies should reference.
   */
  setThreadRoot(chatId: string, messageId: string): void {
    this.threadRoots.set(chatId, messageId);
    this.logger.debug({ chatId, messageId }, 'Thread root set');
  }

  /**
   * Get the thread root for a chatId.
   * Returns undefined if no thread root is set.
   */
  getThreadRoot(chatId: string): string | undefined {
    return this.threadRoots.get(chatId);
  }

  /**
   * Delete the thread root for a chatId.
   * Used during session reset.
   */
  deleteThreadRoot(chatId: string): boolean {
    const existed = this.threadRoots.delete(chatId);
    if (existed) {
      this.logger.debug({ chatId }, 'Thread root deleted');
    }
    return existed;
  }

  /**
   * Clear all thread roots.
   * Used during shutdown.
   */
  clearAll(): void {
    this.threadRoots.clear();
    this.logger.debug('All thread roots cleared');
  }

  /**
   * Get the number of tracked thread roots.
   */
  size(): number {
    return this.threadRoots.size;
  }
}
