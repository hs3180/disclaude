/**
 * upload_image tool implementation.
 *
 * Issue #1919: Uploads a local image to Feishu and returns the image_key
 * for use in card elements (e.g., `<img>` tag with `img_key` attribute).
 *
 * @module mcp-server/tools/upload-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';

const logger = createLogger('UploadImage');

export interface UploadImageResult {
  success: boolean;
  message: string;
  imageKey?: string;
  fileName?: string;
  fileSize?: number;
  error?: string;
}

/**
 * Upload an image via IPC to PrimaryNode's Lark client.
 * Returns image_key for use in card elements.
 *
 * Issue #1919: Routes through IPC to access Feishu's im.image.create API.
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
        error: `Not an image file: ${ext}`,
        message: `❌ File extension "${ext}" is not a supported image format. Supported: ${imageExtensions.join(', ')}`,
      };
    }

    // Validate file size (Feishu limit: 10MB for images)
    if (stats.size > 10 * 1024 * 1024) {
      return {
        success: false,
        error: 'File too large',
        message: `❌ Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 10 MB)`,
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
      imageKey,
      fileName,
      fileSize,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\n**image_key**: \`${imageKey}\`\n\nUse this \`image_key\` in card elements:\n\`\`\`json\n{ "tag": "img", "img_key": "${imageKey}" }\n\`\`\``,
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
