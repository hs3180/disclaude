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
  apiFileType?: string; // The file_type used for upload API
}

/**
 * Feishu upload API response types.
 */
interface ImageUploadResponse {
  image_key?: string;
}

interface FileUploadResponse {
  file_key?: string;
}

/**
 * Extended error type with Feishu API response details.
 */
interface FeishuApiError extends Error {
  code?: number | string;
  msg?: string;
  response?: {
    data?: Array<{
      code?: number;
      msg?: string;
      log_id?: string;
      troubleshooter?: string;
    }> | unknown;
  };
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

    let fileKey: string;

    if (fileType === 'image') {
      // Use image upload API for images
      // Note: Must use Stream, not Buffer, due to SDK's form-data dependency
      const fileStream = fsStream.createReadStream(filePath);
      const response = await client.im.image.create({
        data: {
          image: fileStream,
          image_type: 'message',
        },
      }) as unknown as ImageUploadResponse;
      logger.debug({ imageKey: response?.image_key }, 'Image uploaded');
      fileKey = response?.image_key || '';
    } else {
      // Use file upload API for other types
      // Note: file_type must be one of: 'mp4', 'opus', 'pdf', 'doc', 'xls', 'ppt', 'stream'
      // IMPORTANT: msg_type in sendFileMessage must match the file_type used here!
      const apiFileType = fileType === 'video' ? 'mp4' :
                         fileType === 'audio' ? 'opus' :
                         fileType === 'file' ? 'pdf' : 'pdf';

      logger.debug({ fileType, apiFileType }, 'Using file upload API');

      // Create a readable stream for the file
      const fileStream = fsStream.createReadStream(filePath);

      const response = await client.im.file.create({
        data: {
          file_type: apiFileType,
          file_name: fileName,
          file: fileStream,
        },
      }) as unknown as FileUploadResponse;
      logger.debug({ fileKey: response?.file_key, apiFileType }, 'File uploaded');
      fileKey = response?.file_key || '';
    }

    // Validate file_key

    if (!fileKey) {
      throw new Error('No file_key returned from upload API');
    }

    logger.info({
      fileKey,
      fileName,
      fileType,
      apiFileType: fileType !== 'image' ? (fileType === 'video' ? 'mp4' : fileType === 'audio' ? 'opus' : 'pdf') : undefined,
      size: fileStats.size
    }, 'File uploaded successfully to Feishu');

    return {
      fileKey,
      fileType,
      fileName,
      fileSize: fileStats.size,
      apiFileType: fileType !== 'image' ? (fileType === 'video' ? 'mp4' : fileType === 'audio' ? 'opus' : 'pdf') : undefined,
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
    // IMPORTANT: msg_type MUST match the file_type used in uploadFile()
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
        // For audio, msg_type must be 'audio' (matches file_type 'opus')
        msgType = 'audio';
        content = JSON.stringify({
          file_key: uploadResult.fileKey,
        });
        break;

      case 'video':
        // Use 'media' msg_type for video files
        // Test result: msg_type='video' is invalid, msg_type='file' causes type mismatch
        // Only msg_type='media' works for video files uploaded with file_type='mp4'
        msgType = 'media';
        content = JSON.stringify({
          file_key: uploadResult.fileKey,
        });
        break;

      default:
        // For other files, msg_type must be 'file' (matches file_type 'pdf' etc.)
        msgType = 'file';
        content = JSON.stringify({
          file_key: uploadResult.fileKey,
        });
        break;
    }

    logger.debug({
      chatId,
      fileType: uploadResult.fileType,
      uploadApiType: uploadResult.apiFileType,
      msgType,
      fileKey: uploadResult.fileKey,
      fileName: uploadResult.fileName
    }, 'Sending file message to Feishu');

    // Send message
    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: msgType as 'text' | 'post' | 'image' | 'file' | 'audio' | 'media',
        content,
      },
    });

    logger.info({
      chatId,
      fileKey: uploadResult.fileKey,
      fileName: uploadResult.fileName,
      msgType,
      messageId: response?.data?.message_id
    }, 'File message sent successfully');

  } catch (error) {
    // Extract detailed error information from Feishu API response
    let errorCode: number | undefined;
    let errorMsg: string | undefined;
    let logId: string | undefined;
    let troubleshooterUrl: string | undefined;

    // Check if error has Feishu API response details
    if (error && typeof error === 'object') {
      const err = error as FeishuApiError;

      // Try to extract from response data
      if (err.response?.data) {
        const {data} = err.response;
        if (Array.isArray(data) && data[0]) {
          errorCode = data[0].code;
          errorMsg = data[0].msg;
          logId = data[0].log_id;
          troubleshooterUrl = data[0].troubleshooter;
        }
      }

      // Fallback to error properties
      if (!errorCode && typeof err.code === 'number') {
        errorCode = err.code;
      }
      if (!errorMsg) {
        errorMsg = err.msg || err.message;
      }
    }

    logger.error({
      err: error,
      chatId,
      fileKey: uploadResult.fileKey,
      fileName: uploadResult.fileName,
      fileType: uploadResult.fileType,
      apiFileType: uploadResult.apiFileType,
      // Detailed Feishu API error info
      feishuCode: errorCode,
      feishuMsg: errorMsg,
      feishuLogId: logId,
      troubleshooterUrl,
      // Full error details
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, 'Failed to send file message');

    // Build detailed error message
    const details = [
      `File: ${uploadResult.fileName}`,
      `Type: ${uploadResult.fileType}`,
      uploadResult.apiFileType ? `Upload API type: ${uploadResult.apiFileType}` : undefined,
    ].filter(Boolean).join('\n');

    const feishuError = errorCode ? [
      '\n**Feishu API Error:**',
      `Code: ${errorCode}`,
      errorMsg ? `Message: ${errorMsg}` : undefined,
      logId ? `Log ID: ${logId}` : undefined,
      troubleshooterUrl ? `Troubleshoot: ${troubleshooterUrl}` : undefined,
    ].filter(Boolean).join('\n') : '';

    throw new Error(
      `Failed to send file message: ${error instanceof Error ? error.message : 'Unknown error'}\n${details}${feishuError}`
    );
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
