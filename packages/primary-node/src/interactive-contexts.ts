/**
 * Interactive context management for Primary Node.
 *
 * Manages action prompt contexts for interactive messages (cards).
 * When the MCP Server sends an interactive card, it registers the
 * associated action prompts here via IPC. The Primary Node stores
 * them and handles lookups when card interactions occur.
 *
 * Phase 3 of Issue #1568: Moved from MCP Server to Primary Node
 * so that interactive context state lives in a single, long-lived process.
 *
 * @module primary-node/interactive-contexts
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('InteractiveContexts');

/**
 * Map of action values to prompt templates.
 * Keys are action values from button/menu components.
 * Values are prompt templates that can include placeholders:
 * - {{actionText}} - The display text of the clicked button/option
 * - {{actionValue}} - The value of the action
 * - {{actionType}} - The type of action (button, select_static, etc.)
 * - {{form.fieldName}} - Form field values (for form submissions)
 */
export type ActionPromptMap = Record<string, string>;

/**
 * Context for an interactive message.
 */
export interface InteractiveMessageContext {
  /** The message ID of the sent interactive card */
  messageId: string;
  /** The chat ID where the card was sent */
  chatId: string;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** Timestamp when this context was created */
  createdAt: number;
}

/**
 * Store for interactive message contexts.
 * Maps message ID to its action prompts.
 */
const interactiveContexts = new Map<string, InteractiveMessageContext>();

/**
 * Register action prompts for a message.
 * Called by MCP Server via IPC after successfully sending an interactive card.
 */
export function registerActionPrompts(
  messageId: string,
  chatId: string,
  actionPrompts: ActionPromptMap
): void {
  interactiveContexts.set(messageId, {
    messageId,
    chatId,
    actionPrompts,
    createdAt: Date.now(),
  });
  logger.debug({ messageId, chatId, actions: Object.keys(actionPrompts) }, 'Action prompts registered');
}

/**
 * Get action prompts for a message.
 * Returns undefined if no prompts are registered.
 */
export function getActionPrompts(messageId: string): ActionPromptMap | undefined {
  const context = interactiveContexts.get(messageId);
  return context?.actionPrompts;
}

/**
 * Remove action prompts for a message.
 */
export function unregisterActionPrompts(messageId: string): boolean {
  const removed = interactiveContexts.delete(messageId);
  if (removed) {
    logger.debug({ messageId }, 'Action prompts unregistered');
  }
  return removed;
}

/**
 * Generate a prompt from an interaction using the registered template.
 *
 * @param messageId - The card message ID
 * @param actionValue - The action value from the button/menu
 * @param actionText - The display text of the action (optional)
 * @param actionType - The type of action (button, select_static, etc.)
 * @param formData - Form data if the action includes form inputs
 * @returns The generated prompt or undefined if no template found
 */
export function generateInteractionPrompt(
  messageId: string,
  actionValue: string,
  actionText?: string,
  actionType?: string,
  formData?: Record<string, unknown>
): string | undefined {
  const prompts = getActionPrompts(messageId);
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

  // Replace {{actionText}} placeholder
  if (actionText) {
    prompt = prompt.replace(/\{\{actionText\}\}/g, actionText);
  }

  // Replace {{actionValue}} placeholder
  prompt = prompt.replace(/\{\{actionValue\}\}/g, actionValue);

  // Replace {{actionType}} placeholder
  if (actionType) {
    prompt = prompt.replace(/\{\{actionType\}\}/g, actionType);
  }

  // Replace form data placeholders
  if (formData) {
    for (const [key, value] of Object.entries(formData)) {
      const placeholder = new RegExp(`\\{\\{form\\.${key}\\}\\}`, 'g');
      prompt = prompt.replace(placeholder, String(value));
    }
  }

  return prompt;
}

/**
 * Cleanup expired interactive contexts (older than 24 hours).
 */
export function cleanupExpiredContexts(): number {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  let cleaned = 0;

  for (const [messageId, context] of interactiveContexts) {
    if (now - context.createdAt > maxAge) {
      interactiveContexts.delete(messageId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug({ count: cleaned }, 'Cleaned up expired interactive contexts');
  }

  return cleaned;
}
