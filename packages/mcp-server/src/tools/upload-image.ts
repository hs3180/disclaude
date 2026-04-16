/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload an image to the messaging platform and return image_key
 * for embedding in card messages (e.g., Feishu card img elements).
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

/** Supported image extensions for upload. */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image file size: 10MB (Feishu limit). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload an image via IPC to PrimaryNode's channel handler.
 * Returns image_key for use in card messages.
 *
 * Issue #1919: MCP tool for image upload with image_key return.
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
  filePath: string;
}): Promise<UploadImageResult> {
  const { filePath } = params;

  try {
    if (!filePath) { throw new Error('filePath is required'); }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath }, 'upload_image called');

    // Validate file exists and is a regular file
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
      throw new Error(
        `Image file too large: ${stats.size} bytes (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`
      );
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

    // Upload image via IPC
    const { imageKey, fileName, fileSize } = await uploadImageViaIpc(resolvedPath);

    if (!imageKey) {
      return {
        success: false,
        error: 'No image_key returned',
        message: '❌ Image upload succeeded but no image_key was returned from the platform.',
      };
    }

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ fileName, fileSize, imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\nimage_key: ${imageKey}\n\nUse this image_key in card img elements: { "tag": "img", "img_key": "${imageKey}" }`,
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
