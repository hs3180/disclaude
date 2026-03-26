/**
 * Chat ID validation utilities.
 *
 * Validates chatId format before making IPC/API calls to prevent
 * silent failures with stale or malformed IDs (e.g., after context compaction).
 *
 * Supported chatId prefixes:
 * - `oc_` — Feishu group chat
 * - `ou_` — Feishu private chat (user)
 * - `cli-` — CLI mode session
 *
 * @module mcp/utils/chat-id-validator
 */

/**
 * Known valid chatId prefixes.
 * REST channel chatIds may use other formats and pass through without format validation.
 */
const KNOWN_PREFIXES = ['oc_', 'ou_', 'cli-'] as const;

/**
 * Minimum length for a valid chatId (prefix + at least 1 character).
 */
const MIN_CHAT_ID_LENGTH = 4;

/**
 * Check if a chatId has a recognized format.
 *
 * @param chatId - The chatId to validate
 * @returns true if the chatId has a known prefix and minimum length
 */
export function isValidChatId(chatId: string): boolean {
  if (!chatId || typeof chatId !== 'string') return false;
  if (chatId.length < MIN_CHAT_ID_LENGTH) return false;
  return KNOWN_PREFIXES.some(prefix => chatId.startsWith(prefix));
}

/**
 * Get a detailed validation error message for an invalid chatId.
 *
 * Returns null if the chatId is valid.
 *
 * @param chatId - The chatId to validate
 * @returns Error message string, or null if valid
 */
export function getChatIdValidationError(chatId: unknown): string | null {
  if (!chatId) return 'chatId is required';
  if (typeof chatId !== 'string') return `chatId must be a string, got ${typeof chatId}`;
  if (chatId.length < MIN_CHAT_ID_LENGTH) {
    return `chatId is too short (${chatId.length} chars) — expected prefix + identifier (e.g., oc_xxx)`;
  }
  const hasKnownPrefix = KNOWN_PREFIXES.some(prefix => chatId.startsWith(prefix));
  if (!hasKnownPrefix) {
    return `Unrecognized chatId format: "${chatId}" — expected prefix: oc_ (group), ou_ (user), or cli- (CLI mode)`;
  }
  return null;
}
