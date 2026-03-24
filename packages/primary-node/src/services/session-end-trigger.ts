/**
 * Session End Trigger Detection.
 *
 * Detects trigger phrases (e.g., `[DISCUSSION_END]`) in outgoing text messages.
 * When detected, the caller can strip the trigger, send the clean text,
 * and then dissolve the group chat.
 *
 * Issue #1229: Smart session end - trigger-based group dissolution.
 *
 * Design decisions (based on PR #1449 review feedback):
 * - Only handles text type messages (not cards/files/rich text)
 * - No separate session-records.md file
 * - No workspaceDir dependency
 */

import { createLogger } from '@disclaude/core';
import { dissolveChat } from '../platforms/feishu/chat-ops.js';
import { getGroupService } from '../platforms/feishu/group-service.js';
import type * as lark from '@larksuiteoapi/node-sdk';

const logger = createLogger('SessionEndTrigger');

/**
 * Trigger phrase pattern (non-global, for first-match detection with capture group).
 *
 * Matches:
 * - `[DISCUSSION_END]` → capture group 1: undefined → reason: 'end'
 * - `[DISCUSSION_END:timeout]` → capture group 1: 'timeout'
 * - `[DISCUSSION_END:abandoned]` → capture group 1: 'abandoned'
 */
const TRIGGER_PATTERN = /\[DISCUSSION_END(?::(\w+))?\]/;

/**
 * Result of trigger detection.
 */
export interface TriggerDetectionResult {
  /** Whether a trigger phrase was found in the text */
  triggered: boolean;
  /** The trigger reason: 'end' | 'timeout' | 'abandoned' | custom */
  reason: string;
  /** The text with all trigger phrases stripped and trimmed */
  cleanText: string;
}

/**
 * Detect session-end trigger phrases in message text.
 *
 * This is a pure function with no side effects, suitable for unit testing.
 *
 * @param text - The message text to scan
 * @returns Detection result with trigger status and cleaned text
 *
 * @example
 * detectTrigger('讨论完成了 [DISCUSSION_END]')
 * // => { triggered: true, reason: 'end', cleanText: '讨论完成了' }
 *
 * detectTrigger('超时了 [DISCUSSION_END:timeout]')
 * // => { triggered: true, reason: 'timeout', cleanText: '超时了' }
 *
 * detectTrigger('普通消息')
 * // => { triggered: false, reason: '', cleanText: '普通消息' }
 */
export function detectTrigger(text: string): TriggerDetectionResult {
  // Use non-global regex for first-match detection (avoids stateful lastIndex issues)
  const firstMatch = text.match(TRIGGER_PATTERN);

  if (!firstMatch) {
    return { triggered: false, reason: '', cleanText: text };
  }

  const reason = firstMatch[1] || 'end';

  // Use global regex for replacement (strip all occurrences)
  const globalPattern = new RegExp(TRIGGER_PATTERN.source, 'g');
  const cleanText = text
    .replace(globalPattern, '')
    .replace(/[ \t]+/g, ' ')   // Collapse multiple spaces/tabs to single space
    .replace(/^[ \t]|[ \t]$/gm, '')  // Remove leading/trailing spaces on each line
    .trim();

  return { triggered: true, reason, cleanText };
}

/**
 * Dissolve a group chat and unregister it from GroupService.
 *
 * This function is called after the trigger message has been sent.
 * It combines group dissolution (Feishu API) with registry cleanup.
 *
 * Errors are logged but not thrown, since the session end is a
 * best-effort cleanup operation — the trigger message has already
 * been delivered to the user.
 *
 * @param client - Feishu API client
 * @param chatId - The group chat ID to dissolve
 * @param reason - The trigger reason for logging purposes
 */
export async function dissolveGroupChat(
  client: lark.Client,
  chatId: string,
  reason: string
): Promise<void> {
  const groupService = getGroupService();

  try {
    // Unregister from local group registry
    const wasManaged = groupService.unregisterGroup(chatId);
    if (wasManaged) {
      logger.info({ chatId, reason }, 'Group unregistered from GroupService');
    }

    // Dissolve the group via Feishu API
    await dissolveChat(client, chatId);
    logger.info({ chatId, reason }, 'Group dissolved via session end trigger');
  } catch (error) {
    // Log but don't throw — the message was already sent successfully
    logger.error(
      { err: error, chatId, reason },
      'Failed to dissolve group during session end (message was already sent)'
    );
  }
}
