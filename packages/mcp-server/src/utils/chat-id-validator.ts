/**
 * Chat ID validation utilities for MCP tools.
 *
 * Validates chatId format before making IPC calls to prevent
 * confusing HTTP 400 errors from the Feishu API.
 *
 * @module mcp-server/utils/chat-id-validator
 * @see https://github.com/hs3180/disclaude/issues/1641
 */

/** Supported chatId prefix patterns */
const CHAT_ID_PATTERNS = [
  { prefix: 'oc_', label: 'Feishu group chat', minLength: 35 },
  { prefix: 'ou_', label: 'Feishu user (p2p chat)', minLength: 35 },
  { prefix: 'cli-', label: 'CLI session', minLength: 5 },
  { prefix: 'test-', label: 'Integration test session', minLength: 10 },
  { prefix: 'multimodal-test-', label: 'Multimodal integration test session', minLength: 20 },
] as const;

/**
 * Check whether a chatId string has a recognized format.
 *
 * @param chatId - The chatId to validate
 * @returns `true` if the chatId matches a known pattern
 */
export function isValidChatId(chatId: string): boolean {
  // Reject strings with leading/trailing whitespace
  if (chatId !== chatId.trim()) {
    return false;
  }
  return CHAT_ID_PATTERNS.some(({ prefix, minLength }) =>
    chatId.startsWith(prefix) && chatId.length >= minLength,
  );
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

  // Build a helpful message listing accepted formats
  const formatList = CHAT_ID_PATTERNS
    .map(({ prefix, label }) => `- \`${prefix}...\` (${label})`)
    .join('\n');

  return (
    `Invalid chatId format: "${chatId.length > 20 ? `${chatId.slice(0, 20)}...` : chatId}"\n` +
    `Expected one of the following formats:\n${formatList}`
  );
}
