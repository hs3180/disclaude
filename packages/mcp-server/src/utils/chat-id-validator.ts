/**
 * Chat ID validation utilities.
 *
 * Validates chatId format to provide clear, actionable error messages
 * before sending requests to IPC/Feishu API.
 *
 * Supported patterns:
 * - Feishu group chat: oc_<32 hex chars>
 * - Feishu private chat: ou_<32 hex chars>
 * - CLI mode: cli-<identifier>
 *
 * @module mcp-server/utils/chat-id-validator
 * @see https://github.com/hs3180/disclaude/issues/1641 (Scenario 1)
 */

/**
 * Valid chatId prefix patterns.
 * - oc_: Feishu group chat
 * - ou_: Feishu user (private chat / bot)
 * - cli-: CLI mode
 */
const CHAT_ID_PATTERNS: Array<{ prefix: string; description: string; pattern: RegExp }> = [
  {
    prefix: 'oc_',
    description: 'Feishu group chat',
    pattern: /^oc_[a-f0-9]{32}$/,
  },
  {
    prefix: 'ou_',
    description: 'Feishu user/private chat',
    pattern: /^ou_[a-f0-9]{32}$/,
  },
  {
    prefix: 'cli-',
    description: 'CLI mode',
    pattern: /^cli-.+$/,
  },
];

/**
 * Check if a chatId has a valid format.
 *
 * @param chatId - The chat ID to validate
 * @returns true if the chatId matches a known format
 */
export function isValidChatId(chatId: string): boolean {
  if (!chatId || typeof chatId !== 'string') {
    return false;
  }
  return CHAT_ID_PATTERNS.some(({ pattern }) => pattern.test(chatId));
}

/**
 * Get a detailed validation error for an invalid chatId.
 *
 * Returns null if the chatId is valid.
 *
 * @param chatId - The chat ID to validate
 * @returns Error description string, or null if valid
 */
export function getChatIdValidationError(chatId: unknown): string | null {
  if (!chatId || typeof chatId !== 'string') {
    return 'chatId is required and must be a non-empty string';
  }

  const trimmed = chatId.trim();
  if (trimmed === '') {
    return 'chatId must not be empty or whitespace-only';
  }

  // Check against known patterns
  const matchedPattern = CHAT_ID_PATTERNS.find(({ pattern }) => pattern.test(trimmed));
  if (matchedPattern) {
    return null; // Valid
  }

  // Identify the likely intended prefix
  if (trimmed.startsWith('oc_')) {
    return `Invalid chatId format: "${trimmed}" — expected oc_<32 hex chars>, got ${trimmed.length - 3} chars after "oc_" prefix`;
  }
  if (trimmed.startsWith('ou_')) {
    return `Invalid chatId format: "${trimmed}" — expected ou_<32 hex chars>, got ${trimmed.length - 3} chars after "ou_" prefix`;
  }
  if (trimmed.startsWith('cli-')) {
    return `Invalid chatId format: "${trimmed}" — expected cli-<identifier>, identifier must not be empty`;
  }

  // Unknown prefix
  return `Invalid chatId format: "${trimmed}" — must start with oc_ (Feishu group), ou_ (Feishu user), or cli- (CLI mode)`;
}
