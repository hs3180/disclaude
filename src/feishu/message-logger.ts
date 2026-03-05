/**
 * Message logger for persistent message history.
 *
 * Logs all user and bot messages to chat-specific MD files.
 * Provides message ID-based deduplication by parsing MD files.
 * Replaces in-memory MessageHistoryManager and task directory deduplication.
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

export class MessageLogger {
  private chatDir: string;

  // In-memory cache for immediate deduplication (no size limit)
  // Loaded at startup from all existing MD files
  private processedMessageIds = new Set<string>();
  private initialized = false;

  constructor() {
    const workspaceDir = Config.getWorkspaceDir();
    this.chatDir = path.join(workspaceDir, MESSAGE_LOGGING.LOGS_DIR);
    // Don't call initialize() in constructor - it's async and needs to be awaited
  }

  /**
   * Explicit initialization method that must be called and awaited before using the logger.
   * This ensures the chat directory exists and message IDs are loaded.
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

      // Load all existing message IDs from MD files at startup
      await this.loadAllMessageIds();
    } catch (error) {
      console.error('[MessageLogger] Failed to initialize:', error);
    }
  }

  /**
   * Load all message IDs from existing MD files at startup.
   * Only loads from recent days (configurable via MESSAGE_LOGGING.DEDUP_DAYS).
   * Structure: {chatDir}/{date}/{chatId}.md
   */
  private async loadAllMessageIds(): Promise<void> {
    try {
      // Get list of date directories
      const entries = await fs.readdir(this.chatDir, { withFileTypes: true });
      const dateDirs = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name));

      // Calculate cutoff date for deduplication
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - MESSAGE_LOGGING.DEDUP_DAYS);
      const cutoffStr = this.formatDate(cutoffDate);

      // Filter to only recent directories
      const recentDirs = dateDirs.filter(d => d.name >= cutoffStr).map(d => d.name);

      console.log(`[MessageLogger] Loading message IDs from ${recentDirs.length} recent date directories...`);

      for (const dateDir of recentDirs) {
        const datePath = path.join(this.chatDir, dateDir);
        try {
          const files = await fs.readdir(datePath);
          const mdFiles = files.filter(f => f.endsWith('.md'));

          for (const file of mdFiles) {
            const filePath = path.join(datePath, file);
            try {
              const content = await fs.readFile(filePath, 'utf-8');
              const regex = MESSAGE_LOGGING.MD_PARSE_REGEX;

              let match;
              regex.lastIndex = 0;
              while ((match = regex.exec(content)) !== null) {
                this.processedMessageIds.add(match[1].trim());
              }
            } catch (_error) {
              console.error(`[MessageLogger] Failed to read ${dateDir}/${file}:`, _error);
            }
          }
        } catch (_error) {
          console.error(`[MessageLogger] Failed to read directory ${dateDir}:`, _error);
        }
      }

      console.log(`[MessageLogger] Loaded ${this.processedMessageIds.size} message IDs into memory`);
    } catch (_error) {
      // Directory doesn't exist yet, that's fine
      console.log('[MessageLogger] No existing chat files found, starting fresh');
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
   * All message IDs are loaded at startup, so this is just an in-memory lookup.
   */
  isMessageProcessed(messageId: string): boolean {
    return this.processedMessageIds.has(messageId);
  }

  /**
   * Get chat log file path.
   * Structure: {chatDir}/{date}/{chatId}.md
   * Example: workspace/chat/2026-03-05/oc_abc123.md
   */
  private getChatLogPath(chatId: string, date?: Date): string {
    const sanitizedId = this.sanitizeId(chatId);
    const dateStr = this.formatDate(date || new Date());
    return path.join(this.chatDir, dateStr, `${sanitizedId}.md`);
  }

  /**
   * Format date as YYYY-MM-DD string.
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
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
    const now = new Date().toISOString();
    const dateStr = this.formatDate(new Date());
    return `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Date**: ${dateStr}
**Created**: ${now}
**Last Updated**: ${now}

---

`;
  }

  /**
   * Get message history for a chat from recent days.
   * Reads from multiple date directories and combines them.
   * @param chatId The chat ID to get history for
   * @param days Number of days to look back (default: MESSAGE_LOGGING.HISTORY_DAYS)
   */
  async getChatHistory(chatId: string, days?: number): Promise<string> {
    const lookbackDays = days ?? MESSAGE_LOGGING.HISTORY_DAYS;
    const sanitizedId = this.sanitizeId(chatId);
    const historyParts: string[] = [];

    // Collect history from most recent to oldest
    for (let i = 0; i < lookbackDays; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = this.formatDate(date);
      const logPath = path.join(this.chatDir, dateStr, `${sanitizedId}.md`);

      try {
        const content = await fs.readFile(logPath, 'utf-8');
        if (content.trim()) {
          historyParts.push(`\n\n## [${dateStr}]\n\n${content}`);
        }
      } catch {
        // File doesn't exist for this date, skip
      }
    }

    // Reverse to get chronological order (oldest first)
    return historyParts.reverse().join('\n');
  }

  /**
   * Clear in-memory cache (useful for testing).
   * Note: This will require a restart to reload message IDs from MD files.
   */
  clearCache(): void {
    this.processedMessageIds.clear();
  }
}

// Singleton instance
export const messageLogger = new MessageLogger();
