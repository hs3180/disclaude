/**
 * upload_image tool implementation.
 *
 * Issue #1919: Upload an image to the messaging platform and return
 * an image_key that can be used in card img elements.
 *
 * Unlike send_file (which uploads AND sends), this is a pure upload
 * operation — it only returns the image_key without sending any message.
 *
 * @module mcp-server/tools/upload-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable, getIpcErrorMessage } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { UploadImageResult } from './types.js';

const logger = createLogger('UploadImage');

/** Supported image extensions for upload */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum image file size: 10MB (Feishu API limit) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Validate that a file is a supported image.
 *
 * @throws Error if the file is not a valid image
 */
async function validateImageFile(filePath: string): Promise<{ fileName: string; fileSize: number }> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported image format: ${ext}. Supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`
    );
  }

  if (stats.size > MAX_IMAGE_SIZE) {
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    throw new Error(`Image file too large: ${sizeMB} MB (max 10 MB)`);
  }

  if (stats.size === 0) {
    throw new Error(`Image file is empty: ${filePath}`);
  }

  return {
    fileName: path.basename(filePath),
    fileSize: stats.size,
  };
}

/**
 * Upload image via IPC to PrimaryNode's channel handler.
 * Issue #1919: Returns image_key for card embedding.
 */
async function uploadImageViaIpc(
  filePath: string
): Promise<{ imageKey: string; fileName: string; fileSize: number }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadImage(filePath);
  if (!result.success) {
    const errorType = (result as { errorType?: string }).errorType;
    const errorMsg = getIpcErrorMessage(
      errorType as 'ipc_unavailable' | 'ipc_timeout' | 'ipc_request_failed' | undefined,
      result.error,
      'Failed to upload image via IPC'
    );
    throw new Error(errorMsg);
  }
  return {
    imageKey: result.imageKey ?? '',
    fileName: result.fileName ?? path.basename(filePath),
    fileSize: result.fileSize ?? 0,
  };
}

/**
 * Upload an image and return the image_key for card embedding.
 *
 * This is a pure upload operation — it does NOT send any message.
 * Use the returned image_key in card img elements:
 *
 * ```json
 * { "tag": "img", "img_key": "img_v3_xxx" }
 * ```
 *
 * @param params - Tool parameters
 * @param params.filePath - Path to the image file (absolute or relative to workspace)
 * @returns Upload result with image_key
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

    // Validate image file
    const { fileName, fileSize } = await validateImageFile(resolvedPath);

    // Check IPC availability
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ filePath: resolvedPath, fileName }, 'Using IPC for image upload');
    const { imageKey } = await uploadImageViaIpc(resolvedPath);

    if (!imageKey) {
      throw new Error('Upload succeeded but no image_key was returned');
    }

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

    logger.info({ fileName, fileSize, imageKey }, 'Image uploaded successfully');

    return {
      success: true,
      message: `✅ Image uploaded: ${fileName} (${sizeMB} MB)\n\n**image_key**: \`${imageKey}\`\n\nUse this key in card img elements:\n\`\`\`json\n{ "tag": "img", "img_key": "${imageKey}" }\n\`\`\``,
      imageKey,
      fileName,
      fileSize,
      sizeMB,
    };
  } catch (error) {
    let platformCode: number | undefined;
    let platformMsg: string | undefined;
    let platformLogId: string | undefined;
    let troubleshooterUrl: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: Array<{ code?: number; msg?: string; log_id?: string; troubleshooter?: string }> | unknown };
      };

      if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
        platformCode = err.response.data[0].code;
        platformMsg = err.response.data[0].msg;
        platformLogId = err.response.data[0].log_id;
        troubleshooterUrl = err.response.data[0].troubleshooter;
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
      platformCode,
      platformMsg,
      platformLogId,
      troubleshooterUrl,
    };
  }
}
