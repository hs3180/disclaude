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
 * Default maximum number of interactive contexts to retain per chatId.
 * Oldest entries are evicted when this limit is exceeded (LRU-style).
 */
const MAX_ENTRIES_PER_CHAT = 10;

/**
 * InteractiveContextStore - Manages interactive message contexts.
 *
 * Provides methods for registering, looking up, and cleaning up
 * action prompt contexts for interactive cards.
 *
 * Supports two lookup strategies:
 * 1. By messageId (exact match)
 * 2. By chatId (returns the most recent context for a chat, used as fallback
 *    when the real Feishu messageId doesn't match the synthetic messageId used
 *    during registration)
 *
 * The chatId index maintains multiple entries per chat (up to
 * MAX_ENTRIES_PER_CHAT) so that multiple interactive cards can coexist in
 * the same chat without overwriting each other's action prompt registrations.
 * When a chatId fallback lookup fails to find the requested actionValue in
 * the most recent context, older contexts are searched in reverse
 * chronological order (fixes #1625).
 */
export class InteractiveContextStore {
  private readonly contexts = new Map<string, InteractiveContext>();

  /**
   * Index: chatId → ordered array of messageIds (oldest first, newest last).
   * Used for chatId-based fallback lookup when the exact messageId is unknown.
   * Capped at MAX_ENTRIES_PER_CHAT entries per chatId (LRU eviction).
   */
  private readonly chatIdIndex = new Map<string, string[]>();

  /** Maximum age for contexts before cleanup (default: 24 hours) */
  private readonly maxAge: number;

  constructor(maxAge?: number) {
    this.maxAge = maxAge ?? 24 * 60 * 60 * 1000;
  }

  /**
   * Register action prompts for a message.
   *
   * Appends the messageId to the chatId index (deduped), evicting the oldest
   * entry when the per-chat limit (MAX_ENTRIES_PER_CHAT) is exceeded.
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

    // Append to chatId index (dedup, then LRU-evict if over limit)
    const existing = this.chatIdIndex.get(chatId) ?? [];
    const filtered = existing.filter((id) => id !== messageId);
    filtered.push(messageId);
    if (filtered.length > MAX_ENTRIES_PER_CHAT) {
      const evicted = filtered.splice(0, filtered.length - MAX_ENTRIES_PER_CHAT);
      // Clean up evicted contexts that are no longer referenced
      for (const evictedId of evicted) {
        this.contexts.delete(evictedId);
      }
    }
    this.chatIdIndex.set(chatId, filtered);

    logger.debug(
      { messageId, chatId, actions: Object.keys(actionPrompts), indexSize: filtered.length },
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
   * This is a fallback lookup for card action callbacks where the real Feishu
   * messageId doesn't match the synthetic messageId used during registration.
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
    const latestMessageId = messageIds[messageIds.length - 1];
    const context = this.contexts.get(latestMessageId);
    if (!context) {
      // Stale index entry — prune and retry
      this.pruneChatIdIndex(chatId);
      return this.getActionPromptsByChatId(chatId);
    }

    return context.actionPrompts;
  }

  /**
   * Search all contexts for a chatId to find one containing a specific actionValue.
   *
   * Iterates from newest to oldest, returning the first context whose actionPrompts
   * include the requested actionValue. This resolves the issue where multiple
   * interactive cards coexist in the same chat and the most recent card does not
   * contain the action being clicked (fixes #1625).
   *
   * @param chatId - Chat ID to search
   * @param actionValue - The action value to look for
   * @returns Action prompt map containing the actionValue, or undefined
   */
  findActionPromptsByActionValue(chatId: string, actionValue: string): ActionPromptMap | undefined {
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
   * Generate a prompt from an interaction using the registered template.
   *
   * Lookup order:
   * 1. Exact messageId match
   * 2. Most recent context for the chatId (chatId fallback)
   * 3. Search all contexts for the chatId to find one containing the actionValue
   *    (handles multiple coexisting interactive cards — fixes #1625)
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
    // 1. Try exact messageId lookup first
    let prompts = this.getActionPrompts(messageId);

    // 2. Fallback to most recent context for the chatId
    if (!prompts) {
      prompts = this.getActionPromptsByChatId(chatId);
    }

    // 3. If the most recent context doesn't contain the actionValue,
    //    search all contexts for this chatId (handles coexisting cards)
    if (prompts && !prompts[actionValue]) {
      const matched = this.findActionPromptsByActionValue(chatId, actionValue);
      if (matched) {
        prompts = matched;
      }
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
      // Remove from chatId index array
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
        cleaned++;
      }
    }

    // Prune chatId index for all chats to remove stale references
    if (cleaned > 0) {
      for (const [chatId, messageIds] of this.chatIdIndex) {
        this.chatIdIndex.set(
          chatId,
          messageIds.filter((id) => this.contexts.has(id))
        );
        if (this.chatIdIndex.get(chatId)!.length === 0) {
          this.chatIdIndex.delete(chatId);
        }
      }
      logger.debug({ count: cleaned }, 'Cleaned up expired interactive contexts');
    }

    return cleaned;
  }

  /**
   * Remove stale entries from a chatId index array (entries whose contexts
   * no longer exist).
   */
  private pruneChatIdIndex(chatId: string): void {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds) return;

    const pruned = messageIds.filter((id) => this.contexts.has(id));
    if (pruned.length === 0) {
      this.chatIdIndex.delete(chatId);
    } else {
      this.chatIdIndex.set(chatId, pruned);
    }
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
