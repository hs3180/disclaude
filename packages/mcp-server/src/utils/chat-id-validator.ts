/**
 * Chat ID validation utilities.
 *
 * Validates chatId format before making IPC/API calls,
 * providing clear error messages to help AI agents diagnose issues early.
 *
 * Issue #1641: Prevents invalid chatIds from passing through to the API
 * and causing confusing HTTP 400 errors.
 *
 * @module mcp/utils/chat-id-validator
 */

/**
 * Feishu/Lark open chat ID pattern: oc_ prefix followed by 32 hex characters.
 * Also supports ou_ (user) and on_ (notification group) prefixes.
 */
const CHAT_ID_PATTERNS = [
  /^oc_[a-f0-9]{32}$/,  // Open chat (群聊)
  /^ou_[a-f0-9]{32}$/,  // User (单聊/p2p)
  /^on_[a-f0-9]{32}$/,  // Notification group (通知群)
];

/**
 * Check if a chatId has a valid platform format.
 *
 * @param chatId - The chat ID to validate
 * @returns true if the chatId matches a known platform ID pattern
 */
export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_PATTERNS.some(pattern => pattern.test(chatId));
}

/**
 * Get a descriptive validation error for an invalid chatId.
 *
 * @param chatId - The chat ID to validate
 * @returns A human-readable error message, or null if the chatId is valid
 */
export function getChatIdValidationError(chatId: string): string | null {
  if (!chatId || typeof chatId !== 'string' || chatId.trim().length === 0) {
    return 'chatId is required and must be a non-empty string';
  }

  const trimmed = chatId.trim();

  // Check prefix
  const hasPrefix = /^(oc|ou|on)_/.test(trimmed);
  if (!hasPrefix) {
    return `Invalid chatId format: "${trimmed}" — expected platform ID (oc_xxx, ou_xxx, or on_xxx prefix)`;
  }

  // Check length (prefix + 32 hex chars)
  if (trimmed.length !== 35) {
    return `Invalid chatId length: "${trimmed}" — expected 35 characters (prefix + 32 hex chars), got ${trimmed.length}`;
  }

  // Check hex characters after prefix
  const hexPart = trimmed.substring(3);
  if (!/^[a-f0-9]{32}$/.test(hexPart)) {
    return `Invalid chatId format: "${trimmed}" — characters after prefix must be lowercase hex (0-9, a-f), got "${hexPart}"`;
  }

  // Should not reach here if patterns are comprehensive
  return null;
}
