/**
 * FeedbackStore — File-based feedback propagation between conversations.
 *
 * Issue #4017: Enables user feedback from the initial conversation to be
 * picked up by the research execution agent. Feedback is written to a simple
 * markdown file in the workspace, following the established file-based
 * state-sharing pattern.
 *
 * Storage location: workspace/feedback/{mappingKey}.md
 *
 * @module @disclaude/core/scheduling
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FeedbackStore');

// ---- Types ----

export interface FeedbackEntry {
  /** ISO timestamp when the feedback was recorded */
  timestamp: string;
  /** The raw feedback text from the user */
  text: string;
  /** The chatId where the feedback originated */
  fromChatId: string;
}

export interface FeedbackFile {
  /** The mapping key this feedback file belongs to */
  mappingKey: string;
  /** Source chatId where feedback originates */
  sourceChatId: string;
  /** Ordered feedback entries (newest last) */
  entries: FeedbackEntry[];
}

// ---- Helpers ----

/**
 * Get the feedback file path for a given mapping key.
 */
export function feedbackFilePath(workspaceDir: string, mappingKey: string): string {
  return path.join(workspaceDir, 'feedback', `${mappingKey}.md`);
}

/**
 * Format a FeedbackEntry as a markdown line.
 */
function formatEntry(entry: FeedbackEntry): string {
  return `- [${entry.timestamp}] ${entry.text}`;
}

// ---- Store ----

/**
 * Append a feedback entry to a mapping's feedback file.
 *
 * Creates the feedback directory and file if they don't exist.
 * Entries are appended as markdown list items with timestamps.
 *
 * @param workspaceDir - The workspace root directory
 * @param mappingKey - The mapping key (e.g. "discussion-abc123")
 * @param sourceChatId - The source chatId where feedback originates
 * @param text - The user's feedback text
 * @param fromChatId - The chatId where the feedback was captured
 */
export async function appendFeedback(
  workspaceDir: string,
  mappingKey: string,
  sourceChatId: string,
  text: string,
  fromChatId: string,
): Promise<void> {
  const dir = path.join(workspaceDir, 'feedback');
  await fsPromises.mkdir(dir, { recursive: true });

  const filePath = feedbackFilePath(workspaceDir, mappingKey);
  const entry: FeedbackEntry = {
    timestamp: new Date().toISOString(),
    text,
    fromChatId,
  };

  const line = formatEntry(entry);

  // Check if file exists to decide header vs append
  try {
    await fsPromises.access(filePath);
    // File exists — append
    await fsPromises.appendFile(filePath, `\n${line}`, 'utf-8');
  } catch {
    // File doesn't exist — create with header
    const header = `# Feedback: ${mappingKey}\n\nSource: ${sourceChatId}\n\n## Entries\n\n${line}\n`;
    await fsPromises.writeFile(filePath, header, 'utf-8');
  }

  logger.debug({ mappingKey, fromChatId }, 'Feedback appended');
}

/**
 * Read all feedback entries for a given mapping key.
 *
 * Returns null if the feedback file doesn't exist or is empty.
 *
 * @param workspaceDir - The workspace root directory
 * @param mappingKey - The mapping key
 * @returns Parsed feedback entries, or null if no file exists
 */
export async function readFeedback(
  workspaceDir: string,
  mappingKey: string,
): Promise<FeedbackEntry[] | null> {
  const filePath = feedbackFilePath(workspaceDir, mappingKey);

  let content: string;
  try {
    content = await fsPromises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Parse markdown list entries: "- [timestamp] text"
  const entries: FeedbackEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^- \[([^\]]+)\] (.+)$/);
    if (match) {
      entries.push({
        timestamp: match[1],
        text: match[2],
        fromChatId: '',  // fromChatId is not stored per-line in markdown
      });
    }
  }

  return entries.length > 0 ? entries : null;
}

/**
 * Clear all feedback entries for a given mapping key.
 *
 * @param workspaceDir - The workspace root directory
 * @param mappingKey - The mapping key
 */
export async function clearFeedback(
  workspaceDir: string,
  mappingKey: string,
): Promise<void> {
  const filePath = feedbackFilePath(workspaceDir, mappingKey);
  try {
    await fsPromises.unlink(filePath);
    logger.debug({ mappingKey }, 'Feedback file deleted');
  } catch {
    // File doesn't exist — nothing to do
  }
}
