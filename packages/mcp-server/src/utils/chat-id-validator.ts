/**
 * Chat ID validation utilities.
 *
 * Validates chatId format before making IPC/API calls to provide
 * actionable error messages instead of cryptic HTTP errors.
 *
 * Issue #1641: Agent tool calls fail silently or with unclear errors.
 *
 * @module mcp-server/utils/chat-id-validator
 */

/**
 * General platform ID pattern.
 *
 * Matches common platform ID formats:
 * - Feishu: oc_<32 hex chars> (chat), ou_<32 hex chars> (user), on_<...> (bot)
 * - WeChat: similar prefix_identifier format
 * - Generic: 1-4 letter prefix + underscore + alphanumeric identifier
 *
 * This is intentionally lenient to support multiple platforms while
 * still catching obviously malformed IDs (random text, URLs, etc.).
 */
const CHAT_ID_PATTERN = /^[a-z]{1,4}_[a-zA-Z0-9_-]{5,64}$/;

/**
 * Check if a chatId has a valid platform format.
 *
 * @param chatId - The chatId to validate
 * @returns true if the chatId matches a recognized platform ID format
 */
export function isValidChatId(chatId: string): boolean {
  if (!chatId || typeof chatId !== 'string') return false;
  return CHAT_ID_PATTERN.test(chatId);
}

/**
 * Get a detailed validation error for an invalid chatId.
 *
 * @param chatId - The chatId to validate
 * @returns A human-readable error message, or null if the chatId is valid
 */
export function getChatIdValidationError(chatId: string): string | null {
  if (!chatId || typeof chatId !== 'string') {
    return 'chatId is required and must be a non-empty string';
  }

  if (chatId.trim() !== chatId) {
    return `Invalid chatId format: "${chatId}" — contains leading/trailing whitespace`;
  }

  if (chatId.includes(' ')) {
    return `Invalid chatId format: "${chatId}" — contains spaces`;
  }

  if (CHAT_ID_PATTERN.test(chatId)) {
    return null; // Valid
  }

  // Provide specific guidance based on common mistakes
  if (chatId.startsWith('http://') || chatId.startsWith('https://')) {
    return `Invalid chatId format: "${chatId}" — looks like a URL, expected a platform ID (e.g., oc_xxx)`;
  }

  if (!chatId.includes('_')) {
    return `Invalid chatId format: "${chatId}" — expected prefix_identifier format (e.g., oc_<id>)`;
  }

  const prefix = chatId.split('_')[0];
  if (prefix.length > 4 || !/^[a-z]+$/.test(prefix)) {
    return `Invalid chatId format: "${chatId}" — prefix "${prefix}" is too long or contains invalid characters`;
  }

  return `Invalid chatId format: "${chatId}" — expected format: <1-4 letter prefix>_<5-64 char identifier> (e.g., oc_xxx)`;
}
