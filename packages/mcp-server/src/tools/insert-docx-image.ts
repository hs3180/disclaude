/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Insert an image at a specified position in a Feishu document.
 *
 * Implements the 3-step Feishu Document API flow:
 * 1. Create an empty image block (block_type: 27) at the target index
 * 2. Upload the image file via Drive Media Upload API (parent_type: docx_image)
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

/**
 * Insert an image into a Feishu document at a specified position.
 *
 * Delegates the actual 3-step API call to the Primary Node via IPC,
 * which has access to the Lark client with valid credentials.
 *
 * Issue #2278: Inline image insertion in Feishu documents.
 */
export async function insert_docx_image(params: {
  /** Feishu document ID */
  documentId: string;
  /** Path to the image file (relative to workspace or absolute) */
  imagePath: string;
  /** Position index in the document to insert the image (0-based) */
  index: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index } = params;

  try {
    if (!documentId) { throw new Error('documentId is required'); }
    if (!imagePath) { throw new Error('imagePath is required'); }
    if (typeof index !== 'number' || index < 0) { throw new Error('index must be a non-negative integer'); }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      logger.warn({ documentId, imagePath }, 'Docx image insert skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image cannot be inserted: Platform is not configured.',
      };
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    logger.debug({ documentId, imagePath, resolvedPath, index }, 'insert_docx_image called');

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${imagePath}`); }

    // Validate file is an image
    const ext = path.extname(resolvedPath).toLowerCase();
    const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg'];
    if (!validExtensions.includes(ext)) {
      throw new Error(`Unsupported image format: ${ext}. Supported: ${validExtensions.join(', ')}`);
    }

    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ documentId, resolvedPath, index }, 'Using IPC for docx image insertion');
    const ipcClient = getIpcClient();
    const result = await ipcClient.insertDocxImage(documentId, resolvedPath, index);

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Unknown IPC error',
        message: `❌ Failed to insert image: ${result.error || 'Unknown error'}`,
      };
    }

    const fileName = path.basename(resolvedPath);
    logger.info({ documentId, fileName, index, blockId: result.blockId }, 'Image inserted into document');

    return {
      success: true,
      blockId: result.blockId,
      message: `✅ Image inserted at position ${index} in document (block: ${result.blockId || 'N/A'})`,
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
