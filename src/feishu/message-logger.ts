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
   * One-time operation to populate the in-memory cache.
   */
  private async loadAllMessageIds(): Promise<void> {
    try {
      const files = await fs.readdir(this.chatDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      console.log(`[MessageLogger] Loading message IDs from ${mdFiles.length} chat files...`);

      for (const file of mdFiles) {
        const filePath = path.join(this.chatDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const regex = MESSAGE_LOGGING.MD_PARSE_REGEX;

          let match;
          regex.lastIndex = 0;
          while ((match = regex.exec(content)) !== null) {
            this.processedMessageIds.add(match[1].trim());
          }
        } catch (error) {
          console.error(`[MessageLogger] Failed to read ${file}:`, error);
        }
      }

      console.log(`[MessageLogger] Loaded ${this.processedMessageIds.size} message IDs into memory`);
    } catch (error) {
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
   */
  private getChatLogPath(chatId: string): string {
    const sanitizedId = this.sanitizeId(chatId);
    return path.join(this.chatDir, `${sanitizedId}.md`);
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

    const direction = entry.direction === 'incoming' ? 'Incoming' : 'Outgoing';

    return `

## [${timestamp}] ${direction} (message_id: ${entry.messageId})

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
      console.error('[MessageLogger] Failed to append to log:', error);
      throw error;
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
   */
  async getChatHistory(chatId: string): Promise<string> {
    const logPath = this.getChatLogPath(chatId);

    try {
      return await fs.readFile(logPath, 'utf-8');
    } catch (error) {
      return '';
    }
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
