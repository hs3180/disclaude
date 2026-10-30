/**
 * Structured read-only chat history queries (Issue #5603).
 *
 * Single backend shared by the `disclaude history query` CLI subcommand and
 * the `GET /api/history/query` REST route. Agents (including built-in skills)
 * read conversation history through this service instead of injected tools or
 * private read paths. Output is structured JSON; nothing here writes, mutates
 * or deletes log files.
 *
 * Storage contract mirrors MessageLogger: one Markdown file per chat per day
 * at `<workspace>/chat/<YYYY-MM-DD>/<chatId>.md`, appended chronologically with
 * `👤|🤖 [ISO-timestamp] (messageId)\n<content>\n\n---\n\n` entries.
 *
 * @module history/history-query
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Config, MESSAGE_LOGGING } from '@disclaude/core';

/** Direction of a logged entry, as written by MessageLogger. */
export type HistoryDirection = 'incoming' | 'outgoing';

export interface HistoryMessage {
  direction: HistoryDirection;
  /** ISO timestamp as recorded in the log line. */
  timestamp: string;
  messageId: string;
  content: string;
}

export interface HistoryDay {
  /** `YYYY-MM-DD` log directory name. */
  date: string;
  /** Absolute path to the day's log file, for direct follow-up reads. */
  path: string;
  /** Chronological (oldest first) entries parsed from the day's file. */
  messages: HistoryMessage[];
}

export interface HistoryQueryResult {
  chatId: string;
  /** Newest day first, matching getChatHistory/getChatLogFilePaths ordering. */
  days: HistoryDay[];
  /** Number of messages returned across all days. */
  totalMessages: number;
  /** True when `limit` dropped older messages from the result. */
  truncatedByLimit: boolean;
}

export interface HistoryQueryOptions {
  chatId: string;
  /** Days to look back; defaults to `sessionRestore.historyDays`. */
  days?: number;
  /** Return only the newest N messages across days; undefined = unlimited. */
  limit?: number;
}

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_PATTERN = /^(👤|🤖) \[([^\]]*)\] \(([^)]*)\)\n/;

function parseDayLog(raw: string): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const blocks = raw.split('\n\n---\n\n');
  for (const block of blocks) {
    if (!block.trim()) { continue; }
    const match = ENTRY_PATTERN.exec(block);
    if (!match) { continue; } // Unrecognized lines are preserved by reading the file directly.
    messages.push({
      direction: match[1] === '👤' ? 'incoming' : 'outgoing',
      timestamp: match[2],
      messageId: match[3],
      content: block.slice(match[0].length).replace(/\n+$/, ''),
    });
  }
  return messages;
}

/**
 * Query locally available chat history for one chat, read-only.
 *
 * Days are capped at `days` (or the session-restore default), newest first.
 * When `limit` is set, the newest N messages across days are returned and
 * older ones are dropped with `truncatedByLimit: true` — the day files remain
 * on disk and each day entry still reports its path for direct reads.
 * A chat without local history resolves to an empty result, not an error.
 */
export async function queryChatHistory(options: HistoryQueryOptions): Promise<HistoryQueryResult> {
  const chatId = options.chatId?.trim();
  if (!chatId) { throw new Error('history query requires a chatId'); }
  const maxDays = options.days && options.days > 0
    ? Math.floor(options.days)
    : Config.getSessionRestoreConfig().historyDays;
  const limit = options.limit !== undefined && options.limit > 0 ? Math.floor(options.limit) : undefined;

  const chatDir = join(Config.getWorkspaceDir(), MESSAGE_LOGGING.LOGS_DIR);
  const dateDirs = (await readdir(chatDir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && DATE_DIR_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const days: HistoryDay[] = [];
  for (const date of dateDirs.slice(0, maxDays)) {
    const logPath = join(chatDir, date, `${chatId}.md`);
    const raw = await readFile(logPath, 'utf-8').catch(() => undefined);
    if (raw === undefined || !raw.trim()) { continue; }
    const messages = parseDayLog(raw);
    if (messages.length === 0) { continue; }
    days.push({ date, path: logPath, messages });
  }

  let truncatedByLimit = false;
  if (limit !== undefined) {
    const totalAvailable = days.reduce((sum, day) => sum + day.messages.length, 0);
    truncatedByLimit = totalAvailable > limit;
    // Walk newest-first, keeping whole messages until the budget is spent.
    const kept: HistoryDay[] = [];
    let remaining = limit;
    for (const day of days) {
      if (remaining <= 0) { break; }
      if (day.messages.length <= remaining) {
        kept.push(day);
        remaining -= day.messages.length;
      } else {
        kept.push({ ...day, messages: day.messages.slice(day.messages.length - remaining) });
        remaining = 0;
      }
    }
    days.length = 0;
    days.push(...kept);
  }

  return {
    chatId,
    days,
    totalMessages: days.reduce((sum, day) => sum + day.messages.length, 0),
    truncatedByLimit,
  };
}
