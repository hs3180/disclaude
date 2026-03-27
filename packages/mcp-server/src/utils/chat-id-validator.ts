/**
 * chatId format validation utilities.
 *
 * Issue #1641: Validate chatId format before making IPC calls to prevent
 * confusing HTTP 400 errors from the Feishu API when invalid chatIds are used.
 *
 * @module mcp/utils/chat-id-validator
 */

/**
 * Feishu chat ID format: oc_ prefix followed by 32 hex characters.
 * Also supports ou_ (user), on_ (group), and other Feishu ID prefixes.
 */
const CHAT_ID_PATTERN = /^o[cpnu]_[a-zA-Z0-9]{32}$/;

/**
 * Check if a chatId has a valid Feishu format.
 *
 * @param chatId - The chat ID to validate
 * @returns true if the chatId matches a known Feishu ID format
 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId);
}

/**
 * Get a descriptive validation error for an invalid chatId.
 *
 * @param chatId - The chat ID that failed validation
 * @returns Error description string, or null if the chatId is valid
 */
export function getChatIdValidationError(chatId: unknown): string | null {
  if (!chatId || typeof chatId !== 'string') {
    return 'chatId is required and must be a non-empty string';
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return `Invalid chatId format: "${chatId}" — expected format: o[c|p|n|u]_<32 alphanumeric chars> (e.g., oc_a1b2c3d4...)`;
  }
  return null;
}
