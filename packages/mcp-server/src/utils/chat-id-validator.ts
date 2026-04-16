/**
 * Chat ID validation utilities for MCP tools.
 *
 * Validates chatId format before making IPC calls to prevent
 * confusing HTTP 400 errors from the Feishu API.
 *
 * Validation is format-based (not prefix-whitelist-based) to avoid
 * coupling production code to specific chatId naming conventions.
 *
 * @module mcp-server/utils/chat-id-validator
 * @see https://github.com/hs3180/disclaude/issues/1641
 * @see https://github.com/hs3180/disclaude/issues/2389
 */

/** Minimum allowed chatId length */
const MIN_CHAT_ID_LENGTH = 3;

/**
 * Check whether a chatId string has a valid format.
 *
 * Uses format-based validation instead of prefix whitelisting,
 * so test-specific or future chatId formats are naturally accepted.
 *
 * @param chatId - The chatId to validate
 * @returns `true` if the chatId has a valid format
 */
export function isValidChatId(chatId: string): boolean {
  // Reject strings with leading/trailing whitespace
  if (chatId !== chatId.trim()) {
    return false;
  }
  return chatId.length >= MIN_CHAT_ID_LENGTH;
}

/**
 * Return a human-readable validation error, or `null` when the chatId is valid.
 *
 * @param chatId - The chatId to validate
 * @returns A descriptive error string, or `null` if valid
 */
export function getChatIdValidationError(chatId: string): string | null {
  if (!chatId || typeof chatId !== 'string') {
    return 'chatId is required and must be a non-empty string';
  }

  if (isValidChatId(chatId)) {
    return null;
  }

  return (
    `Invalid chatId format: "${chatId.length > 20 ? `${chatId.slice(0, 20)}...` : chatId}" — ` +
    `must be a non-empty string with at least ${MIN_CHAT_ID_LENGTH} characters, no leading/trailing whitespace`
  );
}
