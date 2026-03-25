/**
 * Chat ID validation utilities.
 *
 * Validates chatId format across supported channels:
 * - Feishu: `oc_` (group chat) or `ou_` (private chat) prefix
 * - CLI: `cli-` prefix
 * - REST: any non-empty string (no specific format)
 *
 * @module mcp/utils/chat-id-validator
 */

/**
 * Known channel prefix patterns and their expected formats.
 */
const CHANNEL_PATTERNS = {
  /** Feishu group chat: oc_ followed by alphanumeric/hex chars */
  feishuGroup: /^oc_[a-zA-Z0-9_-]+$/,
  /** Feishu private chat: ou_ followed by alphanumeric/hex chars */
  feishuPrivate: /^ou_[a-zA-Z0-9_-]+$/,
  /** CLI channel: cli- followed by any chars */
  cli: /^cli-.+/,
} as const;

/**
 * Check if a chatId matches a known channel format.
 *
 * @param chatId - Chat ID to validate
 * @returns true if the chatId has a recognized channel format
 */
export function isValidChatId(chatId: string): boolean {
  if (!chatId || typeof chatId !== 'string') {
    return false;
  }

  // Any non-empty string is technically valid (REST channel accepts anything)
  // But we check if known prefixes have proper format
  if (chatId.startsWith('oc_') || chatId.startsWith('ou_')) {
    return CHANNEL_PATTERNS.feishuGroup.test(chatId) ||
           CHANNEL_PATTERNS.feishuPrivate.test(chatId);
  }

  if (chatId.startsWith('cli-')) {
    return CHANNEL_PATTERNS.cli.test(chatId);
  }

  // REST channel: any non-empty string is valid
  return chatId.length > 0;
}

/**
 * Get a detailed validation error for an invalid chatId.
 *
 * Returns null if the chatId is valid.
 *
 * @param chatId - Chat ID to validate
 * @returns Error description string, or null if valid
 */
export function getChatIdValidationError(chatId: unknown): string | null {
  if (chatId === null || chatId === undefined) {
    return 'chatId is required';
  }
  if (typeof chatId !== 'string') {
    return `chatId must be a string, got ${typeof chatId}`;
  }
  if (chatId.length === 0) {
    return 'chatId must be a non-empty string';
  }

  // Check known prefix formats
  if (chatId.startsWith('oc_')) {
    if (chatId.length <= 3) {
      return 'Invalid Feishu group chatId: "oc_" prefix must be followed by identifier characters (e.g., "oc_abc123...")';
    }
    if (!CHANNEL_PATTERNS.feishuGroup.test(chatId)) {
      return `Invalid Feishu group chatId format: "${chatId}" — expected "oc_" followed by alphanumeric characters`;
    }
  }

  if (chatId.startsWith('ou_')) {
    if (chatId.length <= 3) {
      return 'Invalid Feishu private chatId: "ou_" prefix must be followed by identifier characters (e.g., "ou_abc123...")';
    }
    if (!CHANNEL_PATTERNS.feishuPrivate.test(chatId)) {
      return `Invalid Feishu private chatId format: "${chatId}" — expected "ou_" followed by alphanumeric characters`;
    }
  }

  if (chatId.startsWith('cli-')) {
    if (chatId.length <= 4) {
      return 'Invalid CLI chatId: "cli-" prefix must be followed by identifier characters';
    }
    if (!CHANNEL_PATTERNS.cli.test(chatId)) {
      return `Invalid CLI chatId format: "${chatId}" — expected "cli-" followed by identifier characters`;
    }
  }

  return null;
}
