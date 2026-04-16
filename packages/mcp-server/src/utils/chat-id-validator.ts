/**
 * Chat ID validation utilities for MCP tools.
 *
 * Validates chatId format before making IPC calls to prevent
 * confusing HTTP 400 errors from the Feishu API.
 *
 * @module mcp-server/utils/chat-id-validator
 * @see https://github.com/hs3180/disclaude/issues/1641
 */

/** A single chatId prefix pattern */
export interface ChatIdPattern {
  /** Prefix string (e.g. `oc_`, `cli-`) */
  prefix: string;
  /** Human-readable label for error messages */
  label: string;
  /** Minimum total length (including prefix) */
  minLength: number;
}

/** Built-in production chatId prefix patterns */
const DEFAULT_CHAT_ID_PATTERNS: readonly ChatIdPattern[] = [
  { prefix: 'oc_', label: 'Feishu group chat', minLength: 35 },
  { prefix: 'ou_', label: 'Feishu user (p2p chat)', minLength: 35 },
  { prefix: 'cli-', label: 'CLI session', minLength: 5 },
];

/** Runtime-extendable pattern list (defaults to production patterns only) */
let chatIdPatterns: ChatIdPattern[] = [...DEFAULT_CHAT_ID_PATTERNS];

/**
 * Register an additional chatId pattern at runtime.
 *
 * This allows test environments to extend the validator with test-specific
 * prefixes without polluting the production pattern list.
 *
 * @example
 * ```ts
 * import { registerChatIdPattern, resetChatIdPatterns } from './chat-id-validator.js';
 *
 * beforeAll(() => registerChatIdPattern({ prefix: 'test-', label: 'Test', minLength: 10 }));
 * afterAll(() => resetChatIdPatterns());
 * ```
 */
export function registerChatIdPattern(pattern: ChatIdPattern): void {
  chatIdPatterns = [...chatIdPatterns, pattern];
}

/**
 * Reset chatId patterns to the built-in production defaults.
 *
 * Call this in test teardown to avoid leaking patterns between test suites.
 */
export function resetChatIdPatterns(): void {
  chatIdPatterns = [...DEFAULT_CHAT_ID_PATTERNS];
}

/**
 * Return a snapshot of the currently registered chatId patterns.
 * Useful for assertions in tests.
 */
export function getChatIdPatterns(): readonly ChatIdPattern[] {
  return chatIdPatterns;
}

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
  return chatIdPatterns.some(({ prefix, minLength }) =>
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
  const formatList = chatIdPatterns
    .map(({ prefix, label }) => `- \`${prefix}...\` (${label})`)
    .join('\n');

  return (
    `Invalid chatId format: "${chatId.length > 20 ? `${chatId.slice(0, 20)}...` : chatId}"\n` +
    `Expected one of the following formats:\n${formatList}`
  );
}
