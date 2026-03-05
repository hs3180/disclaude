/**
 * Message logger for persistent message history.
 *
 * Logs all user and bot messages to chat-specific MD files.
 * Uses date-based directory structure: {YYYY-MM-DD}/{chatId}.md
 * Provides message ID-based deduplication via in-memory cache only.
 */

import fs from 'fs/promises';
import path from 'path';
import { Config } from '../config/index.js';
import { MESSAGE_LOGGING } from '../config/constants.js';

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

export class MessageLogger {
  private chatDir: string;

  // In-memory cache for immediate deduplication (no size limit)
  // Only tracks message IDs seen in current session
  private processedMessageIds = new Set<string>();
  private initialized = false;

  constructor() {
    const workspaceDir = Config.getWorkspaceDir();
    this.chatDir = path.join(workspaceDir, MESSAGE_LOGGING.LOGS_DIR);
    // Don't call initialize() in constructor - it's async and needs to be awaited
  }

  /**
   * Explicit initialization method that must be called and awaited before using the logger.
   * This ensures the chat directory exists and migrates legacy files.
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

      // Migrate legacy flat files to date-based structure
      await this.migrateLegacyFiles();
    } catch (error) {
      console.error('[MessageLogger] Failed to initialize:', error);
    }
  }

  /**
   * Migrate legacy flat files ({chatId}.md) and wrong structure ({chatId}/{date}.md)
   * to correct structure ({date}/{chatId}.md).
   */
  private async migrateLegacyFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.chatDir, { withFileTypes: true });

      // 1. Find legacy flat .md files (not in subdirectories)
      const legacyFiles = entries.filter(
        entry => entry.isFile() && entry.name.endsWith('.md')
      );

      if (legacyFiles.length > 0) {
        console.log(`[MessageLogger] Migrating ${legacyFiles.length} legacy flat files...`);

        const today = getDateString();

        for (const file of legacyFiles) {
          const legacyPath = path.join(this.chatDir, file.name);
          const chatId = file.name.replace('.md', '');

          // Create date directory
          const dateDir = path.join(this.chatDir, today);
          await fs.mkdir(dateDir, { recursive: true });

          // Move to new location
          const newPath = path.join(dateDir, `${this.sanitizeId(chatId)}.md`);
          await fs.rename(legacyPath, newPath);

          console.log(`[MessageLogger] Migrated ${file.name} -> ${today}/${chatId}.md`);
        }
      }

      // 2. Find wrong structure directories ({chatId}/{date}.md) and migrate
      const wrongDirs = entries.filter(
        entry => entry.isDirectory() && !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)
      );

      if (wrongDirs.length > 0) {
        console.log(`[MessageLogger] Migrating ${wrongDirs.length} wrong structure directories...`);

        for (const dir of wrongDirs) {
          const dirPath = path.join(this.chatDir, dir.name);
          const subEntries = await fs.readdir(dirPath, { withFileTypes: true });

          for (const subFile of subEntries) {
            if (subFile.isFile() && subFile.name.endsWith('.md')) {
              // Extract date from filename (e.g., "2026-03-05.md" -> "2026-03-05")
              const dateMatch = subFile.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
              if (dateMatch) {
                const dateStr = dateMatch[1];
                const chatId = dir.name;

                const oldPath = path.join(dirPath, subFile.name);
                const dateDir = path.join(this.chatDir, dateStr);
                await fs.mkdir(dateDir, { recursive: true });

                const newPath = path.join(dateDir, `${this.sanitizeId(chatId)}.md`);

                // Check if target already exists
                try {
                  await fs.access(newPath);
                  // Target exists, append content instead of rename
                  const oldContent = await fs.readFile(oldPath, 'utf-8');
                  await fs.appendFile(newPath, '\n\n' + oldContent, 'utf-8');
                  await fs.unlink(oldPath);
                  console.log(`[MessageLogger] Merged ${chatId}/${subFile.name} -> ${dateStr}/${chatId}.md`);
                } catch {
                  // Target doesn't exist, just rename
                  await fs.rename(oldPath, newPath);
                  console.log(`[MessageLogger] Migrated ${chatId}/${subFile.name} -> ${dateStr}/${chatId}.md`);
                }
              }
            }
          }

          // Remove empty directory
          try {
            const remaining = await fs.readdir(dirPath);
            if (remaining.length === 0) {
              await fs.rmdir(dirPath);
              console.log(`[MessageLogger] Removed empty directory: ${dir.name}`);
            }
          } catch {
            // Directory not empty or already removed
          }
        }
      }
    } catch (_error) {
      // Directory doesn't exist or migration failed, that's fine
      console.log('[MessageLogger] No legacy files to migrate');
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
    timestamp?: string | number
  ): Promise<void> {
    const entry: LogEntry = {
      messageId,
      senderId: 'bot',
      chatId,
      content,
      messageType: 'text',
      timestamp: timestamp || Date.now(),
      direction: 'outgoing',
    };

    await this.appendToLog(entry);

    // Add to in-memory cache
    this.processedMessageIds.add(messageId);
  }

  /**
   * Check if message was already processed.
   * Uses in-memory cache only (no file reading).
   */
  isMessageProcessed(messageId: string): boolean {
    return this.processedMessageIds.has(messageId);
  }

  /**
   * Get chat log file path for a specific date.
   * Structure: {chatDir}/{YYYY-MM-DD}/{chatId}.md
   */
  private getChatLogPath(chatId: string, date: Date = new Date()): string {
    const sanitizedId = this.sanitizeId(chatId);
    const dateStr = getDateString(date);
    return path.join(this.chatDir, dateStr, `${sanitizedId}.md`);
  }

  /**
   * Sanitize ID for use as filename.
   */
  private sanitizeId(id: string): string {
    // Replace special characters with underscores
    return id.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * Format message entry as Markdown.
   */
  private formatMessageEntry(entry: LogEntry): string {
    const timestamp =
      typeof entry.timestamp === 'number'
        ? new Date(entry.timestamp).toISOString()
        : entry.timestamp;

    // Use emoji to distinguish message direction
    const emoji = entry.direction === 'incoming' ? '📥' : '📤';
    const direction = entry.direction === 'incoming' ? 'User' : 'Bot';

    return `

## [${timestamp}] ${emoji} ${direction} (message_id: ${entry.messageId})

**Sender**: ${entry.senderId}
**Type**: ${entry.messageType}

${entry.content}

---

`;
  }

  /**
   * Append message to chat log file.
   */
  private async appendToLog(entry: LogEntry): Promise<void> {
    const logPath = this.getChatLogPath(entry.chatId);

    try {
      // Ensure directory exists (defensive check in case it was deleted)
      const logDir = path.dirname(logPath);
      try {
        await fs.mkdir(logDir, { recursive: true });
      } catch (mkdirError) {
        // If mkdir fails, try once more and then give up
        console.error('[MessageLogger] First attempt to create directory failed, retrying...', {
          error: (mkdirError as Error).message,
          logDir,
        });
        await fs.mkdir(logDir, { recursive: true });
      }

      // Check if file exists
      let fileExists = false;
      try {
        await fs.access(logPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (!fileExists) {
        // Create new file with header
        const header = this.createFileHeader(entry.chatId);
        await fs.writeFile(logPath, header + this.formatMessageEntry(entry), 'utf-8');
      } else {
        // Append to existing file
        await fs.appendFile(logPath, this.formatMessageEntry(entry), 'utf-8');
      }
    } catch (error) {
      // Log error but don't throw - allow message processing to continue
      // Logging failure should not block the bot from responding
      const err = error as Error & { code?: string; path?: string };
      console.error('[MessageLogger] Failed to append to log:', {
        message: err.message,
        code: err.code,
        path: err.path,
        chatId: entry.chatId,
      });
    }
  }

  /**
   * Create file header for new log files.
   */
  private createFileHeader(chatId: string): string {
    const now = new Date();
    const dateStr = getDateString(now);
    const isoStr = now.toISOString();
    return `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Date**: ${dateStr}
**Created**: ${isoStr}
**Last Updated**: ${isoStr}

---

`;
  }

  /**
   * Get message history for a chat, reading from the last N days.
   * @param chatId Chat ID
   * @param days Number of days to look back (default: 7)
   */
  async getChatHistory(chatId: string, days: number = 7): Promise<string> {
    const contents: string[] = [];

    try {
      // Read logs from the last N days
      for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const logPath = this.getChatLogPath(chatId, date);

        try {
          const content = await fs.readFile(logPath, 'utf-8');
          if (content.trim()) {
            contents.push(content);
          }
        } catch {
          // File doesn't exist for this day, continue
        }
      }

      // Reverse to get chronological order (oldest first)
      return contents.reverse().join('\n\n');
    } catch (_error) {
      return '';
    }
  }

  /**
   * Clear in-memory cache (useful for testing).
   */
  clearCache(): void {
    this.processedMessageIds.clear();
  }
}

// Singleton instance
export const messageLogger = new MessageLogger();
