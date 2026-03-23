/**
 * Trigger Phrase Detector.
 *
 * Detects session-end trigger phrases in agent text messages.
 * When a Chat Agent determines a discussion has reached its goal,
 * it sends a trigger phrase like `[DISCUSSION_END]` which this
 * detector identifies for downstream cleanup actions.
 *
 * Supported trigger formats:
 * - `[DISCUSSION_END]` - normal end
 * - `[DISCUSSION_END:timeout]` - timeout end
 * - `[DISCUSSION_END:abandoned]` - discussion abandoned
 * - `[DISCUSSION_END:summary=...]` - end with summary text
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerDetector');

/**
 * Result of trigger phrase detection.
 */
export interface TriggerResult {
  /** Whether a trigger phrase was detected */
  detected: boolean;
  /** The reason for session end (e.g., 'timeout', 'abandoned', undefined for normal) */
  reason?: string;
  /** Optional summary text provided by the agent */
  summary?: string;
  /** The raw trigger match string (for stripping from message) */
  rawMatch?: string;
}

/**
 * Configuration for trigger phrase detection.
 */
export interface TriggerDetectorConfig {
  /** Custom trigger pattern (default: DISCUSSION_END) */
  triggerKeyword?: string;
}

/**
 * Trigger Phrase Detector.
 *
 * Scans text messages for session-end trigger phrases and extracts
 * associated metadata (reason, summary).
 */
export class TriggerDetector {
  private pattern: RegExp;

  constructor(config: TriggerDetectorConfig = {}) {
    const keyword = config.triggerKeyword || 'DISCUSSION_END';
    // Build regex: [KEYWORD] or [KEYWORD:anything]
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.pattern = new RegExp(`\\[${escaped}(?::([^\\]]+))?\\]`, 'g');
    logger.debug({ keyword, pattern: this.pattern.source }, 'TriggerDetector initialized');
  }

  /**
   * Detect and extract trigger phrase from text.
   *
   * @param text - The message text to scan
   * @returns TriggerResult with detection status and extracted metadata
   */
  detect(text: string): TriggerResult {
    // Reset lastIndex for global regex
    this.pattern.lastIndex = 0;

    const match = this.pattern.exec(text);
    if (!match) {
      return { detected: false };
    }

    const rawMatch = match[0];
    const payload = match[1]; // content after "DISCUSSION_END:"

    let reason: string | undefined;
    let summary: string | undefined;

    if (payload) {
      // Check for summary=... format
      const summaryMatch = payload.match(/^summary=(.+)$/);
      if (summaryMatch) {
        summary = summaryMatch[1];
      } else {
        // Otherwise treat as reason (timeout, abandoned, etc.)
        reason = payload;
      }
    }

    logger.info(
      { rawMatch, reason, summary, textPreview: text.slice(0, 100) },
      'Trigger phrase detected'
    );

    return { detected: true, reason, summary, rawMatch };
  }

  /**
   * Strip trigger phrase from text.
   *
   * Removes the trigger phrase (and surrounding whitespace/newlines) from the message.
   *
   * @param text - The message text containing the trigger
   * @param result - The trigger detection result
   * @returns Cleaned text without the trigger phrase
   */
  stripTrigger(text: string, result: TriggerResult): string {
    if (!result.detected || !result.rawMatch) {
      return text;
    }

    let cleaned = text.replace(result.rawMatch, '');

    // Clean up leftover whitespace/newlines around the removed trigger
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return cleaned;
  }

  /**
   * Detect trigger and return cleaned text + result.
   *
   * Convenience method that combines detect() and stripTrigger().
   *
   * @param text - The message text to scan
   * @returns Object with cleaned text and trigger result
   */
  detectAndStrip(text: string): { cleanedText: string; trigger: TriggerResult } {
    const trigger = this.detect(text);
    const cleanedText = this.stripTrigger(text, trigger);
    return { cleanedText, trigger };
  }
}

// ─── Constants for external use ────────────────────────────────

/**
 * Default trigger keyword used by the system.
 */
export const DEFAULT_TRIGGER_KEYWORD = 'DISCUSSION_END';

/**
 * Standard trigger reasons.
 */
export const TRIGGER_REASONS = {
  NORMAL: undefined,
  TIMEOUT: 'timeout',
  ABANDONED: 'abandoned',
} as const;
