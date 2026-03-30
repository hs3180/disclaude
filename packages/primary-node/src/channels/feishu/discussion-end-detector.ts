/**
 * Discussion End Trigger Detector.
 *
 * Detects trigger phrases in outgoing text messages that signal
 * a discussion should be ended and the group chat dissolved.
 *
 * Issue #1229: Smart session end via trigger phrases.
 *
 * Supported trigger formats:
 *   [DISCUSSION_END]
 *   [DISCUSSION_END:timeout]
 *   [DISCUSSION_END:abandoned]
 *   [DISCUSSION_END:summary=some text here]
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('DiscussionEndDetector');

/** Trigger phrase pattern (non-global, for detection + reason extraction) */
const TRIGGER_PATTERN = /\[DISCUSSION_END(?::([^\]]*))?\]/;

/** Global trigger pattern (for replacing all occurrences) */
const TRIGGER_GLOBAL = /\[DISCUSSION_END(?:[^\]]*)\]/g;

/** Result of trigger detection */
export interface DiscussionEndResult {
  /** Whether a trigger was detected */
  detected: boolean;
  /** The text with the trigger stripped out */
  cleanText: string;
  /** The reason extracted from the trigger (e.g., "timeout", "abandoned", "summary=...") */
  reason: string | undefined;
}

/**
 * Detect and strip discussion end trigger phrases from text.
 *
 * @param text - The message text to scan
 * @returns Detection result with clean text and optional reason
 */
export function detectAndStripDiscussionEnd(text: string): DiscussionEndResult {
  const match = TRIGGER_PATTERN.exec(text);
  if (!match) {
    return { detected: false, cleanText: text, reason: undefined };
  }

  const reason = match[1] || undefined;
  const cleanText = text.replace(TRIGGER_GLOBAL, '').trim();

  logger.info(
    { reason: reason ?? 'normal' },
    'Discussion end trigger detected',
  );

  return { detected: true, cleanText, reason };
}
