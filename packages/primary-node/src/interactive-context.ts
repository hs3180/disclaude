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

/** Maximum number of message entries to keep per chatId in the LRU index */
const MAX_ENTRIES_PER_CHAT = 10;

/**
 * InteractiveContextStore - Manages interactive message contexts.
 *
 * Provides methods for registering, looking up, and cleaning up
 * action prompt contexts for interactive cards.
 *
 * Supports two lookup strategies:
 * 1. By messageId (exact match)
 * 2. By chatId (iterates through recent contexts for a chat, used as fallback
 *    when the real Feishu messageId doesn't match the synthetic messageId used
 *    during registration)
 *
 * The chatId index uses an LRU-style array per chat to support multiple
 * interactive cards coexisting in the same chat (fixes #1625).
 */
export class InteractiveContextStore {
  private readonly contexts = new Map<string, InteractiveContext>();

  /**
   * Index: chatId → messageId[] (ordered oldest to newest).
   * Used for chatId-based fallback lookup when the exact messageId is unknown.
   * Kept to MAX_ENTRIES_PER_CHAT entries per chatId via LRU eviction.
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
   * Appends the messageId to the chatId index (with dedup and LRU eviction)
   * so that multiple interactive cards can coexist in the same chat (#1625).
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

    // Append to chatId index (dedup + LRU eviction)
    const existing = this.chatIdIndex.get(chatId) ?? [];
    const filtered = existing.filter((id) => id !== messageId);
    filtered.push(messageId);
    if (filtered.length > MAX_ENTRIES_PER_CHAT) {
      filtered.splice(0, filtered.length - MAX_ENTRIES_PER_CHAT);
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
   * Get action prompts by chatId.
   *
   * This is a fallback lookup for card action callbacks where the real Feishu
   * messageId doesn't match the synthetic messageId used during registration.
   *
   * If `actionValue` is provided, searches from newest to oldest to find the
   * first context that contains a matching action value (#1625).
   * If `actionValue` is not provided, returns the most recent context's prompts.
   *
   * @param chatId - Chat ID to look up
   * @param actionValue - Optional action value to match against
   * @returns Action prompt map, or undefined if not found
   */
  getActionPromptsByChatId(chatId: string, actionValue?: string): ActionPromptMap | undefined {
    const messageIds = this.chatIdIndex.get(chatId);
    if (!messageIds || messageIds.length === 0) {
      return undefined;
    }

    if (actionValue !== undefined) {
      // Search from newest to oldest for a context containing this actionValue
      for (let i = messageIds.length - 1; i >= 0; i--) {
        const context = this.contexts.get(messageIds[i]);
        if (context && context.actionPrompts[actionValue]) {
          return context.actionPrompts;
        }
      }
      return undefined;
    }

    // No actionValue: return the most recent context's prompts
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const context = this.contexts.get(messageIds[i]);
      if (context) {
        return context.actionPrompts;
      }
    }

    // All entries are stale, clean up
    this.chatIdIndex.delete(chatId);
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

    // Fallback to chatId-based lookup (with actionValue for multi-card matching)
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
      // Remove this messageId from the chatId index array
      const index = this.chatIdIndex.get(context.chatId);
      if (index) {
        const filtered = index.filter((id) => id !== messageId);
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

    const expiredChatIds = new Set<string>();

    for (const [messageId, context] of this.contexts) {
      if (now - context.createdAt > this.maxAge) {
        this.contexts.delete(messageId);
        expiredChatIds.add(context.chatId);
        cleaned++;
      }
    }

    // Clean up expired messageIds from chatId index arrays
    for (const chatId of expiredChatIds) {
      const index = this.chatIdIndex.get(chatId);
      if (index) {
        const filtered = index.filter((id) => this.contexts.has(id));
        if (filtered.length === 0) {
          this.chatIdIndex.delete(chatId);
        } else {
          this.chatIdIndex.set(chatId, filtered);
        }
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
