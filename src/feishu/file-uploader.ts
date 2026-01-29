/**
 * Feishu file uploader - upload local files to Feishu cloud.
 *
 * Workflow:
 * 1. Upload file using im.file.create or im.image.create
 * 2. Get file_key from response
 * 3. Send message with file_key
 *
 * API References:
 * - https://open.feishu.cn/document/server-docs/im-v1/file/create
 * - https://open.feishu.cn/document/server-docs/im-v1/image/create
 * - https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

import * as fs from 'fs/promises';
import * as fsStream from 'fs';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FeishuFileUploader');

/** Supported file types for upload */
export type FileType = 'file' | 'image' | 'audio' | 'video';

/** Upload result with file_key */
export interface UploadResult {
  fileKey: string;
  fileType: FileType;
  fileName: string;
  fileSize: number;
}

/**
 * Detect file type from extension.
 *
 * @param filePath - Path to the file
 * @returns Detected file type
 */
export function detectFileType(filePath: string): FileType {
  const ext = filePath.toLowerCase().split('.').pop();

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'heic', 'tiff', 'tif'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma', 'amr'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'];

  if (ext && imageExts.includes(ext)) {
    return 'image';
  }
  if (ext && audioExts.includes(ext)) {
    return 'audio';
  }
  if (ext && videoExts.includes(ext)) {
    return 'video';
  }

  return 'file';
}

/**
 * Upload a local file to Feishu and return file_key.
 *
 * @param client - Lark SDK client
 * @param filePath - Local file path
 * @param chatId - Target chat ID (for error logging)
 * @returns Upload result with file_key
 * @throws Error if upload fails
 */
export async function uploadFile(
  client: lark.Client,
  filePath: string,
  chatId: string
): Promise<UploadResult> {
  try {
    // Get file stats
    const fileStats = await fs.stat(filePath);
    const fileName = path.basename(filePath);
    const fileType = detectFileType(filePath);

    logger.info({
      filePath,
      fileName,
      fileType,
      size: fileStats.size,
      chatId
    }, 'Uploading file to Feishu');

    let response: any;

    if (fileType === 'image') {
      // Use image upload API for images
      const fileBuffer = await fs.readFile(filePath);
      response = await client.im.image.create({
        data: {
          image: fileBuffer,
          image_type: 'message',
        },
      });
      logger.debug({ imageKey: response?.image_key }, 'Image uploaded');
    } else {
      // Use file upload API for other types
      // Note: file_type must be one of: 'mp4', 'opus', 'pdf', 'doc', 'xls', 'ppt', 'stream'
      const apiFileType = fileType === 'video' ? 'mp4' :
                         fileType === 'audio' ? 'opus' :
                         fileType === 'file' ? 'pdf' : 'pdf';

      // Create a readable stream for the file
      const fileStream = fsStream.createReadStream(filePath);

      response = await client.im.file.create({
        data: {
          file_type: apiFileType,
          file_name: fileName,
          file: fileStream,
        },
      });
      logger.debug({ fileKey: response?.file_key }, 'File uploaded');
    }

    // Extract file_key from response (different APIs use different field names)
    const fileKey = response?.image_key || response?.file_key;

    if (!fileKey) {
      throw new Error('No file_key returned from upload API');
    }

    logger.info({
      fileKey,
      fileName,
      fileType,
      size: fileStats.size
    }, 'File uploaded successfully to Feishu');

    return {
      fileKey,
      fileType,
      fileName,
      fileSize: fileStats.size,
    };

  } catch (error) {
    logger.error({
      err: error,
      filePath,
      chatId
    }, 'Failed to upload file to Feishu');
    throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Send file message to Feishu chat.
 *
 * @param client - Lark SDK client
 * @param chatId - Target chat ID
 * @param uploadResult - Upload result from uploadFile()
 * @throws Error if sending fails
 */
export async function sendFileMessage(
  client: lark.Client,
  chatId: string,
  uploadResult: UploadResult
): Promise<void> {
  try {
    // Build message type and content based on file type
    let msgType: string;
    let content: string;

    switch (uploadResult.fileType) {
      case 'image':
        msgType = 'image';
        content = JSON.stringify({
          image_key: uploadResult.fileKey,
        });
        break;

      case 'audio':
        msgType = 'audio';
        content = JSON.stringify({
          file_key: uploadResult.fileKey,
        });
        break;

      case 'video':
        msgType = 'video';
        content = JSON.stringify({
          file_key: uploadResult.fileKey,
        });
        break;

      default:
        msgType = 'file';
        content = JSON.stringify({
          file_key: uploadResult.fileKey,
        });
        break;
    }

    logger.debug({
      chatId,
      msgType,
      fileKey: uploadResult.fileKey,
      fileName: uploadResult.fileName
    }, 'Sending file message to Feishu');

    // Send message
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: msgType as any,
        content,
      },
    });

    logger.info({
      chatId,
      fileKey: uploadResult.fileKey,
      fileName: uploadResult.fileName,
      msgType
    }, 'File message sent successfully');

  } catch (error) {
    logger.error({
      err: error,
      chatId,
      fileKey: uploadResult.fileKey,
      fileName: uploadResult.fileName
    }, 'Failed to send file message');
    throw new Error(`Failed to send file message: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Complete workflow: upload file and send message.
 *
 * @param client - Lark SDK client
 * @param filePath - Local file path
 * @param chatId - Target chat ID
 * @returns File size in bytes
 * @throws Error if any step fails
 */
export async function uploadAndSendFile(
  client: lark.Client,
  filePath: string,
  chatId: string
): Promise<number> {
  // Step 1: Upload file
  const uploadResult = await uploadFile(client, filePath, chatId);

  // Step 2: Send message
  await sendFileMessage(client, chatId, uploadResult);

  return uploadResult.fileSize;
}
