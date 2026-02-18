/**
 * File Handler for Feishu/Lark bot.
 *
 * Handles file and image message processing:
 * - Download files from Feishu
 * - Store locally for agent processing
 * - Build upload notification prompts
 */
import type { FileAttachment } from './attachment-manager.js';
import { createLogger } from '../utils/logger.js';

export interface FileHandlerResult {
  success: boolean;
  filePath?: string;
  fileKey?: string;
}

/**
 * File handler processes file/image messages from Feishu.
 */
export class FileHandler {
  private logger = createLogger('FileHandler');

  constructor(
    private attachmentManager: {
      hasAttachments(chatId: string): boolean;
      getAttachments(chatId: string): FileAttachment[];
      addAttachment(chatId: string, attachment: FileAttachment): void;
      clearAttachments(chatId: string): void;
    },
    private downloadFile: (
      fileKey: string,
      messageType: string,
      fileName?: string,
      messageId?: string
    ) => Promise<{ success: boolean; filePath?: string }>
  ) {}

  /**
   * Handle file/image message - download and store for later processing.
   *
   * @param chatId - Chat ID
   * @param messageType - 'image' | 'file' | 'media'
   * @param content - Parsed content JSON string
   * @param messageId - Message ID for deduplication
   * @returns Processing result
   */
  async handleFileMessage(
    chatId: string,
    messageType: 'image' | 'file' | 'media',
    content: string,
    messageId: string
  ): Promise<FileHandlerResult> {
    try {
      this.logger.info({ chatId, messageType, messageId }, 'File/image message received');

      // Extract file_key from content based on message type
      let fileKey: string | undefined;
      let fileName: string | undefined;

      if (messageType === 'image') {
        // Image message content: {"image_key":"..."}
        const parsed = JSON.parse(content);
        fileKey = parsed.image_key;
        fileName = `image_${fileKey}`;
      } else if (messageType === 'file' || messageType === 'media') {
        // File message content: {"file_key":"...","file_name":"..."}
        const parsed = JSON.parse(content);
        fileKey = parsed.file_key;
        fileName = parsed.file_name;
      }

      if (!fileKey) {
        this.logger.warn({ messageType, content }, 'No file_key found in content');
        return { success: false };
      }

      // Download file to local storage
      const downloadResult = await this.downloadFile(fileKey, messageType, fileName, messageId);
      if (!downloadResult.success || !downloadResult.filePath) {
        this.logger.error({ fileKey }, 'Failed to download file');
        return { success: false };
      }

      this.logger.info({ fileKey, filePath: downloadResult.filePath }, 'File downloaded successfully');

      // Store attachment metadata
      const attachment: FileAttachment = {
        fileKey,
        fileName: fileName || fileKey,
        localPath: downloadResult.filePath,
        fileType: messageType,
        messageId,
        timestamp: Date.now(),
      };

      this.attachmentManager.addAttachment(chatId, attachment);

      return {
        success: true,
        filePath: downloadResult.filePath,
        fileKey,
      };
    } catch (error) {
      this.logger.error({ err: error, chatId, messageType }, 'Error handling file message');
      return { success: false };
    }
  }

  /**
   * Build a structured prompt for file upload notification.
   *
   * This creates a special prompt format that includes file metadata
   * in a structured way, making it easier for the Pilot agent to understand
   * and process uploaded files.
   *
   * @param attachment - File attachment metadata
   * @returns Structured prompt string
   */
  buildUploadPrompt(attachment: FileAttachment): string {
    const lines: string[] = [];

    // Header with special marker for file uploads
    lines.push('🔔 SYSTEM: User uploaded a file');
    lines.push('');

    // Structured metadata block
    lines.push('```file_metadata');
    lines.push(`file_name: ${attachment.fileName || 'unknown'}`);
    lines.push(`file_type: ${attachment.fileType}`);
    lines.push(`file_key: ${attachment.fileKey}`);

    if (attachment.localPath) {
      lines.push(`local_path: ${attachment.localPath}`);
    }

    if (attachment.fileSize) {
      const sizeMB = (attachment.fileSize / 1024 / 1024).toFixed(2);
      lines.push(`file_size_mb: ${sizeMB}`);
    }

    if (attachment.mimeType) {
      lines.push(`mime_type: ${attachment.mimeType}`);
    }

    lines.push('```');
    lines.push('');

    // Context for the agent
    lines.push('The user has uploaded a file. It is now available at the local path above.');
    lines.push('');
    lines.push('Please wait for the user\'s instructions on how to process this file.');

    return lines.join('\n');
  }

  /**
   * Send file upload notification to user via Pilot.
   *
   * @param chatId - Chat ID
   * @param attachment - File attachment metadata
   */
  notifyFileUpload(chatId: string, attachment: FileAttachment): void {
    // @ts-expect-error - Variable kept for future use
    const _prompt = this.buildUploadPrompt(attachment);

    // Send to Pilot which will enqueue the message
    // The Pilot is injected from bot.ts, so we'll handle this differently
    this.logger.debug({ chatId, fileKey: attachment.fileKey }, 'File upload notification prepared');
  }
}
