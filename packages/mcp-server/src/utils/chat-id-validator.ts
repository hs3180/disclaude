/**
 * Chat ID validation utilities.
 *
 * Validates Feishu chat ID format to prevent invalid IDs from
 * reaching the IPC layer and causing unclear HTTP 400 errors.
 *
 * Issue #1641: Agent tool calls fail silently or with unclear errors.
 *
 * @module mcp/utils/chat-id-validator
 */

/**
 * Feishu chat ID pattern: oc_ prefix followed by 32 hex characters.
 * Example: oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
 */
const CHAT_ID_PATTERN = /^oc_[a-f0-9]{32}$/;

/**
 * Check if a chatId matches the expected Feishu format.
 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId);
}

/**
 * Get a validation error message for an invalid chatId.
 * Returns null if the chatId is valid.
 */
export function getChatIdValidationError(chatId: string): string | null {
  if (!chatId) {
    return 'chatId is required';
  }
  if (typeof chatId !== 'string') {
    return `chatId must be a string, got ${typeof chatId}`;
  }
  if (!chatId.startsWith('oc_')) {
    return `Invalid chatId format: "${chatId}" — expected "oc_" prefix (Feishu chat ID)`;
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return `Invalid chatId format: "${chatId}" — expected "oc_" followed by 32 hex characters`;
  }
  return null;
}
