/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload an image and return image_key for embedding
 * in card messages. Unlike send_file which sends the image as a
 * standalone message, this tool ONLY uploads the image to Feishu's
 * CDN and returns the image_key so it can be used in card JSON
 * (e.g., `img` elements in send_card / send_interactive).
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

/** Supported image file extensions (must match FeishuChannel). */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image file size: 10 MB (Feishu API limit). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

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

    // Validate file exists
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    // Validate file extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Unsupported image format: ${ext} (supported: ${IMAGE_EXTENSIONS.join(', ')})`
      );
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      throw new Error(
        `Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 10 MB)`
      );
    }

    // Issue #1919: Upload via IPC to PrimaryNode's Feishu client
    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ filePath: resolvedPath }, 'Uploading image via IPC');

    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(resolvedPath);

    if (!result.success || !result.imageKey) {
      throw new Error('Failed to upload image via IPC: no image_key returned');
    }

    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    const fileName = path.basename(resolvedPath);

    logger.info({ fileName, imageKey: result.imageKey, fileSize: stats.size }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\n**image_key**: \`${result.imageKey}\`\n\nUse this \`image_key\` in card \`img\` elements like:\n\`\`\`json\n{"tag": "img", "img_key": "${result.imageKey}"}\n\`\`\``,
      imageKey: result.imageKey,
      fileName,
      fileSize: stats.size,
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
    };
  }
}
