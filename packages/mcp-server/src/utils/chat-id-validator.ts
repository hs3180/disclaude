/**
 * Chat ID validation utilities for MCP tools.
 *
 * Validates chat IDs before they reach the platform API,
 * providing clear error messages for invalid formats.
 *
 * Issue #1641: Agent tool calls fail silently or with unclear errors.
 *
 * @module mcp-server/utils/chat-id-validator
 */

/**
 * Feishu chat ID patterns:
 * - Group chats: oc_<32 hex chars>
 * - P2P chats: oc_<32 hex chars> (same prefix in Feishu)
 */
const CHAT_ID_PATTERN = /^oc_[a-f0-9]{32}$/;

/**
 * Validate whether a chat ID has the correct format.
 *
 * @param chatId - The chat ID to validate
 * @returns true if the format is valid
 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId);
}

/**
 * Get a human-readable validation error for a chat ID.
 *
 * @param chatId - The chat ID to validate
 * @returns Error message string if invalid, null if valid
 */
export function getChatIdValidationError(chatId: string): string | null {
  if (!chatId) {
    return 'chatId is required';
  }
  if (typeof chatId !== 'string') {
    return `chatId must be a string, got ${typeof chatId}`;
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return `Invalid chatId format: "${chatId}" — expected oc_<32 hex chars> (e.g., oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6)`;
  }
  return null;
}
