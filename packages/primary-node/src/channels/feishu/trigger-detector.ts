/**
 * Trigger Phrase Detector.
 *
 * Detects discussion-end trigger phrases in outgoing text messages.
 * When the Chat Agent determines a discussion has concluded, it embeds
 * a trigger phrase (e.g., [DISCUSSION_END]) in its message. This module
 * detects the trigger, strips it, and returns the clean text + metadata.
 *
 * Issue #1229: Smart session end via trigger phrase detection
 *
 * Design:
 * - Text messages only (no rich text/card support needed)
 * - No file system writes (no session records)
 * - Lightweight regex-based detection following MentionDetector pattern
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerDetector');

/** Supported trigger reasons */
export type TriggerReason = 'normal' | 'timeout' | 'abandoned';

/** Result of trigger detection */
export interface TriggerDetectionResult {
  /** Whether a trigger phrase was detected */
  detected: boolean;
  /** The clean text with trigger stripped */
  cleanText: string;
  /** Reason for triggering (if detected) */
  reason?: TriggerReason;
  /** Optional summary extracted from trigger */
  summary?: string;
}

/** Trigger phrase pattern: [DISCUSSION_END] or [DISCUSSION_END:reason] or [DISCUSSION_END:reason=summary] */
const TRIGGER_PATTERN = /\[DISCUSSION_END(?::([a-z_]+)(?:=(.+?))?)?\]/i;

/**
 * Normalize whitespace in text after trigger removal.
 * Collapses multiple spaces into one and trims.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').trim();
}

/** Valid trigger reasons */
const VALID_REASONS: Record<string, TriggerReason> = {
  timeout: 'timeout',
  abandoned: 'abandoned',
  normal: 'normal',
};

/**
 * Detect and strip trigger phrases from text.
 *
 * Supports the following formats:
 * - `[DISCUSSION_END]` → normal end
 * - `[DISCUSSION_END:timeout]` → timeout end
 * - `[DISCUSSION_END:abandoned]` → abandoned end
 * - `[DISCUSSION_END:summary=Some text here]` → end with summary
 *
 * The trigger can appear anywhere in the message (typically at the end).
 * Multiple triggers in the same message: only the first one is processed.
 *
 * @param text - The outgoing message text to check
 * @returns Detection result with clean text and metadata
 */
export function detectAndStripTrigger(text: string): TriggerDetectionResult {
  if (!text) {
    return { detected: false, cleanText: text };
  }

  const match = text.match(TRIGGER_PATTERN);
  if (!match) {
    return { detected: false, cleanText: text };
  }

  const reasonStr = (match[1] || 'normal').toLowerCase();
  const summaryOrReason = match[2];

  // If format is [DISCUSSION_END:summary=xxx], extract summary
  if (reasonStr === 'summary' && summaryOrReason) {
    const cleanText = normalizeWhitespace(text.replace(match[0], ''));
    logger.info(
      { reason: 'normal', summary: summaryOrReason },
      'Discussion end trigger detected (with summary)'
    );
    return {
      detected: true,
      cleanText,
      reason: 'normal',
      summary: summaryOrReason,
    };
  }

  // If format is [DISCUSSION_END:reason] or [DISCUSSION_END]
  const reason = VALID_REASONS[reasonStr] || 'normal';
  const cleanText = normalizeWhitespace(text.replace(match[0], ''));

  logger.info({ reason }, 'Discussion end trigger detected');

  return {
    detected: true,
    cleanText,
    reason,
  };
}

/**
 * Check if text contains a trigger phrase without stripping.
 *
 * @param text - The text to check
 * @returns Whether a trigger phrase is present
 */
export function hasTrigger(text: string): boolean {
  if (!text) return false;
  return TRIGGER_PATTERN.test(text);
}
