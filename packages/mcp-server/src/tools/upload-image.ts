/**
 * upload_image tool implementation.
 *
 * Uploads an image to Feishu and returns an image_key that can be used
 * to embed the image in card messages (img elements).
 *
 * Issue #1919: MCP tool for image upload with image_key return.
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

/** Supported image extensions for Feishu image upload */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image file size (10MB per Feishu API) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

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

    // Validate file exists and is accessible
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Validate image format
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error: 'Invalid image format',
        message: `⚠️ Unsupported image format: ${ext}. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
      };
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      return {
        success: false,
        error: 'File too large',
        message: `⚠️ Image too large: ${stats.size} bytes (max 10MB)`,
      };
    }

    // Issue #1035: Use IPC for upload
    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ chatId, filePath }, 'Using IPC for image upload');
    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(chatId, resolvedPath);

    if (!result.success || !result.imageKey) {
      const errorMsg = result.error || 'Failed to upload image via IPC';
      throw new Error(errorMsg);
    }

    const fileName = path.basename(resolvedPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    logger.info({ fileName, fileSize: stats.size, chatId, imageKey: result.imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      imageKey: result.imageKey,
      fileName,
      fileSize: stats.size,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\nUse this image_key in card img elements:\n\`image_key: ${result.imageKey}\``,
    };

  } catch (error) {
    let platformCode: number | undefined;
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
