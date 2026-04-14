/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload an image to Feishu and return image_key for
 * embedding in card img elements.
 *
 * @module mcp-server/tools/upload-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { SendFileResult } from './types.js';

const logger = createLogger('UploadImage');

/** Supported image file extensions */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image file size: 10 MB (Feishu limit) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload image via IPC to PrimaryNode and return image_key.
 * Issue #1919: Returns image_key for card embedding (does NOT send a message).
 */
async function uploadImageViaIpc(
  chatId: string,
  filePath: string,
  threadId?: string
): Promise<{ imageKey: string; fileName: string; fileSize: number }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadImage(chatId, filePath, threadId);
  if (!result.success) {
    const errorDetail = result.error ? `: ${result.error}` : '';
    throw new Error(`Failed to upload image via IPC${errorDetail}`);
  }
  if (!result.imageKey) {
    throw new Error('Image upload succeeded but no image_key was returned');
  }
  return {
    imageKey: result.imageKey,
    fileName: result.fileName ?? path.basename(filePath),
    fileSize: result.fileSize ?? 0,
  };
}

export async function upload_image(params: {
  filePath: string;
  chatId: string;
  /** Optional parent message ID for thread reply */
  parentMessageId?: string;
}): Promise<SendFileResult & { imageKey?: string }> {
  const { filePath, chatId, parentMessageId } = params;

  try {
    if (!chatId) { throw new Error('chatId is required'); }
    if (!filePath) { throw new Error('filePath is required'); }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      logger.warn({ filePath, chatId }, 'Image upload skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image cannot be uploaded: Platform is not configured.',
      };
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath, chatId, hasParent: !!parentMessageId }, 'upload_image called');

    // Validate file exists and is a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Validate file extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Not an image file: ${path.basename(resolvedPath)}. Supported formats: ${IMAGE_EXTENSIONS.join(', ')}`
      );
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      throw new Error(`Image file too large: ${sizeMB} MB (max 10 MB)`);
    }

    // Try IPC first
    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ chatId, filePath, parentMessageId }, 'Using IPC for image upload');
    const { imageKey, fileSize, fileName } = await uploadImageViaIpc(chatId, resolvedPath, parentMessageId);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ imageKey, fileName, fileSize, chatId }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\nimage_key: \`${imageKey}\`\n\nUse this image_key in card \`img\` elements: \`{ "tag": "img", "img_key": "${imageKey}" }\``,
      fileName,
      fileSize,
      sizeMB,
      imageKey,
    };

  } catch (error) {
    let platformCode: number | string | undefined;
    let platformMsg: string | undefined;
    let platformLogId: string | undefined;
    let troubleshooterUrl: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: Array<{ code?: number; msg?: string; log_id?: string; troubleshooter?: string }> | unknown };
      };

      if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
        platformCode = err.response.data[0].code;
        platformMsg = err.response.data[0].msg;
        platformLogId = err.response.data[0].log_id;
        troubleshooterUrl = err.response.data[0].troubleshooter;
      }
      if (!platformCode && typeof err.code === 'number') { platformCode = err.code; }
      if (!platformMsg) { platformMsg = err.msg || err.message; }
    }

    logger.error({ err: error, filePath, chatId, platformCode, platformMsg }, 'upload_image failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let errorDetails = `❌ Failed to upload image: ${errorMessage}`;
    if (platformCode) {
      errorDetails += `\n\n**Platform API Error:** Code: ${platformCode}`;
      if (platformMsg) { errorDetails += `, Message: ${platformMsg}`; }
    }

    return {
      success: false,
      error: errorMessage,
      message: errorDetails,
      platformCode,
      platformMsg,
      platformLogId,
      troubleshooterUrl,
    };
  }
}
