/**
 * upload_image tool implementation.
 *
 * Uploads an image to Feishu and returns an image_key for embedding
 * in interactive card messages.
 *
 * Issue #1919: MCP tool for image upload with image_key return.
 *
 * @module mcp-server/tools/upload-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import type { UploadImageResult } from './types.js';

const logger = createLogger('UploadImage');

/** Supported image extensions for upload */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image size: 10MB (Feishu limit) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload image via IPC to PrimaryNode's Feishu channel.
 */
async function uploadImageViaIpc(
  imagePath: string
): Promise<{ imageKey: string; imageName: string; imageSize: number }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadImage(imagePath);
  if (!result.success) {
    throw new Error(result.error ?? 'Failed to upload image via IPC');
  }
  return {
    imageKey: result.imageKey ?? '',
    imageName: result.imageName ?? path.basename(imagePath),
    imageSize: result.imageSize ?? 0,
  };
}

/**
 * Upload an image to Feishu and return the image_key.
 *
 * The returned image_key can be used in card JSON img elements:
 * ```json
 * { "tag": "img", "img_key": "<image_key>" }
 * ```
 *
 * @param params - Tool parameters
 * @param params.imagePath - Path to the image file (absolute or relative to workspace)
 * @returns Result with image_key on success, or error details on failure
 */
export async function upload_image(params: {
  imagePath: string;
}): Promise<UploadImageResult> {
  const { imagePath } = params;

  try {
    if (!imagePath) { throw new Error('imagePath is required'); }

    // Resolve relative paths using workspace directory
    const workspaceDir = process.env.DISCLAUDE_WORKSPACE_DIR || process.cwd();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    logger.debug({ imagePath, resolvedPath }, 'upload_image called');

    // Validate file exists and is a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${imagePath}`); }

    // Validate image extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Unsupported image format: ${ext}. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`
      );
    }

    // Validate image size
    if (stats.size > MAX_IMAGE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      throw new Error(`Image file too large: ${sizeMB} MB (max 10MB)`);
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

    logger.debug({ imagePath: resolvedPath }, 'Using IPC for image upload');
    const { imageKey, imageName, imageSize } = await uploadImageViaIpc(resolvedPath);

    const sizeMB = (imageSize / 1024 / 1024).toFixed(2);

    logger.info({ imageName, imageSize, imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${imageName} (${sizeMB} MB)\nimage_key: ${imageKey}\n\nUse this image_key in card img elements: { "tag": "img", "img_key": "${imageKey}" }`,
      imageKey,
      imageName,
      imageSize,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, imagePath }, 'upload_image failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to upload image: ${errorMessage}`,
    };
  }
}
