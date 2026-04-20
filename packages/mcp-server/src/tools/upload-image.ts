/**
 * upload_image tool implementation.
 *
 * Uploads a local image file to Feishu and returns the image_key,
 * which can be used in card `img` elements for embedding images in cards.
 *
 * Issue #1919: New MCP tool for image upload → image_key retrieval.
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

/** Maximum image file size (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload an image via IPC and return image_key.
 * Issue #1919: The image_key can be used in card `img` elements.
 */
async function uploadImageViaIpc(
  filePath: string
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

/**
 * Upload a local image file to Feishu and return the image_key.
 *
 * The returned image_key can be used in card `img` elements:
 * ```json
 * { "tag": "img", "img_key": "<image_key>" }
 * ```
 *
 * Issue #1919: New MCP tool for image upload → image_key retrieval.
 *
 * @param params.filePath - Path to the image file (absolute or relative to workspace)
 * @returns UploadImageResult with imageKey on success
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
      throw new Error(`Image file too large: ${stats.size} bytes (max 10MB)`);
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
    const { imageKey, fileName, fileSize } = await uploadImageViaIpc(resolvedPath);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ fileName, fileSize, imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      imageKey,
      fileName,
      fileSize,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\nUse this image_key in card img elements:\n\`{ "tag": "img", "img_key": "${imageKey}" }\``,
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
