/**
 * Discussion End Detection and Handling.
 *
 * Detects trigger phrases (e.g., `[DISCUSSION_END]`) in outgoing messages,
 * sends a formatted summary card, and dissolves the group chat.
 *
 * Trigger phrase format:
 * - `[DISCUSSION_END]` — normal end
 * - `[DISCUSSION_END:timeout]` — timeout end
 * - `[DISCUSSION_END:abandoned]` — abandoned discussion
 * - `[DISCUSSION_END:summary=xxx]` — end with custom summary
 *
 * @see Issue #1229 - Smart discussion ending
 */

import { createLogger } from '@disclaude/core';
import { dissolveChat } from '../../platforms/feishu/chat-ops.js';

const logger = createLogger('DiscussionEnd');

/**
 * Parsed result from a trigger phrase.
 */
export interface DiscussionEndResult {
  /** Whether a trigger phrase was detected */
  detected: true;
  /** End reason: 'normal', 'timeout', 'abandoned', or 'custom' */
  reason: string;
  /** Optional custom summary text */
  summary?: string;
  /** The raw trigger phrase (for logging) */
  rawPhrase: string;
}

/**
 * Result when no trigger phrase is detected.
 */
export interface NoDiscussionEnd {
  detected: false;
}

/**
 * Union type for detection results.
 */
export type DiscussionEndDetection = DiscussionEndResult | NoDiscussionEnd;

/**
 * Regex to match discussion end trigger phrases.
 *
 * Supported formats:
 * - `[DISCUSSION_END]`
 * - `[DISCUSSION_END:timeout]`
 * - `[DISCUSSION_END:abandoned]`
 * - `[DISCUSSION_END:summary=some text here]`
 *
 * The regex captures:
 *   Group 1: reason keyword (timeout, abandoned, or summary=...)
 *   Group 2: summary text (if reason is "summary")
 */
const TRIGGER_PATTERN = /\[DISCUSSION_END(?::((?:timeout|abandoned)|summary=(.*?)))?\]/g;

/**
 * Human-readable labels for end reasons.
 */
const REASON_LABELS: Record<string, string> = {
  normal: '讨论结束',
  timeout: '讨论超时',
  abandoned: '讨论已放弃',
  custom: '讨论结束',
};

/**
 * Detect a discussion end trigger phrase in message text.
 *
 * Searches for `[DISCUSSION_END...]` patterns and returns the first match.
 * Returns `{ detected: false }` if no trigger phrase is found.
 *
 * @param text - The message text to scan
 * @returns Detection result
 */
export function detectDiscussionEnd(text: string): DiscussionEndDetection {
  TRIGGER_PATTERN.lastIndex = 0;
  const match = TRIGGER_PATTERN.exec(text);

  if (!match) {
    return { detected: false };
  }

  const rawPhrase = match[0];
  const modifier = match[1]; // e.g., "timeout", "abandoned", or "summary=some text"

  if (!modifier) {
    return { detected: true, reason: 'normal', rawPhrase };
  }

  if (modifier === 'timeout') {
    return { detected: true, reason: 'timeout', rawPhrase };
  }

  if (modifier === 'abandoned') {
    return { detected: true, reason: 'abandoned', rawPhrase };
  }

  // modifier starts with "summary=" — extract the summary text
  const summaryMatch = match[2]; // captured inside summary=(...)
  if (summaryMatch !== undefined) {
    return {
      detected: true,
      reason: 'custom',
      summary: summaryMatch.trim(),
      rawPhrase,
    };
  }

  // Fallback for unknown modifiers
  return { detected: true, reason: 'normal', rawPhrase };
}

/**
 * Strip all trigger phrases from message text.
 *
 * @param text - The message text containing potential trigger phrases
 * @returns Cleaned text with trigger phrases removed
 */
export function stripTriggerPhrases(text: string): string {
  TRIGGER_PATTERN.lastIndex = 0;
  return text.replace(TRIGGER_PATTERN, '').trim();
}

/**
 * Build a Feishu interactive card for the discussion end summary.
 *
 * @param result - The detection result
 * @param remainingText - Any remaining text after stripping the trigger phrase
 * @returns Card JSON structure for Feishu
 */
export function buildEndCard(
  result: DiscussionEndResult,
  remainingText?: string,
): Record<string, unknown> {
  const reasonLabel = REASON_LABELS[result.reason] || REASON_LABELS.normal;
  const summaryContent = result.summary || remainingText || '讨论已完成，群聊即将解散。';

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: `**${reasonLabel}**`,
    },
    {
      tag: 'hr',
    },
    {
      tag: 'markdown',
      content: summaryContent,
    },
    {
      tag: 'hr',
    },
    {
      tag: 'markdown',
      content: '_🤖 群聊将在发送后自动解散_',
    },
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📋 讨论总结' },
      template: 'purple',
    },
    elements,
  };
}

/**
 * Options for handling discussion end.
 */
export interface DiscussionEndOptions {
  /** Feishu API client (lark.Client) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  /** Chat ID to dissolve */
  chatId: string;
  /** Detection result */
  detection: DiscussionEndResult;
  /** Remaining text after stripping trigger phrase */
  remainingText?: string;
  /** Optional delay before dissolving (ms, default: 3000) */
  dissolveDelayMs?: number;
}

/**
 * Handle a detected discussion end:
 * 1. Send a summary card
 * 2. Wait briefly (so users see the card)
 * 3. Dissolve the group chat
 *
 * @param options - Handling options
 */
export async function handleDiscussionEnd(options: DiscussionEndOptions): Promise<void> {
  const { client, chatId, detection, remainingText, dissolveDelayMs = 3000 } = options;

  logger.info(
    { chatId, reason: detection.reason, hasSummary: !!detection.summary },
    'Discussion end detected, sending summary card and dissolving group',
  );

  // Step 1: Send summary card
  const card = buildEndCard(detection, remainingText);
  try {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    logger.info({ chatId }, 'Summary card sent');
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to send summary card');
    // Continue with dissolution even if card fails
  }

  // Step 2: Wait before dissolving so users can see the card
  await new Promise((resolve) => setTimeout(resolve, dissolveDelayMs));

  // Step 3: Dissolve the group
  try {
    await dissolveChat(client as Parameters<typeof dissolveChat>[0], chatId);
    logger.info({ chatId }, 'Group dissolved after discussion end');
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to dissolve group after discussion end');
    throw err;
  }
}
