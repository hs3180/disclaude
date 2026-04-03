/**
 * Chat ID validation utilities.
 *
 * Validates Feishu chat IDs to prevent invalid IDs from reaching the IPC layer,
 * which would result in unclear HTTP 400 errors from the Feishu API.
 *
 * Issue #1641: Add chatId format validation to MCP tools.
 *
 * @module mcp/utils/chat-id-validator
 */

/**
 * Feishu chat ID pattern: `oc_` prefix followed by 32 hex characters.
 * Also supports `ou_` prefix (user IDs) for edge cases like P2P chats.
 */
const CHAT_ID_PATTERN = /^o[uc]_[a-fA-F0-9]{32}$/;

/**
 * Check if a chatId has a valid Feishu format.
 *
 * @param chatId - The chat ID to validate
 * @returns true if the chatId matches the expected Feishu ID format
 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId);
}

/**
 * Get a descriptive validation error for an invalid chatId.
 *
 * Returns null if the chatId is valid.
 *
 * @param chatId - The chat ID to validate
 * @returns A human-readable error message, or null if valid
 */
export function getChatIdValidationError(chatId: unknown): string | null {
  if (!chatId || typeof chatId !== 'string') {
    return 'chatId is required and must be a non-empty string';
  }
  if (!chatId.startsWith('o')) {
    return `Invalid chatId format: "${chatId}" — expected Feishu ID (oc_ or ou_ prefix followed by 32 hex chars)`;
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return `Invalid chatId format: "${chatId}" — expected pattern oc_<32 hex chars> or ou_<32 hex chars>`;
  }
  return null;
}
