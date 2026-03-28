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
 * 2. By chatId (searches all contexts for a chat to find one containing
 *    the requested actionValue, used as fallback when the real Feishu
 *    messageId doesn't match the synthetic messageId used during registration)
 *
 * Multiple cards per chat are supported via an LRU-style chatId index
 * (capped at MAX_ENTRIES_PER_CHAT entries per chatId).
 */
export class InteractiveContextStore {
  private readonly contexts = new Map<string, InteractiveContext>();

  /**
   * Index: chatId → ordered array of messageIds (oldest → newest).
   * Used for chatId-based fallback lookup when the exact messageId is unknown.
   * Capped at MAX_ENTRIES_PER_CHAT entries per chatId (LRU eviction).
   */
  private readonly chatIdIndex = new Map<string, string[]>();

  /** Maximum number of card contexts retained per chatId (LRU eviction). */
  private static readonly MAX_ENTRIES_PER_CHAT = 10;

  /** Maximum age for contexts before cleanup (default: 24 hours) */
  private readonly maxAge: number;

  constructor(maxAge?: number) {
    this.maxAge = maxAge ?? 24 * 60 * 60 * 1000;
  }

  /**
   * Register action prompts for a message.
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

    // Append to chatId index (deduplicate if re-registering same messageId)
    const existing = this.chatIdIndex.get(chatId) || [];
    const filtered = existing.filter((id) => id !== messageId);
    filtered.push(messageId);

    // LRU eviction: keep only the most recent entries
    if (filtered.length > InteractiveContextStore.MAX_ENTRIES_PER_CHAT) {
      const evicted = filtered.splice(0, filtered.length - InteractiveContextStore.MAX_ENTRIES_PER_CHAT);
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
   * Get action prompts by chatId (returns the most recent context for a chat).
   *
   * This is a general-purpose fallback for callers that don't have an actionValue.
   * For card action callbacks, prefer {@link generatePrompt} which searches all
   * same-chat contexts to find the one containing the specific actionValue.
   *
   * @param chatId - Chat ID to look up
   * @returns Action prompt map, or undefined if not found
   */
  getActionPromptsByChatId(chatId: string): ActionPromptMap | undefined {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds || messageIds.length === 0) {
      return undefined;
    }

    // Return the latest context's prompts
    const latestMessageId = messageIds[messageIds.length - 1];
    const context = this.contexts.get(latestMessageId);
    if (!context) {
      // Clean up stale entries from the index
      this.purgeStaleChatIdIndex(chatId, messageIds);
      return undefined;
    }

    return context.actionPrompts;
  }

  /**
   * Generate a prompt from an interaction using the registered template.
   *
   * Tries exact messageId lookup first, then falls back to searching all
   * contexts for the same chatId to find one containing the actionValue.
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

    // Fallback: search all contexts for this chatId to find one with the actionValue
    if (!prompts) {
      prompts = this.findActionPromptsForAction(chatId, actionValue);
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
   * Search all contexts for a chatId to find one containing the given actionValue.
   *
   * Iterates from newest to oldest, returning the first context whose actionPrompts
   * include the requested actionValue. This solves the overwrite problem where
   * multiple interactive cards exist in the same chat.
   *
   * @param chatId - Chat ID to search
   * @param actionValue - The action value to match
   * @returns Action prompt map containing the actionValue, or undefined
   */
  private findActionPromptsForAction(chatId: string, actionValue: string): ActionPromptMap | undefined {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds || messageIds.length === 0) {
      return undefined;
    }

    // Search from newest to oldest
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const context = this.contexts.get(messageIds[i]);
      if (context && context.actionPrompts[actionValue]) {
        return context.actionPrompts;
      }
    }

    return undefined;
  }

  /**
   * Remove stale entries from the chatId index (entries whose context no longer exists).
   *
   * @param chatId - Chat ID to purge
   * @param messageIds - Current array of messageIds for this chatId
   */
  private purgeStaleChatIdIndex(chatId: string, messageIds: string[]): void {
    const valid = messageIds.filter((id) => this.contexts.has(id));
    if (valid.length === 0) {
      this.chatIdIndex.delete(chatId);
    } else if (valid.length < messageIds.length) {
      this.chatIdIndex.set(chatId, valid);
    }
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
        const filtered = messageIds.filter((id) => id !== messageId);
        if (filtered.length === 0) {
          this.chatIdIndex.delete(context.chatId);
        } else {
          this.chatIdIndex.set(context.chatId, filtered);
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
    const affectedChatIds = new Set<string>();

    for (const [messageId, context] of this.contexts) {
      if (now - context.createdAt > this.maxAge) {
        this.contexts.delete(messageId);
        affectedChatIds.add(context.chatId);
        cleaned++;
      }
    }

    // Purge stale entries from chatId index for affected chats
    for (const chatId of affectedChatIds) {
      const messageIds = this.chatIdIndex.get(chatId);
      if (messageIds) {
        this.purgeStaleChatIdIndex(chatId, messageIds);
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
