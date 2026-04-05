/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload image to Feishu and return image_key for card embedding.
 * This enables the Agent to embed images in card messages by:
 * 1. Calling upload_image(filePath) to get image_key
 * 2. Using image_key in send_card's img element: { tag: "img", img_key: "img_v3_xxx" }
 *
 * @module mcp-server/tools/upload-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getWorkspaceDir } from './credentials.js';
import type { UploadImageResult } from './types.js';

const logger = createLogger('UploadImage');

/** Supported image extensions for Feishu image upload */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image file size for Feishu upload (10MB) */
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

export async function upload_image(params: {
  filePath: string;
}): Promise<UploadImageResult> {
  const { filePath } = params;

  try {
    if (!filePath) { throw new Error('filePath is required'); }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath }, 'upload_image called');

    // Validate file exists and is a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Validate image extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error: 'Invalid file type',
        message: `❌ Unsupported image format: ${ext}. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
      };
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE_BYTES) {
      return {
        success: false,
        error: 'File too large',
        message: `❌ Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 10MB)`,
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

    // Upload via IPC
    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(resolvedPath);

    if (!result.success || !result.imageKey) {
      const errorMsg = result.error || 'Failed to upload image via IPC';
      logger.error({ filePath, resolvedPath, error: errorMsg }, 'upload_image failed');
      return {
        success: false,
        error: errorMsg,
        message: `❌ Failed to upload image: ${errorMsg}`,
      };
    }

    const fileName = path.basename(resolvedPath);
    const sizeMB = ((result.fileSize ?? stats.size) / 1024 / 1024).toFixed(2);

    logger.info({ fileName, imageKey: result.imageKey, fileSize: result.fileSize }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\n**image_key**: \`${result.imageKey}\`\n\nUse this image_key in send_card's img element:\n\`{ "tag": "img", "img_key": "${result.imageKey}" }\``,
      imageKey: result.imageKey,
      fileName,
      fileSize: result.fileSize ?? stats.size,
      sizeMB,
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

    logger.error({ err: error, filePath, platformCode, platformMsg }, 'upload_image failed');

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
    };
  }
}
