/**
 * upload_image tool implementation.
 *
 * Issue #1919 Phase 1: Upload an image to Feishu and return image_key
 * for embedding in card messages. Agents use this to get image_key
 * for use in `send_card` with `img` elements.
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

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg',
]);

/**
 * Upload an image via IPC and return the image_key.
 * Issue #1919 Phase 1: Reuses the uploadImage handler in Primary Node.
 */
async function uploadImageViaIpc(
  chatId: string,
  filePath: string,
): Promise<{ imageKey: string }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadImage(chatId, filePath);
  if (!result.success) {
    const errorDetail = result.error ? `: ${result.error}` : '';
    throw new Error(`Failed to upload image via IPC${errorDetail}`);
  }
  if (!result.imageKey) {
    throw new Error('Upload succeeded but no image_key returned');
  }
  return { imageKey: result.imageKey };
}

export async function upload_image(params: {
  imagePath: string;
  chatId: string;
}): Promise<UploadImageResult> {
  const { imagePath, chatId } = params;

  try {
    if (!chatId) { throw new Error('chatId is required'); }
    if (!imagePath) { throw new Error('imagePath is required'); }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      logger.warn({ imagePath, chatId }, 'Image upload skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image cannot be uploaded: Platform is not configured.',
      };
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Validate file exists and is an image
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${imagePath}`); }

    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`Not an image file: ${ext}. Supported formats: ${[...IMAGE_EXTENSIONS].join(', ')}`);
    }

    logger.debug({ imagePath, resolvedPath, chatId }, 'upload_image called');

    // Issue #1035: Try IPC first if available
    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ chatId, imagePath }, 'Using IPC for image upload');
    const { imageKey } = await uploadImageViaIpc(chatId, resolvedPath);

    logger.info({ imageKey, fileName: path.basename(resolvedPath), chatId }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded. image_key: ${imageKey}`,
      imageKey,
    };

  } catch (error) {
    let platformCode: number | string | undefined;
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

    logger.error({ err: error, imagePath, chatId, platformCode, platformMsg }, 'upload_image failed');

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
