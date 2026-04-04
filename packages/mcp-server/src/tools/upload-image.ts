/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload an image to Feishu and return the image_key
 * for embedding images in card messages.
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

/** Supported image extensions for Feishu upload */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image size for Feishu upload (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export async function upload_image(params: {
  filePath: string;
}): Promise<UploadImageResult> {
  const { filePath } = params;

  try {
    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      logger.warn({ filePath }, 'Image upload skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image cannot be uploaded: Platform is not configured.',
      };
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath }, 'upload_image called');

    // Validate file exists and is a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    // Validate file extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error: `Unsupported file type: ${ext}`,
        message: `❌ Unsupported file type: ${ext}. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
      };
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        success: false,
        error: `Image file too large: ${sizeMB} MB (max 10MB)`,
        message: `❌ Image file too large: ${sizeMB} MB (max 10MB)`,
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

    logger.debug({ filePath: resolvedPath }, 'Using IPC for image upload');
    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(resolvedPath);

    if (!result.success || !result.imageKey) {
      return {
        success: false,
        error: result.error ?? 'Failed to upload image via IPC',
        message: `❌ Failed to upload image: ${result.error ?? 'Unknown error'}`,
      };
    }

    const fileName = path.basename(resolvedPath);
    logger.info({ fileName, imageKey: result.imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      imageKey: result.imageKey,
      fileName,
      message: `✅ Image uploaded. Image key: ${result.imageKey}`,
    };

  } catch (error) {
    logger.error({ err: error, filePath }, 'upload_image failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let message = `❌ Failed to upload image: ${errorMessage}`;

    // Extract platform error details if available
    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: Array<{ code?: number; msg?: string }> };
      };
      if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
        const { code, msg } = err.response.data[0];
        if (code) { message += `\n\n**Platform API Error:** Code: ${code}`; }
        if (msg) { message += `, Message: ${msg}`; }
      }
    }

    return {
      success: false,
      error: errorMessage,
      message,
    };
  }
}
