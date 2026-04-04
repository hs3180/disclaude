/**
 * Trigger Phrase Detector.
 *
 * Detects trigger phrases in outgoing text messages to initiate
 * smart session end (group dissolution).
 *
 * Issue #1229: Smart session end via trigger phrase detection.
 *
 * Design principles (from PR #1449 rejection feedback):
 * - Only handles text type messages
 * - No session-records.md persistence
 * - No workspaceDir dependency
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerPhrase');

/**
 * Result of trigger phrase detection.
 */
export interface TriggerResult {
  /** Whether a trigger phrase was detected */
  detected: boolean;
  /** The trigger type (e.g., 'timeout', 'abandoned'), undefined for normal end */
  type?: string;
}

/**
 * Default trigger phrase pattern.
 *
 * Matches:
 * - `[DISCUSSION_END]` — normal end
 * - `[DISCUSSION_END:timeout]` — timeout end
 * - `[DISCUSSION_END:abandoned]` — abandoned end
 * - `[DISCUSSION_END:any_custom_type]` — custom type
 */
const DEFAULT_TRIGGER_PATTERN = /\[DISCUSSION_END(?::(\w+))?\]/;

/**
 * TriggerPhraseDetector - Detects trigger phrases in outgoing text messages.
 *
 * When the Chat Agent determines a discussion has ended, it includes a trigger
 * phrase like `[DISCUSSION_END]` in its message. This detector scans outgoing
 * text messages for such phrases and returns the trigger type.
 *
 * Usage:
 * ```typescript
 * const detector = new TriggerPhraseDetector();
 * const result = detector.detect('Discussion concluded. [DISCUSSION_END]');
 * if (result.detected) {
 *   // result.type === undefined (normal end)
 * }
 * ```
 */
export class TriggerPhraseDetector {
  private triggerPattern: RegExp;

  constructor(pattern?: RegExp) {
    this.triggerPattern = pattern || DEFAULT_TRIGGER_PATTERN;
  }

  /**
   * Check if a text message contains a trigger phrase.
   *
   * @param text - The text content to scan
   * @returns TriggerResult with detection status and optional type
   */
  detect(text: string): TriggerResult {
    if (!text) {
      return { detected: false };
    }

    const match = text.match(this.triggerPattern);
    if (!match) {
      return { detected: false };
    }

    const type = match[1] || undefined;
    logger.info({ triggerType: type }, 'Trigger phrase detected in outgoing message');

    return { detected: true, type };
  }
}
