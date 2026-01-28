import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';

/**
 * Task tracker for persisting message processing records to disk.
 * Provides dual-layer deduplication: in-memory + file-based.
 */
export class TaskTracker {
  private tasksDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.tasksDir = path.join(baseDir, 'tasks');
  }

  /**
   * Ensure tasks directory exists.
   */
  async ensureTasksDir(): Promise<void> {
    try {
      await fs.mkdir(this.tasksDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create tasks directory:', error);
    }
  }

  /**
   * Get file path for a task record.
   */
  getTaskFilePath(messageId: string): string {
    // Sanitize message_id to make it a valid filename
    // Replace characters that are invalid in filenames
    const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, `${sanitized}.md`);
  }

  /**
   * Check if a task record exists on disk.
   */
  async hasTaskRecord(messageId: string): Promise<boolean> {
    try {
      const filePath = this.getTaskFilePath(messageId);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save task processing record to disk (asynchronous).
   * @param messageId - Unique message identifier
   * @param metadata - Message metadata (chat_id, sender, timestamp, etc.)
   * @param content - Bot response content (what was sent to user)
   */
  async saveTaskRecord(
    messageId: string,
    metadata: {
      chatId: string;
      senderType?: string;
      senderId?: string;
      text: string;
      timestamp?: string;
    },
    content: string
  ): Promise<void> {
    await this.ensureTasksDir();

    const filePath = this.getTaskFilePath(messageId);
    const timestamp = metadata.timestamp || new Date().toISOString();

    // Format content as Markdown
    const markdown = this.formatTaskRecord(messageId, metadata, content, timestamp);

    try {
      await fs.writeFile(filePath, markdown, 'utf-8');
      console.log(`[Task saved] ${messageId} -> ${filePath}`);
    } catch (error) {
      console.error(`[Task save failed] ${messageId}:`, error);
    }
  }

  /**
   * Save task processing record to disk (synchronous).
   * Use this for critical messages (like restart commands) to ensure the record is written
   * before the process terminates.
   * @param messageId - Unique message identifier
   * @param metadata - Message metadata (chat_id, sender, timestamp, etc.)
   * @param content - Bot response content (what was sent to user)
   */
  saveTaskRecordSync(
    messageId: string,
    metadata: {
      chatId: string;
      senderType?: string;
      senderId?: string;
      text: string;
      timestamp?: string;
    },
    content: string
  ): void {
    // Ensure directory exists synchronously
    const dirExists = syncFs.existsSync(this.tasksDir);
    if (!dirExists) {
      try {
        syncFs.mkdirSync(this.tasksDir, { recursive: true });
      } catch (error) {
        console.error('Failed to create tasks directory:', error);
        return;
      }
    }

    const filePath = this.getTaskFilePath(messageId);
    const timestamp = metadata.timestamp || new Date().toISOString();

    // Format content as Markdown
    const markdown = this.formatTaskRecord(messageId, metadata, content, timestamp);

    try {
      syncFs.writeFileSync(filePath, markdown, 'utf-8');
      console.log(`[Task saved sync] ${messageId} -> ${filePath}`);
    } catch (error) {
      console.error(`[Task save failed] ${messageId}:`, error);
    }
  }

  /**
   * Format task record as Markdown.
   */
  private formatTaskRecord(
    messageId: string,
    metadata: {
      chatId: string;
      senderType?: string;
      senderId?: string;
      text: string;
    },
    content: string,
    timestamp: string
  ): string {
    const lines = [
      `# Task Record: ${messageId}`,
      '',
      '**Metadata**',
      `- Message ID: ${messageId}`,
      `- Chat ID: ${metadata.chatId}`,
      `- Timestamp: ${timestamp}`,
      metadata.senderType ? `- Sender Type: ${metadata.senderType}` : '',
      metadata.senderId ? `- Sender ID: ${metadata.senderId}` : '',
      '',
      '**User Input**',
      '```',
      metadata.text,
      '```',
      '',
      '**Bot Response**',
      '```',
      content,
      '```',
    ].filter(line => line !== ''); // Remove empty lines from conditional fields

    return lines.join('\n');
  }
}
