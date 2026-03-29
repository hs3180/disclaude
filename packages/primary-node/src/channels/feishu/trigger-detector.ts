/**
 * Trigger Detector — Detects discussion-end trigger phrases in text messages.
 *
 * When a Chat Agent determines a discussion has concluded, it sends a trigger
 * phrase (e.g. `[DISCUSSION_END]`) in its message. This module detects such
 * triggers and extracts metadata (reason, summary) for session cleanup.
 *
 * Issue #1229: Smart session end — detect trigger phrases and dissolve group.
 *
 * Design principles:
 * - Only handles text type messages (per PR #1449 feedback)
 * - No file system / workspaceDir dependency
 * - Pure regex detection — stateless and testable
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerDetector');

// ─── Trigger phrase format ──────────────────────────────────────────────
//
// [DISCUSSION_END]                       → normal end
// [DISCUSSION_END:timeout]               → timeout end
// [DISCUSSION_END:abandoned]             → abandoned
// [DISCUSSION_END:summary=some text]     → end with summary
// [DISCUSSION_END:timeout=超时未回复]     → reason + summary
// [DISCUSSION_END=some text]             → summary only (no reason)
//
// Regex captures everything between [DISCUSSION_END and ] after an optional
// : or = separator. We then parse the captured content in detect().

/**
 * Regex that matches the trigger phrase.
 *
 * Captures:
 * - Group 1: The separator character (`:` or `=`, or undefined if bare `[DISCUSSION_END]`)
 * - Group 2: The payload text after the separator
 */
const TRIGGER_REGEX = /\[DISCUSSION_END(?:([:=])([^\]]*))?\]/g;

/** Known non-summary reasons (lowercase). */
const KNOWN_REASONS = new Set(['timeout', 'abandoned']);

/**
 * Parsed result of a trigger phrase detection.
 */
export interface TriggerResult {
  /** Whether a trigger was found. */
  detected: true;
  /** The reason, if provided (e.g. 'timeout', 'abandoned'). */
  reason?: string;
  /** The summary text, if provided. */
  summary?: string;
  /** The original trigger string (for logging). */
  raw: string;
  /** The message text with all trigger phrases stripped and whitespace collapsed. */
  cleanText: string;
}

/**
 * Negative result when no trigger is found.
 */
export interface NoTriggerResult {
  detected: false;
  text: string;
}

/**
 * Result of trigger detection.
 */
export type TriggerDetectionResult = TriggerResult | NoTriggerResult;

/**
 * Parse the payload from a trigger phrase into reason and summary.
 *
 * @param separator - The separator character used (`:` or `=`, or undefined)
 * @param payload - The text captured after the separator
 */
function parsePayload(separator: string | undefined, payload: string): { reason?: string; summary?: string } {
  if (!separator || !payload) {
    return {};
  }

  if (separator === '=') {
    // [DISCUSSION_END=text] → summary only (no reason)
    return { summary: payload.trim() };
  }

  // separator === ':' → parse [DISCUSSION_END:payload]
  const eqIdx = payload.indexOf('=');
  if (eqIdx === -1) {
    // No '=' — entire payload is the reason
    // e.g. [DISCUSSION_END:timeout] → reason = "timeout"
    return {
      reason: KNOWN_REASONS.has(payload.toLowerCase())
        ? payload.toLowerCase()
        : payload.trim(),
    };
  }

  const left = payload.substring(0, eqIdx).trim();
  const right = payload.substring(eqIdx + 1).trim();

  if (left.toLowerCase() === 'summary') {
    // [DISCUSSION_END:summary=text] → summary only
    return { summary: right };
  }

  // [DISCUSSION_END:reason=text] → reason + summary
  // e.g. [DISCUSSION_END:timeout=超时未回复]
  return {
    reason: left,
    summary: right,
  };
}

/**
 * Collapse consecutive whitespace and trim.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * TriggerDetector — Stateless regex-based trigger phrase detector.
 *
 * Usage:
 * ```typescript
 * const detector = new TriggerDetector();
 * const result = detector.detect('讨论结束 [DISCUSSION_END:summary=达成共识]');
 * if (result.detected) {
 *   console.log(result.reason);   // undefined (summary is not a reason)
 *   console.log(result.summary);  // '达成共识'
 *   console.log(result.cleanText); // '讨论结束'
 * }
 * ```
 */
export class TriggerDetector {
  /**
   * Detect trigger phrases in a text message.
   *
   * Supports multiple trigger phrases in one message — all are stripped
   * from the output, but only the first one's metadata is returned.
   *
   * @param text - The message text to scan.
   * @returns Detection result with metadata (if found) and cleaned text.
   */
  detect(text: string): TriggerDetectionResult {
    if (!text || typeof text !== 'string') {
      return { detected: false, text: text || '' };
    }

    // Reset regex state for repeated calls
    TRIGGER_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    let firstMatch: RegExpExecArray | null = null;

    while ((match = TRIGGER_REGEX.exec(text)) !== null) {
      if (!firstMatch) {
        firstMatch = match;
      }
    }

    if (!firstMatch) {
      return { detected: false, text };
    }

    // Parse payload from the first match
    const separator = firstMatch[1] as string | undefined;
    const payload = firstMatch[2] || '';
    const { reason, summary } = parsePayload(separator, payload);

    // Strip all triggers and collapse whitespace
    TRIGGER_REGEX.lastIndex = 0;
    const cleanText = collapseWhitespace(text.replace(TRIGGER_REGEX, ''));

    logger.info(
      { reason, hasSummary: !!summary, raw: firstMatch[0] },
      'Discussion end trigger detected',
    );

    return {
      detected: true,
      reason,
      summary,
      raw: firstMatch[0],
      cleanText,
    };
  }

  /**
   * Check if a text contains a trigger phrase without extracting metadata.
   *
   * Faster than `detect()` when you only need a boolean answer.
   *
   * @param text - The message text to check.
   */
  hasTrigger(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }
    TRIGGER_REGEX.lastIndex = 0;
    return TRIGGER_REGEX.test(text);
  }

  /**
   * Strip all trigger phrases from text without detection.
   *
   * @param text - The message text to clean.
   * @returns The text with all trigger phrases removed, whitespace collapsed, and trimmed.
   */
  stripTrigger(text: string): string {
    if (!text || typeof text !== 'string') {
      return text || '';
    }
    TRIGGER_REGEX.lastIndex = 0;
    return collapseWhitespace(text.replace(TRIGGER_REGEX, ''));
  }
}

/**
 * Well-known trigger phrases for documentation / SOUL.md reference.
 */
export const TRIGGER_PHRASES = {
  /** Normal discussion end */
  NORMAL: '[DISCUSSION_END]',
  /** Timeout end */
  TIMEOUT: '[DISCUSSION_END:timeout]',
  /** Discussion abandoned */
  ABANDONED: '[DISCUSSION_END:abandoned]',
  /** End with summary: replace `<summary>` with actual text */
  SUMMARY: '[DISCUSSION_END:summary=<summary>]',
} as const;
