/**
 * insert_docx_image tool implementation.
 *
 * Inserts an image at a specific position in a Feishu document (docx).
 * Uses the 3-step Feishu API flow:
 * 1. Create empty image block at specified index
 * 2. Upload image file via Drive Media Upload API
 * 3. Bind image to block via replace_image
 *
 * Issue #2278: Inline image insertion in Feishu documents.
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getWorkspaceDir } from './credentials.js';

const logger = createLogger('InsertDocxImage');

/**
 * Result type for insert_docx_image tool.
 */
export interface InsertDocxImageResult {
  success: boolean;
  message: string;
  /** ID of the created image block */
  blockId?: string;
  /** File token of the uploaded image */
  fileToken?: string;
  error?: string;
}

export async function insert_docx_image(params: {
  /** Feishu document ID (from URL: /docx/{documentId}) */
  documentId: string;
  /** Path to the image file (relative to workspace or absolute) */
  imagePath: string;
  /** Insert position index (0-based). Omit to append at end. */
  index?: number;
  /** Optional image width in pixels */
  width?: number;
  /** Optional image height in pixels */
  height?: number;
  /** Optional caption text */
  caption?: string;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index, width, height, caption } = params;

  try {
    if (!documentId) {
      throw new Error('documentId is required');
    }
    if (!imagePath) {
      throw new Error('imagePath is required');
    }

    // Resolve file path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(workspaceDir, imagePath);

    logger.debug(
      { documentId, imagePath, resolvedPath, index, width, height },
      'insert_docx_image called'
    );

    // Verify file exists
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${imagePath}`);
    }

    // Check IPC availability
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message:
          '❌ Image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    // Call via IPC
    logger.debug({ documentId, resolvedPath }, 'Using IPC for docx image insertion');
    const ipcClient = getIpcClient();
    const result = await ipcClient.insertDocxImage(
      documentId,
      resolvedPath,
      { index, width, height, caption }
    );

    if (!result.success) {
      const errorMsg = result.error || 'Unknown IPC error';
      logger.error({ documentId, error: errorMsg }, 'insertDocxImage IPC failed');
      return {
        success: false,
        error: errorMsg,
        message: `❌ Failed to insert image: ${errorMsg}`,
      };
    }

    const fileName = path.basename(resolvedPath);
    const sizeKB = (stats.size / 1024).toFixed(1);

    logger.info(
      { documentId, blockId: result.blockId, fileToken: result.fileToken },
      'Image inserted into docx successfully'
    );

    return {
      success: true,
      blockId: result.blockId,
      fileToken: result.fileToken,
      message: `✅ Image inserted: ${fileName} (${sizeKB} KB) at index ${index !== undefined ? index : 'end'} in document ${documentId}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, documentId, imagePath }, 'insert_docx_image failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to insert image: ${errorMessage}`,
    };
  }
}
