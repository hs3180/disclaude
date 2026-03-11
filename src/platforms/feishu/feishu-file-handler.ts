/**
 * Feishu File Handler Implementation.
 *
 * Implements IFileHandler interface for Feishu/Lark platform.
 * Handles file download and processing from Feishu messages.
 */

import { createLogger } from '../../utils/logger.js';
import type {
  IFileHandler,
  FileAttachment,
  FileHandlerResult,
  IAttachmentManager,
} from '@disclaude/core';

const logger = createLogger('FeishuFileHandler');

/**
 * File download function type.
 */
export type FileDownloadFunction = (
  fileKey: string,
  messageType: string,
  fileName?: string,
  messageId?: string,
  parentId?: string
) => Promise<{ success: boolean; filePath?: string }>;

/**
 * Feishu File Handler Configuration.
 */
export interface FeishuFileHandlerConfig {
  /** Attachment manager for storing file metadata */
  attachmentManager: IAttachmentManager;
  /** File download function */
  downloadFile: FileDownloadFunction;
}

/**
 * Feishu File Handler.
 *
 * Implements platform-agnostic IFileHandler interface for Feishu.
 */
export class FeishuFileHandler implements IFileHandler {
  private attachmentManager: IAttachmentManager;
  private downloadFile: FileDownloadFunction;

  constructor(config: FeishuFileHandlerConfig) {
    this.attachmentManager = config.attachmentManager;
    this.downloadFile = config.downloadFile;
  }

  async handleFileMessage(
    chatId: string,
    messageType: 'image' | 'file' | 'media',
    content: string,
    messageId: string,
    parentId?: string
  ): Promise<FileHandlerResult> {
    try {
      logger.info({ chatId, messageType, messageId }, 'File/image message received');

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
        logger.warn({ messageType, content }, 'No file_key found in content');
        return { success: false, error: 'No file_key found' };
      }

      // Issue #1205: Log the complete message_id + file_key pairing for debugging
      // This helps identify mismatch issues between the message containing the file
      // and the file_key being downloaded
      // Issue #1290: Also log parentId for quoted/forwarded images
      logger.info(
        {
          chatId,
          messageType,
          messageId,
          parentId,
          fileKey,
          fileName,
          pairing: `message_id=${messageId} + file_key=${fileKey}`,
        },
        'Starting file download with message_id + file_key pairing'
      );

      // Download file to local storage
      // Issue #1290: Pass parentId for quoted/forwarded image fallback
      const downloadResult = await this.downloadFile(fileKey, messageType, fileName, messageId, parentId);
      if (!downloadResult.success || !downloadResult.filePath) {
        const errorDetail = downloadResult.filePath ? 'Download returned success but no path' : 'Download failed';
        logger.error(
          { fileKey, messageType, fileName, downloadResult, errorDetail },
          'Failed to download file - detailed error'
        );
        return { success: false, error: `${errorDetail} (fileKey: ${fileKey})` };
      }

      logger.info({ fileKey, filePath: downloadResult.filePath }, 'File downloaded successfully');

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
      logger.error({ err: error, chatId, messageType }, 'Error handling file message');
      return { success: false, error: String(error) };
    }
  }

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
    lines.push("Please wait for the user's instructions on how to process this file.");

    return lines.join('\n');
  }
}
