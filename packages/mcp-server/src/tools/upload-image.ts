/**
 * upload_image tool implementation.
 *
 * Issue #1919 Phase 1: Provides a standalone MCP tool for uploading images
 * to Feishu and returning the image_key for use in card `img` elements.
 *
 * This enables agents to embed locally-generated images (e.g., charts, plots)
 * into card messages using send_card, instead of sending them as separate files.
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
 * Upload an image via IPC to PrimaryNode and return the image_key.
 * Issue #1919 Phase 1: Routes through IPC to FeishuChannel.uploadImage().
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
  return {
    imageKey: result.imageKey ?? '',
    fileName: result.fileName ?? path.basename(filePath),
    fileSize: result.fileSize ?? 0,
  };
}

export async function upload_image(params: {
  /** Local file path of the image to upload */
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

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Verify file is an image by extension
    const ext = path.extname(resolvedPath).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];
    if (!imageExtensions.includes(ext)) {
      return {
        success: false,
        error: 'Not an image file',
        message: `❌ Unsupported file type: ${ext}. Supported formats: ${imageExtensions.join(', ')}`,
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

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ imageKey, fileName, fileSize }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\nimage_key: ${imageKey}\n\nUse this image_key in card \`img\` elements: \`{ "tag": "img", "img_key": "${imageKey}" }\``,
      imageKey,
      fileName,
      fileSize,
      sizeMB,
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
