/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Insert an image into a Feishu docx document at a specific position.
 *
 * Three-step flow executed by Primary Node:
 * 1. Create empty image block (block_type: 27) at the specified index
 * 2. Upload image file via Drive Media Upload API (parent_type: "docx_image")
 * 3. Replace the empty image block with the uploaded file via batchUpdate
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

/** Supported image extensions for docx image insertion */
const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];

/** Maximum file size for Feishu media upload (20MB) */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index: number;
  caption?: string;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index, caption } = params;

  try {
    if (!documentId) {
      throw new Error('documentId is required');
    }
    if (!imagePath) {
      throw new Error('imagePath is required');
    }
    if (typeof index !== 'number' || index < 0) {
      throw new Error('index must be a non-negative number');
    }

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

    // Validate image format
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error: `Unsupported image format: ${ext}. Supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
        message: `❌ Unsupported image format: ${ext}. Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
      };
    }

    // Validate file exists and is a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${imagePath}`);
    }

    // Validate file size
    if (stats.size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `Image file too large: ${stats.size} bytes (max ${MAX_FILE_SIZE} bytes)`,
        message: `❌ Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 20 MB)`,
      };
    }

    // Check IPC availability
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Docx image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ documentId, resolvedPath, index, caption }, 'insert_docx_image called');

    // Call IPC to Primary Node
    const ipcClient = getIpcClient();
    const result = await ipcClient.insertDocxImage(documentId, resolvedPath, index, caption);

    if (!result.success) {
      const errorDetail = result.error ? `: ${result.error}` : '';
      logger.error({ documentId, imagePath, error: result.error }, 'insert_docx_image IPC failed');
      return {
        success: false,
        error: result.error || 'IPC request failed',
        message: `❌ Failed to insert image into document${errorDetail}`,
      };
    }

    const fileName = path.basename(resolvedPath);
    const sizeKB = (stats.size / 1024).toFixed(1);

    logger.info({ documentId, blockId: result.blockId, fileToken: result.fileToken, index }, 'insert_docx_image succeeded');

    return {
      success: true,
      message: `✅ Image inserted into document at position ${index}: ${fileName} (${sizeKB} KB, block: ${result.blockId})`,
      blockId: result.blockId,
      fileToken: result.fileToken,
    };
  } catch (error) {
    logger.error({ err: error, documentId, imagePath, index }, 'insert_docx_image failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to insert image into document: ${errorMessage}`,
    };
  }
}
