/**
 * Discussion End Trigger Detection.
 *
 * Detects trigger phrases in bot-sent messages that signal the end of a
 * discussion. When the Chat Agent determines a discussion has reached its
 * goal (or should be abandoned), it includes a trigger phrase in its response.
 * The message handler intercepts these triggers and dissolves the group via lark-cli.
 *
 * Issue #1229: feat: 智能会话结束 - 判断讨论何时可以关闭
 *
 * Supported trigger formats:
 *   [DISCUSSION_END]
 *   [DISCUSSION_END:timeout]
 *   [DISCUSSION_END:abandoned]
 *   [DISCUSSION_END:reason=custom reason]
 */

/** Result of a successful trigger detection. */
export interface DiscussionEndResult {
  /** The reason/mode extracted from the trigger (e.g., 'timeout', 'abandoned', ''). */
  reason: string;
  /** The full trigger match for logging purposes. */
  match: string;
}

/**
 * Pattern that matches discussion-end trigger phrases.
 *
 * Supported formats:
 *   [DISCUSSION_END]
 *   [DISCUSSION_END:timeout]
 *   [DISCUSSION_END:abandoned]
 *   [DISCUSSION_END:reason=some reason]
 *
 * Only matches text messages (message_type === 'text').
 */
const DISCUSSION_END_PATTERN = /\[DISCUSSION_END(?::([^\]]+))?\]/;

/**
 * Detect a discussion-end trigger phrase in message content.
 *
 * @param content - Raw message content string (JSON-encoded for text messages)
 * @param messageType - Feishu message type ('text', 'post', 'interactive', etc.)
 * @returns Detection result if a trigger is found, null otherwise
 *
 * @example
 * ```ts
 * // Text message with trigger
 * detectDiscussionEndTrigger('{"text":"讨论完成 [DISCUSSION_END]"}', 'text')
 * // => { reason: '', match: '[DISCUSSION_END]' }
 *
 * // Text message with reason
 * detectDiscussionEndTrigger('{"text":"[DISCUSSION_END:timeout] 超时结束"}', 'text')
 * // => { reason: 'timeout', match: '[DISCUSSION_END:timeout]' }
 *
 * // Non-text message — always returns null (per Issue #1229 review feedback)
 * detectDiscussionEndTrigger('{"text":"[DISCUSSION_END]"}', 'post')
 * // => null
 * ```
 */
export function detectDiscussionEndTrigger(
  content: string,
  messageType: string,
): DiscussionEndResult | null {
  // Only handle text messages per Issue #1229 review feedback on rejected PR #1449
  if (messageType !== 'text') {
    return null;
  }

  // Parse the JSON content to extract the text field
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = parsed.text ?? '';
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  const match = DISCUSSION_END_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  return {
    reason: (match[1] ?? '').trim(),
    match: match[0],
  };
}
