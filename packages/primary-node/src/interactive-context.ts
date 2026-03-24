/**
 * Interactive Context Store for Primary Node.
 *
 * Manages action prompts for interactive cards sent via IPC.
 * When a card is sent (e.g., via `sendInteractive` IPC), the action prompts
 * are registered here. When a card callback is received, the prompt is looked
 * up locally without needing cross-process IPC queries.
 *
 * Supports both messageId-based and chatId-based (fallback) lookup.
 *
 * Part of Issue #1568: IPC layer responsibility refactoring.
 * Phase 3 (#1572): Move interactive context management to Primary Node.
 *
 * @module primary-node/interactive-context
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('InteractiveContextStore');

/**
 * Context stored for each interactive card message.
 */
export interface InteractiveContext {
  /** The message ID from the card send response */
  messageId: string;
  /** The chat ID where the card was sent */
  chatId: string;
  /** Map of action values to prompt templates */
  actionPrompts: Record<string, string>;
  /** When this context was created */
  createdAt: number;
}

/**
 * Store for interactive card contexts.
 *
 * Provides two lookup strategies:
 * 1. **Primary**: By messageId (exact match)
 * 2. **Fallback**: By chatId (for cases where the real messageId from
 *    Feishu API doesn't match the one we stored, e.g., `feishuSendCard`
 *    may return a synthetic ID)
 */
export class InteractiveContextStore {
  /** Primary index: messageId → context */
  private readonly messageIndex = new Map<string, InteractiveContext>();
  /** Secondary index: chatId → context (fallback) */
  private readonly chatIndex = new Map<string, InteractiveContext>();
  /** Maximum age for contexts before cleanup (24 hours) */
  private static readonly MAX_AGE_MS = 24 * 60 * 60 * 1000;

  /**
   * Register action prompts for a message.
   */
  register(messageId: string, chatId: string, actionPrompts: Record<string, string>): void {
    const context: InteractiveContext = {
      messageId,
      chatId,
      actionPrompts,
      createdAt: Date.now(),
    };
    this.messageIndex.set(messageId, context);
    this.chatIndex.set(chatId, context);
    logger.debug(
      { messageId, chatId, actionCount: Object.keys(actionPrompts).length },
      'Action prompts registered'
    );
  }

  /**
   * Get action prompts for a message (primary lookup by messageId).
   */
  getByMessageId(messageId: string): Record<string, string> | undefined {
    const context = this.messageIndex.get(messageId);
    return context?.actionPrompts;
  }

  /**
   * Get action prompts for a chat (fallback lookup by chatId).
   */
  getByChatId(chatId: string): Record<string, string> | undefined {
    const context = this.chatIndex.get(chatId);
    return context?.actionPrompts;
  }

  /**
   * Look up action prompts with fallback chain:
   * 1. Try messageId lookup
   * 2. Fall back to chatId lookup
   */
  get(messageId: string, chatId?: string): Record<string, string> | undefined {
    const prompts = this.getByMessageId(messageId);
    if (prompts) return prompts;

    if (chatId) {
      return this.getByChatId(chatId);
    }

    return undefined;
  }

  /**
   * Generate a prompt from an action using registered templates.
   *
   * @param messageId - The card message ID
   * @param actionValue - The action value from the button/menu
   * @param actionText - The display text of the action (optional)
   * @param actionType - The type of action (button, select_static, etc.)
   * @param chatId - Optional chatId for fallback lookup
   * @returns The generated prompt or undefined if no template found
   */
  generatePrompt(
    messageId: string,
    actionValue: string,
    actionText?: string,
    actionType?: string,
    chatId?: string
  ): string | undefined {
    const prompts = this.get(messageId, chatId);
    if (!prompts) return undefined;

    const template = prompts[actionValue];
    if (!template) {
      logger.debug(
        { messageId, actionValue, availableActions: Object.keys(prompts) },
        'No prompt template found for action'
      );
      return undefined;
    }

    // Replace placeholders in the template
    let prompt = template;

    if (actionText) {
      prompt = prompt.replace(/\{\{actionText\}\}/g, actionText);
    }

    prompt = prompt.replace(/\{\{actionValue\}\}/g, actionValue);

    if (actionType) {
      prompt = prompt.replace(/\{\{actionType\}\}/g, actionType);
    }

    return prompt;
  }

  /**
   * Remove action prompts for a message.
   */
  unregister(messageId: string): boolean {
    const context = this.messageIndex.get(messageId);
    if (!context) return false;

    this.messageIndex.delete(messageId);
    // Only remove chatId index if it points to the same context
    const chatContext = this.chatIndex.get(context.chatId);
    if (chatContext && chatContext.messageId === messageId) {
      this.chatIndex.delete(context.chatId);
    }

    logger.debug({ messageId }, 'Action prompts unregistered');
    return true;
  }

  /**
   * Clean up expired contexts (older than MAX_AGE_MS).
   * @returns Number of contexts cleaned
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [messageId, context] of this.messageIndex) {
      if (now - context.createdAt > InteractiveContextStore.MAX_AGE_MS) {
        this.messageIndex.delete(messageId);
        cleaned++;
      }
    }

    // Clean chatIndex of stale entries
    for (const [chatId, context] of this.chatIndex) {
      if (now - context.createdAt > InteractiveContextStore.MAX_AGE_MS) {
        this.chatIndex.delete(chatId);
      }
    }

    if (cleaned > 0) {
      logger.debug({ count: cleaned }, 'Cleaned up expired interactive contexts');
    }

    return cleaned;
  }

  /**
   * Get the number of stored contexts.
   */
  get size(): number {
    return this.messageIndex.size;
  }

  /**
   * Clear all contexts (for testing).
   */
  clear(): void {
    this.messageIndex.clear();
    this.chatIndex.clear();
  }
}
