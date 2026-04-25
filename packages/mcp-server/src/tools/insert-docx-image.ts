/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Inline image insertion in Feishu documents.
 * Inserts an image at a specific position in a Feishu document using
 * the three-step Lark API flow:
 *   1. Create empty image block (block_type: 27) at the specified index
 *   2. Upload image file via Drive Media Upload API (parent_type: "docx_image")
 *   3. Bind uploaded file to the image block via replace_image
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { InsertDocxImageResult } from './types.js';

const logger = createLogger('InsertDocxImage');

/** Maximum image file size in bytes (20 MB for docx images). */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Supported image extensions for document insertion. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.svg',
]);

/**
 * Insert an image into a Feishu document at a specific position via IPC.
 *
 * Issue #2278: Threads through the full IPC stack to reach FeishuChannel's
 * insertDocxImage method, which performs the three-step Lark API flow.
 */
async function insertDocxImageViaIpc(
  documentId: string,
  filePath: string,
  index?: number
): Promise<{ blockId: string }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.insertDocxImage(documentId, filePath, index);
  if (!result.success) {
    throw new Error(`Failed to insert docx image via IPC${result.error ? `: ${result.error}` : ''}`);
  }
  return {
    blockId: result.blockId ?? '',
  };
}

export async function insert_docx_image(params: {
  documentId: string;
  filePath: string;
  /** 0-based index to insert the image block. Defaults to -1 (append to end). */
  index?: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, filePath, index } = params;

  try {
    if (!documentId) {
      throw new Error('documentId is required');
    }
    if (!filePath) {
      throw new Error('filePath is required');
    }

    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      logger.warn({ documentId, filePath }, 'insert_docx_image skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image insertion skipped: Platform is not configured.',
      };
    }

    // Resolve file path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    // Validate file exists and is a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    // Validate file size
    if (stats.size > MAX_IMAGE_SIZE) {
      throw new Error(`Image file too large: ${stats.size} bytes (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`);
    }

    // Validate file extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported image format: ${ext}. Supported: ${[...IMAGE_EXTENSIONS].join(', ')}`);
    }

    logger.debug({ documentId, filePath: resolvedPath, index }, 'insert_docx_image called');

    // Use IPC for the operation
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    const { blockId } = await insertDocxImageViaIpc(documentId, resolvedPath, index);

    const fileName = path.basename(resolvedPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    logger.info({ documentId, blockId, fileName, index }, 'Image inserted into document');

    return {
      success: true,
      message: `✅ Image inserted: ${fileName} (${sizeMB} MB) at index ${index ?? 'end'}, block_id: ${blockId}`,
      blockId,
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
      if (!platformCode && typeof err.code === 'number') {
        platformCode = err.code;
      }
      if (!platformMsg) {
        platformMsg = err.msg || err.message;
      }
    }

    logger.error({ err: error, documentId, filePath, index }, 'insert_docx_image failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let errorDetails = `❌ Failed to insert image: ${errorMessage}`;
    if (platformCode) {
      errorDetails += `\n\n**Platform API Error:** Code: ${platformCode}`;
      if (platformMsg) {
        errorDetails += `, Message: ${platformMsg}`;
      }
    }

    return {
      success: false,
      error: errorMessage,
      message: errorDetails,
    };
  }
}
