/**
 * Trigger Phrase Detector for Smart Session End.
 *
 * Detects trigger phrases in outgoing text messages that signal
 * the Chat Agent wants to end the discussion and dissolve the group.
 *
 * Trigger format: [DISCUSSION_END] or [DISCUSSION_END:reason]
 * Supported reasons: timeout, abandoned, or custom summary
 *
 * @see Issue #1229 - 智能会话结束
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerDetector');

/** Trigger reason types */
export type TriggerReason = 'normal' | 'timeout' | 'abandoned' | string;

/** Result of trigger phrase detection */
export interface TriggerResult {
  /** Whether a trigger was detected */
  detected: true;
  /** The reason for ending the discussion */
  reason: TriggerReason;
  /** Optional summary text (from [DISCUSSION_END:summary=...]) */
  summary?: string;
  /** The message text with the trigger phrase removed */
  cleanText: string;
}

/** Result when no trigger is detected */
export interface NoTriggerResult {
  detected: false;
  cleanText: string;
}

export type DetectionResult = TriggerResult | NoTriggerResult;

/**
 * Regex to match trigger phrases in text messages.
 *
 * Supported formats:
 * - [DISCUSSION_END]
 * - [DISCUSSION_END:timeout]
 * - [DISCUSSION_END:abandoned]
 * - [DISCUSSION_END:summary=some text here]
 */
const TRIGGER_REGEX = /\[DISCUSSION_END(?::([^\]]*))?\]/g;

/**
 * Trigger phrase detector for smart session end.
 *
 * Scans outgoing text messages for [DISCUSSION_END] patterns.
 * When detected, extracts the reason and strips the trigger
 * from the message so only the clean text is sent to users.
 */
export class TriggerDetector {
  /**
   * Detect trigger phrase in text and return detection result.
   *
   * @param text - The message text to scan
   * @returns Detection result with trigger info or clean text
   */
  detectAndStrip(text: string): DetectionResult {
    if (!text || typeof text !== 'string') {
      return { detected: false, cleanText: text || '' };
    }

    // Reset regex state for repeated calls
    TRIGGER_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    let reason: TriggerReason = 'normal';
    let summary: string | undefined;

    while ((match = TRIGGER_REGEX.exec(text)) !== null) {
      const param = match[1];

      if (!param) {
        reason = 'normal';
      } else if (param.startsWith('summary=')) {
        reason = 'normal';
        summary = param.slice('summary='.length);
      } else {
        reason = param;
      }

      logger.info(
        { reason, summary, triggerMatch: match[0] },
        'Discussion end trigger detected'
      );
    }

    // Strip all trigger phrases from text
    const cleanText = text.replace(TRIGGER_REGEX, '').trim();

    if (cleanText === text) {
      // No triggers found (text unchanged)
      return { detected: false, cleanText: text };
    }

    return {
      detected: true,
      reason,
      summary,
      cleanText,
    };
  }

  /**
   * Check if text contains a trigger phrase (without stripping).
   *
   * @param text - The message text to scan
   * @returns Whether a trigger phrase was found
   */
  hasTrigger(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }
    TRIGGER_REGEX.lastIndex = 0;
    return TRIGGER_REGEX.test(text);
  }
}
