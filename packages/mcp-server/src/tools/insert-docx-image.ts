/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Inserts an image into a Feishu document at a specific position.
 *
 * The tool performs a 3-step Feishu API process via IPC:
 * 1. Create an empty image block (block_type: 27) at the specified index
 * 2. Upload the image file via Drive Media Upload API
 * 3. Bind the uploaded file to the image block via replace_image
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

export async function insert_docx_image(params: {
  /** Feishu document ID (from URL: /docx/{document_id}) */
  documentId: string;
  /** Path to the image file (relative to workspace or absolute) */
  imagePath: string;
  /** 0-based index where to insert the image block. -1 means append to end. */
  index: number;
  /** Optional width for the image in pixels (0 = auto) */
  width?: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index, width } = params;

  try {
    if (!documentId) { throw new Error('documentId is required'); }
    if (!imagePath) { throw new Error('imagePath is required'); }
    if (typeof index !== 'number') { throw new Error('index must be a number'); }

    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image insertion skipped: Platform is not configured.',
      };
    }

    // Resolve image path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Verify file exists and is an image
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${imagePath}`); }

    const ext = path.extname(resolvedPath).toLowerCase();
    const supportedExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    if (!supportedExts.includes(ext)) {
      throw new Error(`Unsupported image format: ${ext}. Supported: ${supportedExts.join(', ')}`);
    }

    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    if (stats.size > 20 * 1024 * 1024) {
      throw new Error(`Image file too large: ${sizeMB} MB (max 20MB)`);
    }

    logger.debug({ documentId, resolvedPath, index, sizeMB }, 'insert_docx_image called');

    // Use IPC for the actual API calls
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ documentId, resolvedPath, index }, 'Using IPC for docx image insertion');
    const result = await getIpcClient().insertDocxImage({
      documentId,
      imagePath: resolvedPath,
      index,
      width,
    });

    if (!result.success) {
      const errorMsg = result.error ?? 'Unknown error';
      return {
        success: false,
        error: errorMsg,
        message: `❌ Failed to insert image: ${errorMsg}`,
      };
    }

    const fileName = path.basename(resolvedPath);
    logger.info({ documentId, fileName, index, blockId: result.blockId }, 'Image inserted successfully');

    return {
      success: true,
      message: `✅ Image inserted: ${fileName} at index ${index} in document ${documentId}`,
      blockId: result.blockId,
      fileToken: result.fileToken,
    };

  } catch (error) {
    logger.error({ err: error, documentId, imagePath, index }, 'insert_docx_image failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to insert image: ${errorMessage}`,
    };
  }
}
