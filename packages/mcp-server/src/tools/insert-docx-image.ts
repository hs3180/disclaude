/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Inserts an image into a Feishu document at a specified position.
 * Uses IPC to communicate with Primary Node, which handles the 3-step
 * Feishu API flow (create block → upload image → bind).
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getWorkspaceDir } from './credentials.js';
import type { InsertDocxImageResult } from './types.js';

const logger = createLogger('InsertDocxImage');

/**
 * Supported image extensions.
 */
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * Insert an image into a Feishu document at a specified position.
 *
 * The image will be inserted as a block in the document at the given index.
 * Use index -1 or omit index to append at the end.
 *
 * @param params - Tool parameters
 * @param params.documentId - Feishu document ID (from the document URL)
 * @param params.imagePath - Path to the image file (relative to workspace or absolute)
 * @param params.index - Position to insert at (0-based, -1 for append at end)
 * @returns Result with success status and block ID
 */
export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index?: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index = -1 } = params;

  try {
    if (!documentId) {
      return {
        success: false,
        message: '⚠️ documentId is required. Provide the Feishu document ID from the URL.',
      };
    }

    if (!imagePath) {
      return {
        success: false,
        message: '⚠️ imagePath is required. Provide the path to the image file.',
      };
    }

    // Resolve file path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Validate image file
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        success: false,
        message: `⚠️ Unsupported image format: ${ext}. Supported: PNG, JPEG, GIF, WebP, BMP`,
      };
    }

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      return {
        success: false,
        message: `⚠️ Path is not a file: ${imagePath}`,
      };
    }

    logger.debug({ documentId, resolvedPath, index }, 'insert_docx_image called');

    // Check IPC availability
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        message: '❌ Image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    // Call IPC to insert image via Primary Node
    const ipcClient = getIpcClient();
    const result = await ipcClient.insertDocxImage(documentId, resolvedPath, index);

    if (result.success) {
      const fileName = path.basename(resolvedPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      logger.info({ documentId, blockId: result.blockId, fileName }, 'Image inserted into document');

      return {
        success: true,
        blockId: result.blockId,
        message: `✅ Image inserted into document: ${fileName} (${sizeMB} MB) at index ${index === -1 ? 'end' : index}${result.blockId ? `, blockId: ${result.blockId}` : ''}`,
      };
    }

    return {
      success: false,
      error: result.error,
      message: `❌ Failed to insert image: ${result.error || 'Unknown error'}`,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, documentId, imagePath, index }, 'insert_docx_image failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Image insertion failed: ${errorMessage}`,
    };
  }
}
