/**
 * Attachment manager for Feishu/Lark bot.
 *
 * Stores pending file attachments per chat in memory.
 * When a user sends an image or file, it's downloaded immediately
 * but held here until the user sends a text command.
 *
 * Storage structure:
 * - chatId -> FileAttachment[]
 *
 * Files are cleared after being processed with a text message.
 */

/**
 * File attachment metadata.
 */
export interface FileAttachment {
  /** Feishu file_key for downloading */
  fileKey: string;
  /** File type (image, file, etc.) */
  fileType: string;
  /** Original filename */
  fileName?: string;
  /** Local file path after download */
  localPath?: string;
  /** MIME type if available */
  mimeType?: string;
  /** File size in bytes if available */
  fileSize?: number;
  /** Timestamp when received */
  timestamp: number;
  /** Message ID containing this file (required for downloading user uploads) */
  messageId?: string;
}

/**
 * Attachment manager for in-memory storage of pending files.
 */
export class AttachmentManager {
  // Map of chatId to pending attachments
  private attachments = new Map<string, FileAttachment[]>();

  /**
   * Add attachment to a chat.
   */
  addAttachment(chatId: string, attachment: FileAttachment): void {
    const current = this.attachments.get(chatId) || [];
    current.push(attachment);
    this.attachments.set(chatId, current);
  }

  /**
   * Get all attachments for a chat.
   */
  getAttachments(chatId: string): FileAttachment[] {
    return this.attachments.get(chatId) || [];
  }

  /**
   * Clear all attachments for a chat after processing.
   */
  clearAttachments(chatId: string): void {
    this.attachments.delete(chatId);
  }

  /**
   * Check if a chat has pending attachments.
   */
  hasAttachments(chatId: string): boolean {
    const attachments = this.attachments.get(chatId);
    return attachments !== undefined && attachments.length > 0;
  }

  /**
   * Get count of pending attachments for a chat.
   */
  getAttachmentCount(chatId: string): number {
    return this.getAttachments(chatId).length;
  }

  /**
   * Format attachment information for inclusion in agent prompt.
   * Returns a formatted string describing all pending attachments.
   */
  formatAttachmentsForPrompt(chatId: string): string {
    const attachments = this.getAttachments(chatId);

    if (attachments.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('');
    lines.push('--- 📎 Attached Files ---');

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      lines.push(`${i + 1}. ${att.fileName || att.fileKey}`);
      lines.push(`   Type: ${att.fileType}`);

      if (att.localPath) {
        lines.push(`   Local path: ${att.localPath}`);
      }

      if (att.fileSize) {
        const sizeMB = (att.fileSize / 1024 / 1024).toFixed(2);
        lines.push(`   Size: ${sizeMB} MB`);
      }

      if (att.mimeType) {
        lines.push(`   MIME type: ${att.mimeType}`);
      }

      lines.push('');
    }

    lines.push('-------------------------');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Clean up old attachments to prevent memory leaks.
   * Removes attachments older than the specified age.
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   */
  cleanupOldAttachments(maxAgeMs: number = 60 * 60 * 1000): void {
    const now = Date.now();
    const chatsToClean: string[] = [];

    for (const [chatId, attachments] of this.attachments.entries()) {
      const filtered = attachments.filter(att => {
        const age = now - att.timestamp;
        return age < maxAgeMs;
      });

      if (filtered.length === 0) {
        chatsToClean.push(chatId);
      } else if (filtered.length < attachments.length) {
        this.attachments.set(chatId, filtered);
      }
    }

    // Remove chats with no valid attachments
    for (const chatId of chatsToClean) {
      this.attachments.delete(chatId);
    }
  }
}

/**
 * Global attachment manager instance.
 */
export const attachmentManager = new AttachmentManager();
