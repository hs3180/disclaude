/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Insert an image into a Feishu document at a specific position.
 * Uses the 3-step Feishu API flow via IPC to Primary Node:
 *   1. Create empty image block (block_type: 27) at specified index
 *   2. Upload image file via Drive Media Upload API
 *   3. Bind uploaded file to image block via replace_image
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';

const logger = createLogger('InsertDocxImage');

export interface InsertDocxImageResult {
  success: boolean;
  message: string;
  blockId?: string;
  error?: string;
}

/**
 * Insert an image into a Feishu document at a specific position via IPC.
 *
 * The actual Feishu API calls are handled by Primary Node's Lark Client
 * to leverage its authentication and multipart upload support.
 */
export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index } = params;

  try {
    if (!documentId) {
      throw new Error('documentId is required');
    }
    if (!imagePath) {
      throw new Error('imagePath is required');
    }
    if (typeof index !== 'number' || index < 0) {
      throw new Error('index must be a non-negative integer');
    }

    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Cannot insert image: Platform is not configured.',
      };
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Verify image file exists
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${imagePath}`);
    }

    // Verify image format
    const ext = path.extname(resolvedPath).toLowerCase();
    const supportedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
    if (!supportedExtensions.includes(ext)) {
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${supportedExtensions.join(', ')}`
      );
    }

    logger.debug({ documentId, resolvedPath, index }, 'insert_docx_image called');

    // Issue #2278: Use IPC to call Primary Node's Lark Client
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Document image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.insertDocxImage(documentId, resolvedPath, index);

    if (!result.success) {
      logger.error({ documentId, resolvedPath, error: result.error }, 'insertDocxImage IPC failed');
      return {
        success: false,
        error: result.error ?? 'Unknown IPC error',
        message: `❌ Failed to insert image: ${result.error ?? 'Unknown error'}`,
      };
    }

    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    const fileName = path.basename(resolvedPath);

    logger.info({ documentId, fileName, index, blockId: result.blockId }, 'Image inserted into document');

    return {
      success: true,
      blockId: result.blockId,
      message: `✅ Image inserted: ${fileName} (${sizeMB} MB) at position ${index} in document ${documentId}`,
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
