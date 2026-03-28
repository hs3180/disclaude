/**
 * Trigger Phrase Detector for smart session end.
 *
 * Detects [DISCUSSION_END] trigger phrases in outgoing text messages.
 * When the Chat Agent determines a discussion has reached its goal,
 * it includes a trigger phrase which the system detects, strips from
 * the message, and uses to initiate group dissolution.
 *
 * Issue #1229: feat: 智能会话结束 - 判断讨论何时可以关闭
 *
 * Design:
 * - Pure regex-based detection, no external dependencies
 * - No file system or workspaceDir dependency
 * - No session record persistence
 * - Only handles text-type messages
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerDetector');

/**
 * Supported trigger reasons.
 */
export type TriggerReason = 'normal' | 'timeout' | 'abandoned' | string;

/**
 * Result of trigger detection.
 */
export interface TriggerResult {
  /** Whether a trigger was detected */
  detected: true;
  /** The reason for session end (e.g., 'timeout', 'abandoned', 'normal') */
  reason: TriggerReason;
  /** Optional summary provided with the trigger */
  summary?: string;
  /** The raw trigger string that was detected */
  rawTrigger: string;
  /** The text content with the trigger stripped */
  cleanText: string;
}

/**
 * Result when no trigger is detected.
 */
export interface NoTriggerResult {
  detected: false;
  reason: undefined;
  summary: undefined;
  rawTrigger: undefined;
  cleanText: string;
}

/**
 * Regex pattern for discussion end triggers.
 *
 * Supported formats:
 * - [DISCUSSION_END]                  → normal end
 * - [DISCUSSION_END:timeout]          → timeout end
 * - [DISCUSSION_END:abandoned]        → abandoned end
 * - [DISCUSSION_END:summary=...]      → end with custom summary
 * - [DISCUSSION_END:custom_reason]    → end with custom reason
 *
 * The trigger may appear anywhere in the text, typically at the end.
 */
const TRIGGER_PATTERN = /\[DISCUSSION_END(?::([^\]=]+))?(?:=([^\]]*))?\]/;

/**
 * Trigger Phrase Detector.
 *
 * Detects and strips [DISCUSSION_END] trigger phrases from text messages.
 * Follows the MentionDetector pattern as a lightweight, stateless utility.
 */
export class TriggerDetector {
  /**
   * Detect a trigger phrase in the given text.
   *
   * @param text - The text to scan for triggers
   * @returns TriggerResult if detected, NoTriggerResult otherwise
   */
  detect(text: string): TriggerResult | NoTriggerResult {
    const match = TRIGGER_PATTERN.exec(text);
    if (!match) {
      return {
        detected: false,
        reason: undefined,
        summary: undefined,
        rawTrigger: undefined,
        cleanText: text,
      };
    }

    const rawTrigger = match[0];
    const reasonPart = match[1]; // e.g., 'timeout', 'abandoned', 'summary', 'custom'
    const summaryPart = match[2]; // e.g., 'reached consensus on formatting'

    // Determine reason: 'summary' is a special keyword, not a reason
    let reason: TriggerReason = 'normal';
    if (reasonPart && reasonPart !== 'summary') {
      reason = reasonPart;
    }

    // Determine summary: present when '=' is used (even with empty value)
    let summary: string | undefined;
    if (summaryPart !== undefined) {
      summary = summaryPart.trim() || undefined;
    }

    logger.info(
      { reason, hasSummary: !!summary, rawTrigger },
      'Discussion end trigger detected'
    );

    return {
      detected: true,
      reason,
      summary,
      rawTrigger,
      cleanText: text,
    };
  }

  /**
   * Strip a trigger phrase from the given text.
   *
   * Removes the trigger and any surrounding whitespace to produce clean text.
   *
   * @param text - The text containing a trigger phrase
   * @returns The text with the trigger stripped, or the original text if no trigger found
   */
  strip(text: string): string {
    const result = text.replace(TRIGGER_PATTERN, '');
    // Clean up leftover whitespace patterns left by trigger removal
    return result
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
      .replace(/[ \t]+$/gm, '')   // Remove trailing whitespace per line
      .replace(/  +/g, ' ')       // Collapse multiple spaces
      .trim();
  }

  /**
   * Detect a trigger and strip it from the text in one operation.
   *
   * This is the primary method to use in message sending flow:
   * 1. Check if trigger exists
   * 2. Get the clean text for sending
   * 3. Get the trigger metadata for session end handling
   *
   * @param text - The text to scan
   * @returns TriggerResult with cleanText if detected, NoTriggerResult otherwise
   */
  detectAndStrip(text: string): TriggerResult | NoTriggerResult {
    const result = this.detect(text);
    if (!result.detected) {
      return result;
    }

    return {
      ...result,
      cleanText: this.strip(text),
    };
  }
}
