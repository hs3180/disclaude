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
 * 2. By chatId (returns the most recent context for a chat, used as fallback
 *    when the real Feishu messageId doesn't match the synthetic messageId used
 *    during registration)
 */
export class InteractiveContextStore {
  private readonly contexts = new Map<string, InteractiveContext>();

  /**
   * Index: chatId → most recent messageId.
   * Used for chatId-based fallback lookup when the exact messageId is unknown.
   */
  private readonly chatIdIndex = new Map<string, string>();

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

    // Update chatId index to point to the latest messageId for this chat
    this.chatIdIndex.set(chatId, messageId);

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
   * This is a fallback lookup for card action callbacks where the real Feishu
   * messageId doesn't match the synthetic messageId used during registration.
   *
   * @param chatId - Chat ID to look up
   * @returns Action prompt map, or undefined if not found
   */
  getActionPromptsByChatId(chatId: string): ActionPromptMap | undefined {
    const messageId = this.chatIdIndex.get(chatId);
    if (!messageId) {
      return undefined;
    }

    const context = this.contexts.get(messageId);
    if (!context) {
      // Stale index entry, clean up
      this.chatIdIndex.delete(chatId);
      return undefined;
    }

    return context.actionPrompts;
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

    // Fallback to chatId-based lookup
    if (!prompts) {
      prompts = this.getActionPromptsByChatId(chatId);
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

    if (actionText) {
      prompt = prompt.replace(/\{\{actionText\}\}/g, actionText);
    }

    prompt = prompt.replace(/\{\{actionValue\}\}/g, actionValue);

    if (actionType) {
      prompt = prompt.replace(/\{\{actionType\}\}/g, actionType);
    }

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
      // Clean up chatId index if it points to this messageId
      if (context && this.chatIdIndex.get(context.chatId) === messageId) {
        this.chatIdIndex.delete(context.chatId);
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
        // Clean up chatId index
        if (this.chatIdIndex.get(context.chatId) === messageId) {
          this.chatIdIndex.delete(context.chatId);
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
