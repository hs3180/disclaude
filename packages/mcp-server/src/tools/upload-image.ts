/**
 * upload_image tool implementation.
 *
 * Uploads an image to the platform and returns an image_key
 * that can be used in card `img` elements for inline embedding.
 *
 * Issue #1919: MCP tool support for image upload and card inline embedding.
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
 * Upload an image via IPC to PrimaryNode's Feishu client.
 * Issue #1919: Returns image_key for use in card img elements.
 */
async function uploadImageViaIpc(
  filePath: string,
): Promise<{ imageKey: string; fileName: string; fileSize: number }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadImage(filePath);
  if (!result.success) {
    const errorDetail = result.error ? `: ${result.error}` : '';
    throw new Error(`Failed to upload image via IPC${errorDetail}`);
  }
  if (!result.imageKey) {
    throw new Error('Image upload succeeded but no image_key returned');
  }
  return {
    imageKey: result.imageKey,
    fileName: result.fileName ?? path.basename(filePath),
    fileSize: result.fileSize ?? 0,
  };
}

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

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Validate file extension
    const ext = path.extname(resolvedPath).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];
    if (!imageExtensions.includes(ext)) {
      return {
        success: false,
        error: `Unsupported image format: ${ext}`,
        message: `❌ Unsupported image format: ${ext}. Supported formats: ${imageExtensions.join(', ')}`,
      };
    }

    // Validate file size (max 10MB for Feishu image upload)
    if (stats.size > 10 * 1024 * 1024) {
      return {
        success: false,
        error: `Image file too large: ${stats.size} bytes (max 10MB)`,
        message: `❌ Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 10MB)`,
      };
    }

    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ filePath: resolvedPath }, 'Using IPC for image upload');
    const { imageKey, fileName, fileSize } = await uploadImageViaIpc(resolvedPath);

    const sizeKB = (fileSize / 1024).toFixed(1);
    logger.info({ fileName, fileSize, imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeKB} KB)\n\nimage_key: \`${imageKey}\`\n\nUse this \`image_key\` in your card's \`img\` element: \`{ "tag": "img", "img_key": "${imageKey}" }\``,
      imageKey,
      fileName,
      fileSize,
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
