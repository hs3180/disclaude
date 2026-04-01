/**
 * chatId format validation utilities.
 *
 * Issue #1641: Validate chatId before IPC calls to provide clear, actionable errors
 * instead of letting invalid IDs pass through to the platform API (HTTP 400).
 *
 * @module mcp-server/utils/chatid-validator
 */

/**
 * Known chatId format patterns.
 *
 * - Feishu: oc_xxx (group), ou_xxx (user), on_xxx (bot)
 * - CLI: cli-xxx
 * - REST: UUID format
 */
export const CHAT_ID_PATTERNS = [
  { name: 'Feishu', pattern: /^(oc_|ou_|on_)/ },
  { name: 'CLI', pattern: /^cli-/ },
  { name: 'REST', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
] as const;

/**
 * Validate chatId format against known patterns.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateChatId(chatId: string): string | null {
  if (!chatId || typeof chatId !== 'string') {
    return 'chatId must be a non-empty string';
  }
  for (const { pattern } of CHAT_ID_PATTERNS) {
    if (pattern.test(chatId)) {
      return null; // valid
    }
  }
  return `Invalid chatId format: "${chatId}". Expected format: oc_xxx (Feishu group), ou_xxx (user), on_xxx (bot), cli-xxx (CLI), or UUID (REST)`;
}
