/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload an image to Feishu and return the image_key
 * for use in card message img elements.
 *
 * This enables Agents to generate charts/images, upload them, and embed
 * them in rich card messages for a professional report experience.
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

/** Supported image file extensions */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image file size: 10 MB (Feishu API limit) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload an image to Feishu and return the image_key.
 *
 * The returned image_key can be used in send_card's `img` elements:
 * ```json
 * { "tag": "img", "img_key": "img_v3_xxx..." }
 * ```
 *
 * Issue #1919: Enables card-embedded images for rich report experiences.
 */
export async function upload_image(params: {
  filePath: string;
}): Promise<UploadImageResult> {
  const { filePath } = params;

  try {
    if (!filePath) {
      throw new Error('filePath is required');
    }

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

    // Validate image format
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error: `Unsupported image format: ${ext}`,
        message: `❌ Unsupported image format: ${ext}. Supported: ${IMAGE_EXTENSIONS.join(', ')}`,
      };
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        success: false,
        error: `Image file too large: ${sizeMB} MB (max 10 MB)`,
        message: `❌ Image file too large: ${sizeMB} MB (max 10 MB)`,
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
    logger.debug({ resolvedPath }, 'Using IPC for image upload');
    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(resolvedPath);

    if (!result.success || !result.imageKey) {
      const errorDetail = result.error ? `: ${result.error}` : '';
      logger.error({ resolvedPath, error: result.error }, 'Image upload via IPC failed');
      return {
        success: false,
        error: result.error ?? 'Upload failed',
        message: `❌ Failed to upload image${errorDetail}`,
      };
    }

    const sizeKB = (stats.size / 1024).toFixed(1);
    const fileName = result.fileName || path.basename(resolvedPath);

    logger.info({ imageKey: result.imageKey, fileName, sizeKB }, 'Image uploaded successfully');

    return {
      success: true,
      imageKey: result.imageKey,
      fileName,
      fileSize: result.fileSize ?? stats.size,
      message: `✅ Image uploaded: ${fileName} (${sizeKB} KB)\n\nimage_key: \`${result.imageKey}\`\n\nUse this \`image_key\` in \`send_card\` \`img\` elements: \`{ "tag": "img", "img_key": "${result.imageKey}" }\``,
    };

  } catch (error) {
    logger.error({ err: error, filePath }, 'upload_image failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to upload image: ${errorMessage}`,
    };
  }
}
