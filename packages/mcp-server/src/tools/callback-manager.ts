/**
 * Callback manager for MCP tools.
 *
 * Centralized management of message sent callbacks.
 * This allows multiple tools to share the same callback mechanism.
 *
 * @module mcp-server/tools/callback-manager
 */

import { createLogger } from '@disclaude/core';
import type { MessageSentCallback } from './types.js';

const logger = createLogger('CallbackManager');

let messageSentCallback: MessageSentCallback | null = null;

/**
 * Set the message sent callback.
 * Pass null to clear the callback.
 */
export function setMessageSentCallback(callback: MessageSentCallback | null): void {
  messageSentCallback = callback;
}

/**
 * Get the current message sent callback.
 */
export function getMessageSentCallback(): MessageSentCallback | null {
  return messageSentCallback;
}

/**
 * Invoke the message sent callback if one is registered.
 * Logs errors but does not throw.
 */
export function invokeMessageSentCallback(chatId: string): void {
  if (messageSentCallback) {
    try {
      messageSentCallback(chatId);
    } catch (error) {
      logger.error({ err: error }, 'Failed to invoke message sent callback');
    }
  }
}
