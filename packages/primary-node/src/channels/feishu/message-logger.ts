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
 * Message logger class for Feishu channel.
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
   * Issue #1863: Aggregates chat logs across multiple days (up to
   * Config.getSessionRestoreConfig().historyDays, default 7).
   * Returns logs in chronological order (oldest first), truncated
   * to maxContextLength from the beginning to preserve recent context.
   */
  async getChatHistory(chatId: string): Promise<string | undefined> {
    try {
      const sessionConfig = Config.getSessionRestoreConfig();
      const { historyDays, maxContextLength } = sessionConfig;

      // Find all date directories
      const entries = await fs.readdir(this.chatDir, { withFileTypes: true });

      // Filter to date directories, sort ascending (oldest first) for chronological order
      const dateDirs = entries
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(-historyDays); // Take the most recent N days

      // Read and aggregate log contents
      const contents: string[] = [];
      for (const dir of dateDirs) {
        const logPath = path.join(this.chatDir, dir.name, `${chatId}.md`);
        try {
          const content = await fs.readFile(logPath, 'utf-8');
          if (content.trim()) {
            contents.push(content);
          }
        } catch {
          // File doesn't exist for this date, try next directory
        }
      }

      if (contents.length === 0) {
        return undefined;
      }

      // Concatenate in chronological order
      const combined = contents.join('\n---\n\n');

      // Truncate from the beginning to preserve recent context
      if (combined.length > maxContextLength) {
        return combined.slice(-maxContextLength);
      }

      return combined;
    } catch {
      return undefined;
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
