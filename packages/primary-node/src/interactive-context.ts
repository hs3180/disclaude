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
 * 2. By chatId + actionValue (searches all contexts for a chat to find the
 *    one containing the matching actionValue, used as fallback when the real
 *    Feishu messageId doesn't match the synthetic messageId used during
 *    registration)
 *
 * Multiple interactive cards can coexist in the same chat. The chatId index
 * uses an LRU-style array to track recent cards per chat, bounded by
 * MAX_ENTRIES_PER_CHAT.
 *
 * Fixes #1625 — actionPrompts override when multiple cards share a chatId.
 */
export class InteractiveContextStore {
  private readonly contexts = new Map<string, InteractiveContext>();

  /**
   * Index: chatId → messageId[] (most recent last).
   * Used for chatId-based fallback lookup when the exact messageId is unknown.
   * Supports multiple interactive cards per chat (LRU-bounded).
   */
  private readonly chatIdIndex = new Map<string, string[]>();

  /** Maximum age for contexts before cleanup (default: 24 hours) */
  private readonly maxAge: number;

  /**
   * Maximum number of message IDs tracked per chatId.
   * Oldest entries are evicted when this limit is exceeded.
   */
  static readonly MAX_ENTRIES_PER_CHAT = 10;

  constructor(maxAge?: number) {
    this.maxAge = maxAge ?? 24 * 60 * 60 * 1000;
  }

  /**
   * Register action prompts for a message.
   *
   * Supports multiple interactive cards per chatId. The chatId index tracks
   * up to MAX_ENTRIES_PER_CHAT entries using LRU-style eviction.
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

    // Update chatId index — append to array (dedup, most recent last)
    const existing = this.chatIdIndex.get(chatId) ?? [];
    const filtered = existing.filter((id) => id !== messageId);
    filtered.push(messageId);

    // LRU eviction: keep only the most recent entries
    if (filtered.length > InteractiveContextStore.MAX_ENTRIES_PER_CHAT) {
      filtered.splice(0, filtered.length - InteractiveContextStore.MAX_ENTRIES_PER_CHAT);
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
   * Get action prompts by chatId (returns the most recent context for a chat).
   *
   * This is a backward-compatible fallback lookup for card action callbacks
   * where the real Feishu messageId doesn't match the synthetic messageId used
   * during registration.
   *
   * @param chatId - Chat ID to look up
   * @returns Action prompt map, or undefined if not found
   */
  getActionPromptsByChatId(chatId: string): ActionPromptMap | undefined {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds || messageIds.length === 0) {
      return undefined;
    }

    // Return the most recent context's prompts
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const context = this.contexts.get(messageIds[i]);
      if (context) {
        return context.actionPrompts;
      }
    }

    // All entries stale, clean up
    this.chatIdIndex.delete(chatId);
    return undefined;
  }

  /**
   * Find action prompts by chatId that contain a specific actionValue.
   *
   * Searches through all registered contexts for a chatId (from most recent
   * to oldest) and returns the first ActionPromptMap that contains the given
   * actionValue. This resolves the issue where multiple interactive cards in
   * the same chat cause the wrong prompts to be returned.
   *
   * @param chatId - Chat ID to search
   * @param actionValue - The action value to find
   * @returns Action prompt map containing the actionValue, or undefined
   */
  findActionPrompts(chatId: string, actionValue: string): ActionPromptMap | undefined {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds || messageIds.length === 0) {
      return undefined;
    }

    // Search from most recent to oldest
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const context = this.contexts.get(messageIds[i]);
      if (context && context.actionPrompts[actionValue]) {
        return context.actionPrompts;
      }
    }

    return undefined;
  }

  /**
   * Generate a prompt from an interaction using the registered template.
   *
   * Tries exact messageId lookup first, then falls back to chatId-based lookup.
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

    // Fallback: search all contexts for this chatId to find one containing the actionValue
    if (!prompts) {
      prompts = this.findActionPrompts(chatId, actionValue);
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
    if (removed) {
      // Remove this messageId from the chatId index array
      if (context) {
        const entries = this.chatIdIndex.get(context.chatId);
        if (entries) {
          const filtered = entries.filter((id) => id !== messageId);
          if (filtered.length === 0) {
            this.chatIdIndex.delete(context.chatId);
          } else {
            this.chatIdIndex.set(context.chatId, filtered);
          }
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

    for (const [messageId, context] of this.contexts) {
      if (now - context.createdAt > this.maxAge) {
        this.contexts.delete(messageId);
        // Remove from chatId index array
        const entries = this.chatIdIndex.get(context.chatId);
        if (entries) {
          const filtered = entries.filter((id) => id !== messageId);
          if (filtered.length === 0) {
            this.chatIdIndex.delete(context.chatId);
          } else {
            this.chatIdIndex.set(context.chatId, filtered);
          }
        }
        cleaned++;
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
