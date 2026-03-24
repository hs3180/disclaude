/**
 * Interactive message context management for Primary Node.
 *
 * Manages action prompt registration, lookup, and cleanup for interactive cards.
 * Moved from MCP Server's `interactive-message.ts` as part of Phase 3 (#1572).
 *
 * Previously, interactive contexts were stored in MCP Server process memory.
 * Worker Node had to query MCP Server via IPC to get prompts on card actions.
 * Now, Primary Node owns the context lifecycle:
 *   - MCP Server sends card params via IPC → Primary Node builds + sends + registers
 *   - Card callback arrives at Primary Node → local prompt lookup (no cross-IPC)
 *   - Primary Node resolves prompt and routes to Worker Node
 *
 * @module primary-node/interactive-context
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('InteractiveContext');

/**
 * Map of action values to prompt templates.
 */
export type ActionPromptMap = Record<string, string>;

/**
 * Context for an interactive message.
 */
export interface InteractiveContext {
  /** Card message ID (or synthetic ID) */
  messageId: string;
  /** Chat ID where the card was sent */
  chatId: string;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** Timestamp when the context was created */
  createdAt: number;
}

/**
 * Default max age for contexts (24 hours).
 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Interactive context store for Primary Node.
 *
 * Manages action prompt registration, lookup, and cleanup.
 * Replaces the `interactiveContexts` Map that was previously in MCP Server.
 */
export class InteractiveContextStore {
  private contexts: Map<string, InteractiveContext> = new Map();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor() {
    // Start periodic cleanup (every 30 minutes)
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30 * 60 * 1000);
    // Allow process to exit even if timer is active
    if (this.cleanupTimer && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
    logger.debug('InteractiveContextStore created');
  }

  /**
   * Register action prompts for a message.
   *
   * Called after Primary Node successfully sends an interactive card.
   *
   * @param messageId - Card message ID (or synthetic ID)
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
    logger.debug(
      { messageId, chatId, actions: Object.keys(actionPrompts) },
      'Action prompts registered'
    );
  }

  /**
   * Get action prompts for a message.
   *
   * @param messageId - Card message ID
   * @returns Action prompts or undefined if not found
   */
  get(messageId: string): ActionPromptMap | undefined {
    const context = this.contexts.get(messageId);
    return context?.actionPrompts;
  }

  /**
   * Remove action prompts for a message.
   *
   * @param messageId - Card message ID
   * @returns Whether the context was found and removed
   */
  unregister(messageId: string): boolean {
    const removed = this.contexts.delete(messageId);
    if (removed) {
      logger.debug({ messageId }, 'Action prompts unregistered');
    }
    return removed;
  }

  /**
   * Generate a prompt from an interaction using the registered template.
   *
   * Supports placeholder replacement:
   * - `{{actionText}}` - Display text of the clicked button/option
   * - `{{actionValue}}` - Value of the action
   * - `{{actionType}}` - Type of action (button, select_static, etc.)
   * - `{{form.fieldName}}` - Form field values (for form submissions)
   *
   * @param messageId - Card message ID
   * @param actionValue - Action value from button/menu
   * @param actionText - Display text of the action (optional)
   * @param actionType - Type of action (optional)
   * @param formData - Form data if the action includes form inputs (optional)
   * @returns The generated prompt or undefined if no template found
   */
  generatePrompt(
    messageId: string,
    actionValue: string,
    actionText?: string,
    actionType?: string,
    formData?: Record<string, unknown>
  ): string | undefined {
    const prompts = this.get(messageId);
    if (!prompts) {
      return undefined;
    }

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

    if (formData) {
      for (const [key, value] of Object.entries(formData)) {
        const placeholder = new RegExp(`\\{\\{form\\.${key}\\}\\}`, 'g');
        prompt = prompt.replace(placeholder, String(value));
      }
    }

    return prompt;
  }

  /**
   * Cleanup expired interactive contexts.
   *
   * @param maxAge - Maximum age in milliseconds (default: 24 hours)
   * @returns Number of cleaned up contexts
   */
  cleanupExpired(maxAge: number = DEFAULT_MAX_AGE_MS): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [messageId, context] of this.contexts) {
      if (now - context.createdAt > maxAge) {
        this.contexts.delete(messageId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ count: cleaned }, 'Cleaned up expired interactive contexts');
    }

    return cleaned;
  }

  /**
   * Get the number of active contexts.
   */
  get size(): number {
    return this.contexts.size;
  }

  /**
   * Dispose the store and cleanup resources.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.contexts.clear();
    logger.debug('InteractiveContextStore disposed');
  }
}
