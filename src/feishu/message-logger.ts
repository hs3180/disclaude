/**
 * Message logger for persistent message history.
 *
 * Logs all user and bot messages to chat-specific MD files.
 * Provides message ID-based deduplication by parsing MD files.
 * Replaces in-memory MessageHistoryManager and task directory deduplication.
 *
 * Storage structure (Issue #691):
 * workspace/chat/{YYYY-MM-DD}/{chatId}.md
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
   * One-time operation to populate the in-memory cache.
   * Supports both new date-based structure and legacy flat structure.
   */
  private async loadAllMessageIds(): Promise<void> {
    try {
      const entries = await fs.readdir(this.chatDir, { withFileTypes: true });
      let totalFiles = 0;

      // Process date directories (YYYY-MM-DD format)
      const dateDirs = entries.filter(
        entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)
      );

      for (const dateDir of dateDirs) {
        const datePath = path.join(this.chatDir, dateDir.name);
        const files = await fs.readdir(datePath);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        totalFiles += mdFiles.length;

        for (const file of mdFiles) {
          const filePath = path.join(datePath, file);
          await this.loadMessageIdsFromFile(filePath);
        }
      }

      // Also check for legacy flat files (backward compatibility)
      const legacyMdFiles = entries.filter(
        entry => entry.isFile() && entry.name.endsWith('.md')
      );
      totalFiles += legacyMdFiles.length;

      for (const file of legacyMdFiles) {
        const filePath = path.join(this.chatDir, file.name);
        await this.loadMessageIdsFromFile(filePath);
      }

      console.log(`[MessageLogger] Loaded ${this.processedMessageIds.size} message IDs from ${totalFiles} files`);
    } catch (_error) {
      // Directory doesn't exist yet, that's fine
      console.log('[MessageLogger] No existing chat files found, starting fresh');
    }
  }

  /**
   * Load message IDs from a single file.
   */
  private async loadMessageIdsFromFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const regex = MESSAGE_LOGGING.MD_PARSE_REGEX;

      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(content)) !== null) {
        this.processedMessageIds.add(match[1].trim());
      }
    } catch (_error) {
      console.error(`[MessageLogger] Failed to read ${filePath}:`, _error);
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
   * Get chat log file path for a specific date.
   * Structure: workspace/chat/{YYYY-MM-DD}/{chatId}.md
   */
  private getChatLogPath(chatId: string, timestamp?: string | number): string {
    const sanitizedId = this.sanitizeId(chatId);
    const dateDir = this.getDateDir(timestamp);
    return path.join(this.chatDir, dateDir, `${sanitizedId}.md`);
  }

  /**
   * Get date directory name from timestamp.
   * Format: YYYY-MM-DD
   */
  private getDateDir(timestamp?: string | number): string {
    const date = timestamp
      ? new Date(typeof timestamp === 'number' ? timestamp : timestamp)
      : new Date();

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
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
    const logPath = this.getChatLogPath(entry.chatId, entry.timestamp);

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
    return `# Chat Message Log: ${chatId}

**Chat ID**: ${chatId}
**Created**: ${now}
**Last Updated**: ${now}

---

`;
  }

  /**
   * Get message history for a chat.
   * Reads from the last N days of logs (default 7 days).
   * Supports both new date-based structure and legacy flat structure.
   */
  async getChatHistory(chatId: string, days: number = 7): Promise<string> {
    const sanitizedId = this.sanitizeId(chatId);
    const contents: string[] = [];

    // Collect logs from the last N days
    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateDir = this.getDateDir(date.getTime());
      const logPath = path.join(this.chatDir, dateDir, `${sanitizedId}.md`);

      try {
        const content = await fs.readFile(logPath, 'utf-8');
        if (content) {
          contents.push(content);
        }
      } catch {
        // File doesn't exist for this day, skip
      }
    }

    // Also check legacy flat file (backward compatibility)
    const legacyPath = path.join(this.chatDir, `${sanitizedId}.md`);
    try {
      const content = await fs.readFile(legacyPath, 'utf-8');
      if (content) {
        contents.push(content);
      }
    } catch {
      // Legacy file doesn't exist, skip
    }

    // Join all contents (newest first)
    return contents.join('\n\n');
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
