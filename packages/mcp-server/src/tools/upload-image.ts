/**
 * upload_image tool implementation.
 *
 * Issue #1919: Uploads an image via IPC and returns the image_key
 * for embedding in Feishu card messages.
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
 * Supported image extensions for Feishu image upload.
 */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/**
 * Maximum image file size (10MB, Feishu API limit).
 */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload an image via IPC to PrimaryNode and return the image_key.
 * Issue #1919: The returned image_key can be used in send_card's img element.
 *
 * @param params - Upload parameters
 * @param params.filePath - Path to the image file to upload
 */
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
        error: `Unsupported image format: ${ext}`,
        message: `❌ Unsupported image format: ${ext}. Supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
      };
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        success: false,
        error: `Image file too large: ${sizeMB}MB (max 10MB)`,
        message: `❌ Image file too large: ${sizeMB}MB (max 10MB)`,
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
    logger.debug({ filePath: resolvedPath }, 'Using IPC for image upload');
    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(resolvedPath);

    if (!result.success) {
      const errorDetail = result.error ? `: ${result.error}` : '';
      return {
        success: false,
        error: result.error,
        message: `❌ Failed to upload image${errorDetail}`,
      };
    }

    const {imageKey} = result;
    if (!imageKey) {
      return {
        success: false,
        error: 'No image_key returned from IPC',
        message: '❌ Failed to upload image: No image_key returned from server.',
      };
    }
    const fileName = result.fileName ?? path.basename(resolvedPath);
    const fileSize = result.fileSize ?? stats.size;
    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ fileName, fileSize, imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB}MB)\n\n**image_key:** \`${imageKey}\`\n\nUse this \`image_key\` in \`send_card\` with: \`{ "tag": "img", "img_key": "${imageKey}" }\``,
      imageKey,
      fileName,
      fileSize,
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
    };
  }
}
