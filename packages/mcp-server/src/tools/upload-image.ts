/**
 * upload_image tool implementation.
 *
 * Issue #1919 Phase 1: Uploads an image to the platform and returns
 * the image_key for embedding in card img elements.
 *
 * Unlike send_file, this does NOT send a message to the chat.
 * The returned image_key is used in card JSON like:
 * { "tag": "img", "img_key": "<image_key>" }
 *
 * @module mcp-server/tools/upload-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { UploadImageResult } from './types.js';

const logger = createLogger('UploadImage');

/**
 * Supported image extensions for upload.
 */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/**
 * Upload an image via IPC and return image_key for card embedding.
 */
async function uploadImageViaIpc(
  chatId: string,
  filePath: string
): Promise<{ imageKey: string; fileName: string; fileSize: number }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadImage(chatId, filePath);
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
}): Promise<UploadImageResult> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) { throw new Error('chatId is required'); }

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

    logger.debug({ filePath, resolvedPath, chatId }, 'upload_image called');

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Validate image extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error: `Not an image file: ${ext}`,
        message: `❌ Unsupported image format: ${ext}. Supported formats: ${IMAGE_EXTENSIONS.join(', ')}`,
      };
    }

    // Check IPC availability
    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ chatId, filePath: resolvedPath }, 'Using IPC for image upload');
    const { imageKey, fileName, fileSize } = await uploadImageViaIpc(chatId, resolvedPath);

    const sizeKB = (fileSize / 1024).toFixed(1);
    logger.info({ imageKey, fileName, fileSize, chatId }, 'Image uploaded successfully');

    return {
      success: true,
      imageKey,
      fileName,
      fileSize,
      message: `✅ Image uploaded: ${fileName} (${sizeKB} KB)\n\nimage_key: \`${imageKey}\`\n\nUse this image_key in card img elements: \`{ "tag": "img", "img_key": "${imageKey}" }\``,
    };

  } catch (error) {
    let platformCode: number | undefined;
    let platformMsg: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: Array<{ code?: number; msg?: string }> | unknown };
      };

      if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
        platformCode = err.response.data[0].code;
        platformMsg = err.response.data[0].msg;
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
    };
  }
}
