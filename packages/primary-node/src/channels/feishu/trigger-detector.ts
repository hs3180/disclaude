/**
 * Trigger Phrase Detector for smart session end.
 *
 * Detects trigger phrases (e.g., [DISCUSSION_END]) in outbound text messages.
 * When detected, the system strips the phrase, sends the clean text,
 * and then dissolves the group chat.
 *
 * Issue #1229: Smart session end — trigger-based discussion completion.
 *
 * Design follows the MentionDetector pattern:
 * - Stateless detector (no file system dependencies)
 * - Regex-based detection
 * - Only handles text type messages
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerDetector');

/**
 * Default trigger phrase pattern.
 * Matches: [DISCUSSION_END], [DISCUSSION_END:timeout], [DISCUSSION_END:abandoned],
 *          [DISCUSSION_END:summary=...], etc.
 */
export const DEFAULT_TRIGGER_PATTERN = /\[DISCUSSION_END(?::([^\]]*))?\]/;

/**
 * Result of trigger detection.
 */
export interface TriggerDetectionResult {
  /** Whether a trigger phrase was found */
  detected: boolean;
  /** The text with the trigger phrase stripped */
  cleanText: string;
  /** The trigger reason (e.g., 'timeout', 'abandoned', 'summary=...') */
  reason?: string;
  /** The full match of the trigger phrase */
  triggerMatch?: string;
}

/**
 * Trigger Phrase Detector.
 *
 * Scans outbound text messages for trigger phrases like `[DISCUSSION_END]`.
 * Provides methods to detect, strip, or both detect-and-strip triggers.
 *
 * Usage:
 * ```typescript
 * const detector = new TriggerDetector();
 * const result = detector.detectAndStrip("Discussion concluded. [DISCUSSION_END]");
 * if (result.detected) {
 *   // Send result.cleanText, then dissolve the chat
 * }
 * ```
 */
export class TriggerDetector {
  private readonly triggerPattern: RegExp;

  constructor(pattern?: RegExp) {
    this.triggerPattern = pattern || DEFAULT_TRIGGER_PATTERN;
  }

  /**
   * Detect if the text contains a trigger phrase.
   *
   * @param text - Text to scan
   * @returns Detection result with optional reason
   */
  detect(text: string): { detected: boolean; reason?: string; triggerMatch?: string } {
    const match = text.match(this.triggerPattern);
    if (!match) {
      return { detected: false };
    }

    const reason = match[1] ? match[1].trim() : undefined;
    logger.info(
      { triggerMatch: match[0], reason },
      'Discussion end trigger detected',
    );

    return {
      detected: true,
      reason,
      triggerMatch: match[0],
    };
  }

  /**
   * Strip the trigger phrase from text.
   *
   * @param text - Text containing trigger phrase
   * @returns Text with trigger phrase removed and cleaned up
   */
  strip(text: string): string {
    return text
      .replace(this.triggerPattern, '')
      .replace(/\n{3,}/g, '\n\n')  // Collapse multiple newlines
      .trim();
  }

  /**
   * Detect and strip trigger phrase in one call.
   *
   * This is the primary method to use when processing outbound messages.
   * If a trigger is detected, returns the clean text and trigger info.
   * If no trigger is found, returns the original text unchanged.
   *
   * @param text - Text to scan
   * @returns Detection result
   */
  detectAndStrip(text: string): TriggerDetectionResult {
    const detection = this.detect(text);
    if (!detection.detected) {
      return { detected: false, cleanText: text };
    }

    const cleanText = this.strip(text);
    return {
      detected: true,
      cleanText,
      reason: detection.reason,
      triggerMatch: detection.triggerMatch,
    };
  }
}
