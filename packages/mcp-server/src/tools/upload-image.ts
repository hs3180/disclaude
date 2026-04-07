/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload image to Feishu and return image_key for card embedding.
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

/** Maximum image file size: 10MB (Feishu API limit) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload image via IPC to PrimaryNode's Feishu channel.
 * Returns the image_key for use in card messages.
 */
async function uploadImageViaIpc(
  filePath: string
): Promise<{ imageKey: string; fileName: string; fileSize: number }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadImage(filePath);
  if (!result.success || !result.imageKey) {
    throw new Error('Failed to upload image via IPC');
  }
  return {
    imageKey: result.imageKey,
    fileName: result.fileName ?? path.basename(filePath),
    fileSize: result.fileSize ?? 0,
  };
}

/**
 * Upload an image to Feishu and return the image_key for card embedding.
 *
 * Issue #1919: This tool allows the Agent to upload images (charts, diagrams, etc.)
 * and receive an image_key that can be used in the `img` element of card messages
 * sent via `send_card` or `send_interactive`.
 *
 * @param params - Tool parameters
 * @returns Result with image_key for card usage
 */
export async function upload_image(params: {
  filePath: string;
}): Promise<UploadImageResult> {
  const { filePath } = params;

  try {
    if (!filePath) { throw new Error('filePath is required'); }

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
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Validate file extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Unsupported image format: ${ext}. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`
      );
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      throw new Error(`Image file too large: ${sizeMB} MB (max 10 MB)`);
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

    logger.debug({ filePath }, 'Using IPC for image upload');
    const { imageKey, fileName, fileSize } = await uploadImageViaIpc(resolvedPath);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ fileName, fileSize, imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\nUse this image_key in card img elements:\n\`\`\`json\n{ "tag": "img", "img_key": "${imageKey}" }\n\`\`\``,
      imageKey,
      fileName,
      fileSize,
      sizeMB,
    };

  } catch (error) {
    logger.error({ err: error, filePath }, 'upload_image failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let errorDetails = `❌ Failed to upload image: ${errorMessage}`;

    // Extract platform error details if available
    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: Array<{ code?: number; msg?: string; log_id?: string }> | unknown };
      };

      if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
        const platformCode = err.response.data[0].code;
        const platformMsg = err.response.data[0].msg;
        if (platformCode) {
          errorDetails += `\n\n**Platform API Error:** Code: ${platformCode}`;
          if (platformMsg) { errorDetails += `, Message: ${platformMsg}`; }
        }
      }
    }

    return {
      success: false,
      error: errorMessage,
      message: errorDetails,
    };
  }
}
