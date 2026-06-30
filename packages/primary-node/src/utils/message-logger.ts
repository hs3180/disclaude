/**
 * Message logger for persistent message history.
 *
 * Logs all user and bot messages to chat-specific MD files.
 * Uses date-based directory structure: {YYYY-MM-DD}/{chatId}.md
 * Provides message ID-based deduplication via in-memory cache only.
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import fs from 'fs/promises';
import path from 'path';
import { Config, MESSAGE_LOGGING, createLogger } from '@disclaude/core';

const logger = createLogger('MessageLogger');

interface LogEntry {
  messageId: string;
  senderId: string;
  chatId: string;
  content: string;
  messageType: string;
  timestamp: string | number;
  direction: 'incoming' | 'outgoing';
}

/**
 * Get today's date string in YYYY-MM-DD format
 */
function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Message logger class for persistent chat history logging.
 * Handles message deduplication and chat history logging.
 */
export class MessageLogger {
  private chatDir: string;

  // In-memory cache for immediate deduplication (no size limit)
  // Only tracks message IDs seen in current session
  private processedMessageIds = new Set<string>();
  private initialized = false;

  constructor() {
    const workspaceDir = Config.getWorkspaceDir();
    this.chatDir = path.join(workspaceDir, MESSAGE_LOGGING.LOGS_DIR);
  }

  /**
   * Explicit initialization method that must be called and awaited before using the logger.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.initialize();
    this.initialized = true;
  }

  private async initialize(): Promise<void> {
    try {
      // Ensure workspace directory exists first
      const workspaceDir = Config.getWorkspaceDir();
      await fs.mkdir(workspaceDir, { recursive: true });

      // Then create chat subdirectory
      await fs.mkdir(this.chatDir, { recursive: true });

      // Migrate legacy files to date-based structure
      await this.migrateLegacyFiles();
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize');
    }
  }

  /**
   * Migrate legacy files to date-based structure.
   */
  private async migrateLegacyFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.chatDir, { withFileTypes: true });

      // Find legacy flat .md files (not in subdirectories)
      const legacyFlatFiles = entries.filter(
        entry => entry.isFile() && entry.name.endsWith('.md')
      );

      // Find legacy chatId directories with date files inside
      const legacyChatDirs = entries.filter(
        entry => entry.isDirectory() && !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)
      );

      if (legacyFlatFiles.length === 0 && legacyChatDirs.length === 0) {
        return;
      }

      const today = getDateString();
      let migratedCount = 0;

      // Migrate flat files
      for (const file of legacyFlatFiles) {
        const legacyPath = path.join(this.chatDir, file.name);
        const chatId = file.name.replace('.md', '');

        // Create date directory
        const dateDir = path.join(this.chatDir, today);
        await fs.mkdir(dateDir, { recursive: true });

        // Move to new location
        const newPath = path.join(dateDir, `${chatId}.md`);
        await fs.rename(legacyPath, newPath);

        logger.info({ from: file.name, to: `${today}/${chatId}.md` }, 'Migrated file');
        migratedCount++;
      }

      // Migrate old structure {chatId}/{date}.md -> {date}/{chatId}.md
      for (const dir of legacyChatDirs) {
        const chatDir = path.join(this.chatDir, dir.name);
        const dateFiles = await fs.readdir(chatDir, { withFileTypes: true });

        for (const dateFile of dateFiles) {
          if (!dateFile.isFile() || !dateFile.name.endsWith('.md')) {
            continue;
          }

          const dateStr = dateFile.name.replace('.md', '');
          // Validate date format
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            continue;
          }

          const oldPath = path.join(chatDir, dateFile.name);

          // Create date directory
          const newDateDir = path.join(this.chatDir, dateStr);
          await fs.mkdir(newDateDir, { recursive: true });

          // Move to new location
          const newPath = path.join(newDateDir, `${dir.name}.md`);
          await fs.rename(oldPath, newPath);

          logger.info({ from: `${dir.name}/${dateStr}.md`, to: `${dateStr}/${dir.name}.md` }, 'Migrated file');
          migratedCount++;
        }

        // Remove empty chatId directory
        try {
          const remaining = await fs.readdir(chatDir);
          if (remaining.length === 0) {
            await fs.rmdir(chatDir);
          }
        } catch {
          // Ignore errors when cleaning up
        }
      }

      if (migratedCount > 0) {
        logger.info({ count: migratedCount }, 'Migrated files to new structure');
      }
    } catch {
      // Directory doesn't exist or migration failed, that's fine
      logger.debug('No legacy files to migrate');
    }
  }

  /**
   * Log an incoming user message.
   */
  async logIncomingMessage(
    messageId: string,
    senderId: string,
    chatId: string,
    content: string,
    messageType: string,
    timestamp?: string | number
  ): Promise<void> {
    const entry: LogEntry = {
      messageId,
      senderId,
      chatId,
      content,
      messageType,
      timestamp: timestamp || Date.now(),
      direction: 'incoming',
    };

    await this.appendToLog(entry);

    // Add to in-memory cache
    this.processedMessageIds.add(messageId);
  }

  /**
   * Log an outgoing bot message.
   */
  async logOutgoingMessage(
    messageId: string,
    chatId: string,
    content: string,
    messageType: string = 'text',
    timestamp?: string | number
  ): Promise<void> {
    const entry: LogEntry = {
      messageId,
      senderId: 'bot',
      chatId,
      content,
      messageType,
      timestamp: timestamp || Date.now(),
      direction: 'outgoing',
    };

    await this.appendToLog(entry);
  }

  /**
   * Check if a message has already been processed.
   */
  isMessageProcessed(messageId: string): boolean {
    return this.processedMessageIds.has(messageId);
  }

  /**
   * Get chat history as formatted string.
   *
   * Reads chat log files from multiple days (up to `historyDays` from config)
   * and returns them **newest-day-first** with date separators, for full
   * context restoration. The newest-first day ordering is a contract covered
   * by the "#1863 aggregate history" regression test.
   *
   * Truncation: each day file is appended chronologically (oldest at the top,
   * newest at the bottom), so the most recent messages sit at the END of the
   * newest day's content. When the total exceeds `maxLength`, we keep the most
   * recent days in full and — if budget remains — the NEWEST tail of the
   * next-older day, never its oldest messages. A marker is appended whenever
   * any older history is dropped, so truncation is never silent.
   *
   * Truncation is centralised here. Downstream consumers (history-manager,
   * feishu `getChatHistoryContext`) must NOT re-truncate the result — doing so
   * would reintroduce the inverted-direction bug.
   *
   * Issue #1863 Fix: Previously only read the most recent day's log, causing
   * cross-day conversation history to be truncated.
   * Issue #4171 Fix: Truncation previously kept the oldest day's tail and
   * discarded all recent history (inverted direction).
   *
   * @param chatId - Platform-specific chat identifier
   * @param maxLengthOverride - Optional char budget; defaults to
   *   `sessionRestoreConfig.maxContextLength`. Lets callers that want a larger
   *   budget (e.g. feishu's `CHAT_HISTORY.MAX_CONTEXT_LENGTH`) opt in instead of
   *   being silently capped at the session default.
   * @returns Concatenated chat history or undefined if no history found
   */
  async getChatHistory(
    chatId: string,
    maxLengthOverride?: number,
  ): Promise<string | undefined> {
    try {
      const sessionConfig = Config.getSessionRestoreConfig();
      const maxDays = sessionConfig.historyDays;
      const maxLength = maxLengthOverride ?? sessionConfig.maxContextLength;

      const entries = await fs.readdir(this.chatDir, { withFileTypes: true });

      // Filter to date directories, sorted descending (newest first)
      const dateDirs = entries
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .sort((a, b) => b.name.localeCompare(a.name));

      // Collect day segments oldest-first (iterate the newest-first list in
      // reverse). Each file is appended chronologically, so within a segment
      // the newest messages are at the END of `content`.
      const segments: { date: string; content: string }[] = [];
      for (let i = Math.min(dateDirs.length, maxDays) - 1; i >= 0; i--) {
        const dir = dateDirs[i];
        const logPath = path.join(this.chatDir, dir.name, `${chatId}.md`);
        try {
          const content = await fs.readFile(logPath, 'utf-8');
          const trimmed = content.trim();
          if (trimmed) {
            segments.push({ date: dir.name, content: trimmed });
          }
        } catch {
          // File doesn't exist for this day, continue
        }
      }

      if (segments.length === 0) {
        return undefined;
      }

      return this.renderHistorySegments(segments, maxLength);
    } catch {
      return undefined;
    }
  }

  /**
   * Render day segments newest-first, keeping only the most recent `maxLength`
   * characters. See `getChatHistory` for the recency rationale.
   *
   * `segments` is oldest-first; each `content` is oldest→newest internally.
   * Output is newest-first with a `\n--- *<date>* ---\n\n` separator before each
   * older day — byte-identical to the legacy output when nothing is truncated.
   */
  private renderHistorySegments(
    segments: { date: string; content: string }[],
    maxLength: number,
  ): string {
    const separator = (date: string): string => `\n--- *${date}* ---\n\n`;
    // Render newest-first. The first (newest) segment has no separator.
    const render = (segs: { date: string; content: string }[]): string => {
      const parts: string[] = [];
      for (const seg of segs) {
        if (parts.length > 0) {
          parts.push(separator(seg.date));
        }
        parts.push(seg.content);
      }
      return parts.join('\n');
    };

    // Greedily include full days from the newest backward, so the most recent
    // messages always survive. `kept` stays newest-first.
    const kept: { date: string; content: string }[] = [];
    let truncated = false;
    for (let i = segments.length - 1; i >= 0; i--) {
      const candidate = [...kept, segments[i]]; // older day renders last
      if (render(candidate).length <= maxLength) {
        kept.push(segments[i]);
        continue;
      }
      // This older day does not fit in full. Keep its NEWEST tail (the most
      // recent messages of that day) if any budget remains, then stop.
      truncated = true;
      const remaining = maxLength - render(kept).length;
      const overhead = kept.length > 0 ? separator(segments[i].date).length + 2 : 0;
      const contentBudget = remaining - overhead;
      if (contentBudget > 0) {
        const c = segments[i].content;
        kept.push({ date: segments[i].date, content: c.slice(c.length - contentBudget) });
      }
      break;
    }

    let result = render(kept);
    if (truncated) {
      result += '\n\n_(…older history truncated; see chat log files for the full conversation)_';
    }
    return result;
  }

  /**
   * Get chat log file paths for a given chatId.
   *
   * Returns the list of log file absolute paths that exist on disk,
   * sorted newest-first, up to `historyDays` from session restore config.
   *
   * Issue #3996: Used to inform the agent where chat log files are stored,
   * so it can Read them to access conversation history beyond context window.
   *
   * @param chatId - Platform-specific chat identifier
   * @returns Array of absolute file paths to chat log files
   */
  async getChatLogFilePaths(chatId: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.chatDir, { withFileTypes: true });

      const dateDirs = entries
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .sort((a, b) => b.name.localeCompare(a.name));

      const maxDays = Config.getSessionRestoreConfig().historyDays;
      const paths: string[] = [];

      for (let i = 0; i < Math.min(dateDirs.length, maxDays); i++) {
        const dir = dateDirs[i];
        const logPath = path.join(this.chatDir, dir.name, `${chatId}.md`);
        try {
          await fs.access(logPath);
          paths.push(logPath);
        } catch {
          // File doesn't exist for this day, continue
        }
      }

      return paths;
    } catch {
      return [];
    }
  }

  /**
   * Clear all cached message IDs (for testing).
   */
  clearCache(): void {
    this.processedMessageIds.clear();
  }

  private async appendToLog(entry: LogEntry): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    const dateStr = getDateString();
    const dateDir = path.join(this.chatDir, dateStr);
    await fs.mkdir(dateDir, { recursive: true });

    const logPath = path.join(dateDir, `${entry.chatId}.md`);
    const timestamp = typeof entry.timestamp === 'number'
      ? new Date(entry.timestamp).toISOString()
      : entry.timestamp;

    const direction = entry.direction === 'incoming' ? '👤' : '🤖';
    const logLine = `${direction} [${timestamp}] (${entry.messageId})\n${entry.content}\n\n---\n\n`;

    await fs.appendFile(logPath, logLine);
  }
}

// Singleton instance
export const messageLogger = new MessageLogger();
