/**
 * Chat ID validation utilities.
 *
 * Validates chatId format before making IPC calls to prevent unclear errors
 * (e.g., HTTP 400 from Feishu API with no actionable feedback).
 *
 * @module mcp/utils/chat-id-validator
 * @see https://github.com/hs3180/disclaude/issues/1641
 */

/**
 * Pattern for Feishu/Lark open chat IDs: `oc_` prefix followed by hex chars.
 * Minimum 16 hex chars to catch obviously invalid IDs while remaining flexible.
 */
const CHAT_ID_PATTERN = /^oc_[a-f0-9]{16,}$/;

/**
 * Check if a chatId has a valid format.
 *
 * @param chatId - The chat ID to validate
 * @returns true if the chatId matches the expected format
 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId);
}

/**
 * Get a validation error message for an invalid chatId.
 *
 * Returns null if the chatId is valid, or a descriptive error string
 * explaining what's wrong.
 *
 * @param chatId - The chat ID to validate
 * @returns Error message string, or null if valid
 */
export function getChatIdValidationError(chatId: string): string | null {
  if (!chatId || typeof chatId !== 'string') {
    return 'chatId is required and must be a non-empty string';
  }
  if (!chatId.startsWith('oc_')) {
    return `Invalid chatId: "${chatId}" — must start with "oc_" prefix (Feishu open chat ID)`;
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return `Invalid chatId: "${chatId}" — must match pattern oc_<16+ hex chars>`;
  }
  return null;
}
