/**
 * upload_image tool implementation.
 *
 * Uploads an image file to the platform and returns an image_key
 * that can be used to embed images in card messages.
 *
 * Issue #1919: MCP tool for image upload with image_key return.
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

/** Supported image extensions for upload */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp'];

/** Maximum image file size: 10MB */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Upload an image via IPC and return image_key.
 * Issue #1919: Enables Agent to embed images in card messages.
 */
export async function upload_image(params: {
  filePath: string;
}): Promise<UploadImageResult> {
  const { filePath } = params;

  try {
    if (!filePath) {
      throw new Error('filePath is required');
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
      throw new Error(
        `Unsupported image format: ${ext}. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`
      );
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      throw new Error(`Image file too large: ${stats.size} bytes (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`);
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
      const errMsg = result.error || 'Failed to upload image via IPC';
      throw new Error(errMsg);
    }

    const fileName = result.fileName ?? path.basename(resolvedPath);
    const fileSize = result.fileSize ?? stats.size;
    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ fileName, fileSize, imageKey: result.imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\nimage_key: ${result.imageKey}\n\nUse this image_key in the img element of a card:\n{"tag": "img", "img_key": "${result.imageKey}"}`,
      imageKey: result.imageKey,
      fileName,
      fileSize,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, filePath }, 'upload_image failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to upload image: ${errorMessage}`,
    };
  }
}
