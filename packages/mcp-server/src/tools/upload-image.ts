/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload an image to Feishu and return image_key
 * for embedding in interactive card messages.
 *
 * Unlike send_file, this tool only uploads the image and returns
 * the image_key without sending any message. The image_key can
 * then be used in card elements (e.g., `"tag": "img", "img_key": "..."`).
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
 * Upload image via IPC to PrimaryNode's Feishu client.
 * Issue #1919: Uses dedicated uploadImage IPC method.
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
  if (!result.imageKey) {
    throw new Error('Image upload succeeded but no image_key was returned');
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

    // Validate image extension
    const ext = path.extname(resolvedPath).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];
    if (!imageExtensions.includes(ext)) {
      throw new Error(`Not an image file: ${path.basename(resolvedPath)} (supported: ${imageExtensions.join(', ')})`);
    }

    // Validate file size (max 10MB for Feishu image upload)
    if (stats.size > 10 * 1024 * 1024) {
      throw new Error(`Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 10MB)`);
    }

    // Issue #1919: Use IPC for image upload
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
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\n**image_key:** \`${imageKey}\`\n\nUse this \`image_key\` in card \`img\` elements: \`"tag": "img", "img_key": "${imageKey}"\``,
      imageKey,
      fileName,
      fileSize,
      sizeMB,
    };

  } catch (error) {
    let platformCode: number | string | undefined;
    let platformMsg: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: unknown } | unknown };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseData = (err as any).response?.data;
      if (responseData && Array.isArray(responseData) && responseData[0]) {
        platformCode = responseData[0].code;
        platformMsg = responseData[0].msg;
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
