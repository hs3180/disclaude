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
 * Default maximum number of messageIds to keep per chatId in the LRU index.
 * When exceeded, the oldest entries are evicted.
 */
const DEFAULT_MAX_ENTRIES_PER_CHAT = 10;

/**
 * InteractiveContextStore - Manages interactive message contexts.
 *
 * Provides methods for registering, looking up, and cleaning up
 * action prompt contexts for interactive cards.
 *
 * Supports two lookup strategies:
 * 1. By messageId (exact match)
 * 2. By chatId (searches all registered contexts for a chat, used as fallback
 *    when the real Feishu messageId doesn't match the synthetic messageId used
 *    during registration)
 *
 * The chatId index uses an LRU-style list per chatId so that multiple
 * interactive cards can coexist in the same chat without overwriting each
 * other's actionPrompts. Issue #1625.
 */
export class InteractiveContextStore {
  private readonly contexts = new Map<string, InteractiveContext>();

  /**
   * Index: chatId → ordered list of messageIds (oldest → newest).
   * Used for chatId-based fallback lookup when the exact messageId is unknown.
   * Acts as an LRU cache per chatId, evicting oldest entries when the limit
   * is reached. Issue #1625: changed from single-value to multi-value to
   * support multiple interactive cards in the same chat.
   */
  private readonly chatIdIndex = new Map<string, string[]>();

  /** Maximum age for contexts before cleanup (default: 24 hours) */
  private readonly maxAge: number;

  /**
   * Maximum number of messageIds to track per chatId.
   * When exceeded, the oldest entries are evicted from the index.
   */
  private readonly maxEntriesPerChat: number;

  constructor(maxAge?: number, maxEntriesPerChat?: number) {
    this.maxAge = maxAge ?? 24 * 60 * 60 * 1000;
    this.maxEntriesPerChat = maxEntriesPerChat ?? DEFAULT_MAX_ENTRIES_PER_CHAT;
  }

  /**
   * Register action prompts for a message.
   *
   * If a context with the same messageId already exists, it is updated in
   * place (the messageId retains its position in the chatId index). If this
   * is a new messageId for the chatId, it is appended to the end of the
   * chatId index and oldest entries are evicted if the per-chat limit is
   * reached. Issue #1625.
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

    // Update chatId index — append new entries, keep existing ones in place
    const existing = this.chatIdIndex.get(chatId);
    if (existing) {
      const idx = existing.indexOf(messageId);
      if (idx !== -1) {
        // messageId already tracked — update in place (no reordering)
        logger.debug(
          { messageId, chatId, actions: Object.keys(actionPrompts) },
          'Action prompts updated (existing entry)'
        );
        return;
      }
      // New messageId for this chat — append with LRU eviction
      existing.push(messageId);
      if (existing.length > this.maxEntriesPerChat) {
        existing.splice(0, existing.length - this.maxEntriesPerChat);
      }
    } else {
      this.chatIdIndex.set(chatId, [messageId]);
    }

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
   * Get action prompts by chatId (searches all registered contexts for a chat).
   *
   * This is a fallback lookup for card action callbacks where the real Feishu
   * messageId doesn't match the synthetic messageId used during registration.
   *
   * Searches from newest to oldest entry in the chatId index. Returns the
   * actionPrompts of the first context that is still present in the store.
   * Issue #1625: changed from single-entry to multi-entry search so that
   * multiple interactive cards in the same chat can all be resolved.
   *
   * @param chatId - Chat ID to look up
   * @returns Action prompt map, or undefined if no valid context found
   */
  getActionPromptsByChatId(chatId: string): ActionPromptMap | undefined {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds || messageIds.length === 0) {
      return undefined;
    }

    // Search from newest to oldest — return the first valid context
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const context = this.contexts.get(messageIds[i]);
      if (context) {
        return context.actionPrompts;
      }
    }

    // All entries are stale — clean up
    this.chatIdIndex.delete(chatId);
    return undefined;
  }

  /**
   * Generate a prompt from an interaction using the registered template.
   *
   * Tries exact messageId lookup first, then falls back to chatId-based
   * lookup which searches all contexts for the chat (newest to oldest).
   * Issue #1625: the chatId fallback now searches across multiple cards
   * registered for the same chatId, instead of only the most recent one.
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

    // Fallback: search all contexts for this chatId (newest to oldest)
    // until we find one that contains the requested actionValue.
    // Issue #1625: Previously only checked the single most recent context.
    if (!prompts) {
      const messageIds = this.chatIdIndex.get(chatId);
      if (messageIds) {
        for (let i = messageIds.length - 1; i >= 0; i--) {
          const context = this.contexts.get(messageIds[i]);
          if (context?.actionPrompts[actionValue]) {
            prompts = context.actionPrompts;
            break;
          }
        }
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
   * Removes the messageId from both the contexts map and the chatId index.
   * Issue #1625: chatId index is now an array per chatId, so we remove the
   * specific entry rather than deleting the entire index entry.
   *
   * @param messageId - Message ID to unregister
   * @returns True if the context was found and removed
   */
  unregister(messageId: string): boolean {
    const context = this.contexts.get(messageId);
    const removed = this.contexts.delete(messageId);
    if (removed && context) {
      // Remove this messageId from the chatId index array
      const entries = this.chatIdIndex.get(context.chatId);
      if (entries) {
        const idx = entries.indexOf(messageId);
        if (idx !== -1) {
          entries.splice(idx, 1);
        }
        if (entries.length === 0) {
          this.chatIdIndex.delete(context.chatId);
        }
      }
      logger.debug({ messageId }, 'Action prompts unregistered');
    }
    return removed;
  }

  /**
   * Clean up expired interactive contexts.
   *
   * Removes expired entries from both the contexts map and the chatId index.
   * Issue #1625: chatId index is now an array per chatId, so we remove
   * individual entries rather than deleting entire index entries.
   *
   * @returns Number of contexts cleaned up
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [messageId, context] of this.contexts) {
      if (now - context.createdAt > this.maxAge) {
        this.contexts.delete(messageId);
        // Remove this messageId from the chatId index array
        const entries = this.chatIdIndex.get(context.chatId);
        if (entries) {
          const idx = entries.indexOf(messageId);
          if (idx !== -1) {
            entries.splice(idx, 1);
          }
          if (entries.length === 0) {
            this.chatIdIndex.delete(context.chatId);
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
