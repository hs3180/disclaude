/**
 * Loop Feedback — file-based feedback propagation for Loop tasks.
 *
 * Issue #4017: Enables cross-conversation feedback between the initial
 * conversation and the Loop execution agent.
 *
 * The initial conversation's agent detects user feedback (direction changes,
 * corrections, new requirements) and writes it to the LOOP.md Progress Log.
 * The Loop agent reads feedback at each step and adjusts its execution.
 *
 * Feedback format in Progress Log:
 * ```markdown
 * > [Feedback from user — 2026-06-11T10:30:00.000Z]: User requests focusing on X.
 * ```
 *
 * @module task/loop-feedback
 */

import { readFile, writeFile } from 'fs/promises';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LoopFeedback');

// ============================================================================
// Types
// ============================================================================

/** A parsed feedback entry from the Progress Log */
export interface FeedbackEntry {
  /** ISO timestamp of when the feedback was written */
  timestamp: string;
  /** The feedback message */
  message: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Regex to match feedback entries in the Progress Log */
const FEEDBACK_PATTERN = /^>\s*\[Feedback from user — ([^\]]+)\]:\s*(.+)$/gm;

// ============================================================================
// Core functions
// ============================================================================

/**
 * Append a feedback entry to a LOOP.md file's Progress Log section.
 *
 * The feedback is appended at the end of the file (before the final newline,
 * if any). It uses the standard feedback marker format so the Loop agent can
 * detect it.
 *
 * @param filePath - Path to the LOOP.md file
 * @param message - The feedback message to append
 * @param timestamp - Optional ISO timestamp (defaults to now)
 */
export async function appendFeedback(
  filePath: string,
  message: string,
  timestamp?: string,
): Promise<void> {
  const ts = timestamp ?? new Date().toISOString();
  const feedbackLine = `\n> [Feedback from user — ${ts}]: ${message}\n`;

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    logger.error(`Cannot read LOOP.md at ${filePath}`);
    throw new Error(`Cannot read LOOP.md at ${filePath}`);
  }

  // Ensure file ends with a newline before appending
  const trimmed = content.endsWith('\n') ? content : `${content}\n`;
  await writeFile(filePath, `${trimmed}${feedbackLine}`, 'utf-8');

  logger.info(`Feedback appended to ${filePath}: "${message.slice(0, 50)}..."`);
}

/**
 * Read all feedback entries from a LOOP.md file.
 *
 * Parses the Progress Log section for feedback markers and returns
 * them as structured entries.
 *
 * @param filePath - Path to the LOOP.md file
 * @returns Array of feedback entries, ordered by appearance (oldest first)
 */
export async function readFeedback(filePath: string): Promise<FeedbackEntry[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseFeedbackFromContent(content);
}

/**
 * Read feedback entries created after a given timestamp.
 *
 * Useful for the Loop agent to check for new feedback since its last step.
 *
 * @param filePath - Path to the LOOP.md file
 * @param sinceTimestamp - ISO timestamp; only entries after this time are returned
 * @returns Array of feedback entries newer than the given timestamp
 */
export async function readFeedbackSince(
  filePath: string,
  sinceTimestamp: string,
): Promise<FeedbackEntry[]> {
  const entries = await readFeedback(filePath);
  const since = new Date(sinceTimestamp).getTime();
  return entries.filter(e => new Date(e.timestamp).getTime() > since);
}

/**
 * Check whether a LOOP.md file has new feedback since a given timestamp.
 *
 * @param filePath - Path to the LOOP.md file
 * @param sinceTimestamp - ISO timestamp to compare against
 * @returns true if there is at least one feedback entry after the timestamp
 */
export async function hasNewFeedback(
  filePath: string,
  sinceTimestamp: string,
): Promise<boolean> {
  const entries = await readFeedbackSince(filePath, sinceTimestamp);
  return entries.length > 0;
}

// ============================================================================
// Pure parsing helper (exported for testing)
// ============================================================================

/**
 * Parse feedback entries from markdown content.
 *
 * @param content - The full LOOP.md content
 * @returns Array of feedback entries
 */
export function parseFeedbackFromContent(content: string): FeedbackEntry[] {
  const entries: FeedbackEntry[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  const regex = new RegExp(FEEDBACK_PATTERN.source, 'gm');

  while ((match = regex.exec(content)) !== null) {
    entries.push({
      timestamp: match[1].trim(),
      message: match[2].trim(),
    });
  }

  return entries;
}
