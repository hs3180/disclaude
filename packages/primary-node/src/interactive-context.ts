/**
 * Interactive Context Store.
 *
 * Manages interactive message contexts (action prompt registration, lookup,
 * generation, and cleanup) for the Primary Node. This module is the single
 * source of truth for interactive card action prompts, eliminating the
 * previous cross-process state dependency on MCP Server.
 *
 * Part of Phase 3 (#1572) of IPC layer responsibility refactoring (#1568).
 *
 * @module interactive-context
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('InteractiveContextStore');

/**
 * Action prompt map: button value → prompt template.
 */
export type ActionPromptMap = Record<string, string>;

/**
 * Interactive message context entry.
 */
export interface InteractiveContext {
  /** Message ID from Feishu (or synthetic) */
  messageId: string;
  /** Chat ID where the card was sent */
  chatId: string;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** Timestamp when the context was created */
  createdAt: number;
}

/**
 * InteractiveContextStore - Manages interactive message contexts.
 *
 * Provides methods for registering, looking up, and cleaning up
 * action prompt contexts for interactive cards.
 *
 * Supports two lookup strategies:
 * 1. By messageId (exact match)
 * 2. By chatId (searches all contexts for a chat, optionally matching a
 *    specific actionValue, used as fallback when the real Feishu messageId
 *    doesn't match the synthetic messageId used during registration)
 *
 * The chatId index uses an LRU-style list to support multiple interactive
 * cards coexisting in the same chat (Issue #1625).
 */
export class InteractiveContextStore {
  private readonly contexts = new Map<string, InteractiveContext>();

  /**
   * Index: chatId → ordered list of messageIds (most recent last).
   * Supports multiple cards per chat with LRU eviction.
   * Used for chatId-based fallback lookup when the exact messageId is unknown.
   */
  private readonly chatIdIndex = new Map<string, string[]>();

  /** Maximum number of messageIds to keep per chatId (LRU eviction) */
  static readonly MAX_ENTRIES_PER_CHAT = 10;

  /** Maximum age for contexts before cleanup (default: 24 hours) */
  private readonly maxAge: number;

  constructor(maxAge?: number) {
    this.maxAge = maxAge ?? 24 * 60 * 60 * 1000;
  }

  /**
   * Register action prompts for a message.
   *
   * Appends the messageId to the chatId index (or moves it to the end if
   * already present). When the list exceeds MAX_ENTRIES_PER_CHAT, the oldest
   * entries are evicted.
   *
   * @param messageId - Message ID (from Feishu or synthetic)
   * @param chatId - Chat ID where the card was sent
   * @param actionPrompts - Map of action values to prompt templates
   */
  register(messageId: string, chatId: string, actionPrompts: ActionPromptMap): void {
    this.contexts.set(messageId, {
      messageId,
      chatId,
      actionPrompts,
      createdAt: Date.now(),
    });

    // Update chatId index: move to end (most recent), deduplicate, LRU evict
    const existing = this.chatIdIndex.get(chatId) || [];
    const filtered = existing.filter((id) => id !== messageId);
    filtered.push(messageId);
    if (filtered.length > InteractiveContextStore.MAX_ENTRIES_PER_CHAT) {
      const evicted = filtered.splice(
        0,
        filtered.length - InteractiveContextStore.MAX_ENTRIES_PER_CHAT
      );
      // Also clean up contexts for evicted entries
      for (const evictedId of evicted) {
        this.contexts.delete(evictedId);
      }
    }
    this.chatIdIndex.set(chatId, filtered);

    logger.debug(
      { messageId, chatId, actions: Object.keys(actionPrompts) },
      'Action prompts registered'
    );
  }

  /**
   * Get action prompts for a message.
   *
   * @param messageId - Message ID to look up
   * @returns Action prompt map, or undefined if not found
   */
  getActionPrompts(messageId: string): ActionPromptMap | undefined {
    const context = this.contexts.get(messageId);
    return context?.actionPrompts;
  }

  /**
   * Get action prompts by chatId.
   *
   * Searches all contexts for the given chatId from most recent to oldest.
   * If `actionValue` is provided, returns the first context that contains
   * a matching action key; otherwise returns the most recent context.
   *
   * This is a fallback lookup for card action callbacks where the real Feishu
   * messageId doesn't match the synthetic messageId used during registration.
   *
   * @param chatId - Chat ID to look up
   * @param actionValue - Optional action value to match against contexts
   * @returns Action prompt map, or undefined if not found
   */
  getActionPromptsByChatId(chatId: string, actionValue?: string): ActionPromptMap | undefined {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds || messageIds.length === 0) {
      return undefined;
    }

    let mostRecentPrompts: ActionPromptMap | undefined;

    // Search from most recent to oldest
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const context = this.contexts.get(messageIds[i]);
      if (!context) {
        continue;
      }

      // Track the most recent valid context for fallback
      if (!mostRecentPrompts) {
        mostRecentPrompts = context.actionPrompts;
      }

      // If actionValue is provided, return the first context that contains it
      if (actionValue !== undefined && actionValue in context.actionPrompts) {
        return context.actionPrompts;
      }
    }

    // No context matched the actionValue — fall back to the most recent context
    // This preserves backward compatibility: callers without actionValue still
    // get the most recent context, and callers with actionValue get the best
    // available match (the most recent card) rather than nothing.
    if (mostRecentPrompts) {
      return mostRecentPrompts;
    }

    // All entries are stale, clean up
    this.chatIdIndex.delete(chatId);
    return undefined;
  }

  /**
   * Generate a prompt from an interaction using the registered template.
   *
   * Tries exact messageId lookup first, then falls back to chatId-based lookup
   * that searches all contexts for the chat to find one matching the actionValue.
   *
   * @param messageId - The card message ID (from Feishu callback)
   * @param chatId - The chat ID (for fallback lookup)
   * @param actionValue - The action value from the button/menu
   * @param actionText - The display text of the action (optional)
   * @param actionType - The type of action (button, select_static, etc.)
   * @param formData - Form data if the action includes form inputs
   * @returns The generated prompt or undefined if no template found
   */
  generatePrompt(
    messageId: string,
    chatId: string,
    actionValue: string,
    actionText?: string,
    actionType?: string,
    formData?: Record<string, unknown>
  ): string | undefined {
    // Try exact messageId lookup first
    let prompts = this.getActionPrompts(messageId);

    // Fallback to chatId-based lookup with actionValue matching
    if (!prompts) {
      prompts = this.getActionPromptsByChatId(chatId, actionValue);
    }

    if (!prompts) {
      return undefined;
    }

    const template = prompts[actionValue];
    if (!template) {
      logger.debug(
        { messageId, chatId, actionValue, availableActions: Object.keys(prompts) },
        'No prompt template found for action'
      );
      return undefined;
    }

    // Replace placeholders in the template
    let prompt = template;

    // Replace {{actionText}} with provided text, or empty string if not provided
    // to avoid leaving raw template placeholders in the generated prompt
    prompt = prompt.replace(/\{\{actionText\}\}/g, actionText ?? '');

    prompt = prompt.replace(/\{\{actionValue\}\}/g, actionValue);

    // Replace {{actionType}} with provided type, or empty string if not provided
    prompt = prompt.replace(/\{\{actionType\}\}/g, actionType ?? '');

    if (formData) {
      for (const [key, value] of Object.entries(formData)) {
        const placeholder = new RegExp(`\\{\\{form\\.${key}\\}\\}`, 'g');
        prompt = prompt.replace(placeholder, String(value));
      }
    }

    return prompt;
  }

  /**
   * Remove action prompts for a message.
   *
   * @param messageId - Message ID to unregister
   * @returns True if the context was found and removed
   */
  unregister(messageId: string): boolean {
    const context = this.contexts.get(messageId);
    const removed = this.contexts.delete(messageId);
    if (removed && context) {
      // Remove from chatId index array
      const messageIds = this.chatIdIndex.get(context.chatId);
      if (messageIds) {
        const updated = messageIds.filter((id) => id !== messageId);
        if (updated.length === 0) {
          this.chatIdIndex.delete(context.chatId);
        } else {
          this.chatIdIndex.set(context.chatId, updated);
        }
      }
      logger.debug({ messageId }, 'Action prompts unregistered');
    }
    return removed;
  }

  /**
   * Clean up expired interactive contexts.
   *
   * @returns Number of contexts cleaned up
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    const expiredChatIds = new Set<string>();

    for (const [messageId, context] of this.contexts) {
      if (now - context.createdAt > this.maxAge) {
        this.contexts.delete(messageId);
        expiredChatIds.add(context.chatId);
        cleaned++;
      }
    }

    // Clean up stale entries from chatId index arrays
    if (cleaned > 0) {
      for (const chatId of expiredChatIds) {
        const messageIds = this.chatIdIndex.get(chatId);
        if (messageIds) {
          const validIds = messageIds.filter((id) => this.contexts.has(id));
          if (validIds.length === 0) {
            this.chatIdIndex.delete(chatId);
          } else {
            this.chatIdIndex.set(chatId, validIds);
          }
        }
      }

      logger.debug({ count: cleaned }, 'Cleaned up expired interactive contexts');
    }

    return cleaned;
  }

  /**
   * Get the number of stored contexts.
   */
  get size(): number {
    return this.contexts.size;
  }

  /**
   * Clear all contexts.
   */
  clear(): void {
    this.contexts.clear();
    this.chatIdIndex.clear();
  }
}
