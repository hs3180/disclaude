/**
 * chatId format validation utilities.
 *
 * Validates that chatId follows the expected Feishu/Lark chat ID format
 * (oc_ prefix followed by 32 hex characters) before making IPC calls.
 *
 * Issue #1641: Prevents invalid chatIds from reaching the Feishu API,
 * which would return unhelpful HTTP 400 errors.
 *
 * @module mcp/utils/chat-id-validator
 */

/**
 * Feishu/Lark chat ID format: oc_ prefix + 32 lowercase hex characters.
 * Example: oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
 */
const CHAT_ID_PATTERN = /^oc_[a-f0-9]{32}$/;

/**
 * Check if a chatId string matches the expected Feishu/Lark format.
 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId);
}

/**
 * Get a validation error message for an invalid chatId.
 * Returns null if the chatId is valid.
 *
 * @param chatId - The chatId to validate
 * @returns Error message string if invalid, null if valid
 */
export function getChatIdValidationError(chatId: string): string | null {
  if (typeof chatId !== 'string') {
    return 'chatId is required';
  }
  if (chatId.length === 0) {
    return 'chatId must be a non-empty string';
  }
  if (!chatId.startsWith('oc_')) {
    return `Invalid chatId format: "${chatId}" — expected "oc_" prefix (Feishu/Lark chat ID)`;
  }
  if (chatId.length !== 35) {
    return `Invalid chatId length: got ${chatId.length} chars, expected 35 (oc_ + 32 hex chars)`;
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return `Invalid chatId format: "${chatId}" — expected oc_<32 hex chars>`;
  }
  return null;
}
