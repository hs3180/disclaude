/**
 * Discussion End Trigger Detector.
 *
 * Detects trigger phrases in outgoing text messages that signal
 * the Chat Agent wants to end a discussion and dissolve the group chat.
 *
 * Trigger phrase format: [DISCUSSION_END] or [DISCUSSION_END:<reason>]
 * Examples:
 *   [DISCUSSION_END]              — Normal end
 *   [DISCUSSION_END:timeout]      — Timeout
 *   [DISCUSSION_END:abandoned]    — Abandoned
 *   [DISCUSSION_END:summary=...]  — End with summary
 *
 * Issue #1229: Smart session end — detect when discussion should close
 *
 * Design decisions (from rejected PR #1449 feedback):
 * - Only processes text type messages (not rich text/cards)
 * - No session record file persistence
 * - No workspaceDir dependency
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('TriggerDetector');

/**
 * Parsed trigger phrase information.
 */
export interface TriggerResult {
  /** The full trigger phrase matched (e.g., "[DISCUSSION_END:timeout]") */
  phrase: string;
  /** The reason for ending (e.g., "timeout", "abandoned", or undefined for normal end) */
  reason?: string;
  /** Optional summary text (from [DISCUSSION_END:summary=...]) */
  summary?: string;
}

/**
 * Regex to match trigger phrases.
 *
 * Matches:
 *   [DISCUSSION_END]                     → no reason
 *   [DISCUSSION_END:timeout]             → reason = "timeout"
 *   [DISCUSSION_END:abandoned]           → reason = "abandoned"
 *   [DISCUSSION_END:summary=some text]   → reason = "summary", summary = "some text"
 *
 * The trigger may appear anywhere in the text (on its own line or inline).
 */
const TRIGGER_REGEX = /\[DISCUSSION_END(?::([^\]]*))?\]/;

/**
 * Parse a trigger phrase into a TriggerResult.
 *
 * @param phrase - The full trigger phrase including brackets (e.g., "[DISCUSSION_END:timeout]")
 * @returns Parsed TriggerResult
 */
export function parseTriggerPhrase(phrase: string): TriggerResult {
  // Extract content between brackets
  const match = phrase.match(/\[DISCUSSION_END(?::([^\]]*))?\]/);
  if (!match) {
    return { phrase };
  }

  const content = match[1]; // The part after "DISCUSSION_END:"
  if (!content) {
    return { phrase };
  }

  // Check for summary format: [DISCUSSION_END:summary=...]
  if (content.startsWith('summary=')) {
    return {
      phrase,
      reason: 'summary',
      summary: content.slice('summary='.length),
    };
  }

  // Otherwise, content is the reason (e.g., "timeout", "abandoned")
  return {
    phrase,
    reason: content,
  };
}

/**
 * Detect a discussion-end trigger phrase in text.
 *
 * @param text - The message text to scan
 * @returns TriggerResult if a trigger is found, null otherwise
 */
export function detectTrigger(text: string): TriggerResult | null {
  if (!text) return null;

  const match = text.match(TRIGGER_REGEX);
  if (!match) return null;

  return parseTriggerPhrase(match[0]);
}

/**
 * Detect and strip a trigger phrase from text.
 *
 * Returns the clean text (with trigger removed) and the parsed trigger info.
 * The trigger line is completely removed if it's on its own line.
 * If inline, only the trigger bracket is removed.
 *
 * @param text - The message text to process
 * @returns Object with cleanText and trigger, or null if no trigger found
 */
export function detectAndStripTrigger(text: string): { cleanText: string; trigger: TriggerResult } | null {
  if (!text) return null;

  const trigger = detectTrigger(text);
  if (!trigger) return null;

  // Remove the trigger phrase and clean up whitespace
  let cleanText = text.replace(TRIGGER_REGEX, '');

  // Collapse multiple spaces left by inline trigger removal
  cleanText = cleanText.replace(/  +/g, ' ');

  // If the trigger was on its own line, remove the empty line
  cleanText = cleanText.replace(/\n\s*\n\s*\n/g, '\n\n'); // Collapse triple newlines
  cleanText = cleanText.replace(/^\s*\n/, ''); // Remove leading blank line
  cleanText = cleanText.replace(/\n\s*$/, ''); // Remove trailing blank line
  cleanText = cleanText.trim();

  logger.info(
    { triggerPhrase: trigger.phrase, reason: trigger.reason, hadSummary: !!trigger.summary },
    'Discussion end trigger detected and stripped from outgoing message'
  );

  return { cleanText, trigger };
}

/**
 * Check if a string contains a discussion-end trigger phrase.
 * Faster than detectTrigger() when you only need a boolean.
 *
 * @param text - The message text to check
 * @returns true if a trigger phrase is present
 */
export function hasTrigger(text: string): boolean {
  return !!text && TRIGGER_REGEX.test(text);
}
