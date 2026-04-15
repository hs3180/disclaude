/**
 * insert_docx_image tool implementation.
 *
 * Inserts an image at a specific position in a Feishu Docx document.
 * Uses the 3-step Feishu API flow: create block → upload file → bind image.
 *
 * Issue #2278: Inline image insertion support for Feishu documents.
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';

const logger = createLogger('InsertDocxImage');

/** Supported image formats for Feishu Docx */
const SUPPORTED_IMAGE_FORMATS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

export interface InsertDocxImageResult {
  success: boolean;
  message: string;
  blockId?: string;
  fileToken?: string;
  error?: string;
}

/**
 * Insert an image at a specific position in a Feishu Docx document.
 *
 * Communicates with Primary Node via IPC, which performs the actual
 * 3-step Feishu API calls (create block, upload file, bind image).
 *
 * @param params - Tool parameters
 * @param params.documentId - The Feishu document ID (from URL or API)
 * @param params.imagePath - Local file path of the image to insert
 * @param params.index - Zero-based position in the document's block list
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
    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
      throw new Error('index must be a non-negative integer');
    }

    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image insertion cannot proceed: Platform is not configured.',
      };
    }

    // Resolve file path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Validate file
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_IMAGE_FORMATS.includes(ext)) {
      return {
        success: false,
        error: `Unsupported image format: ${ext}`,
        message: `❌ Unsupported image format: ${ext}. Supported: ${SUPPORTED_IMAGE_FORMATS.join(', ')}`,
      };
    }

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      return {
        success: false,
        error: `Path is not a file: ${imagePath}`,
        message: `❌ Not a file: ${imagePath}`,
      };
    }

    if (stats.size > 20 * 1024 * 1024) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        success: false,
        error: `Image file too large: ${sizeMB}MB (max 20MB)`,
        message: `❌ Image too large: ${sizeMB}MB. Maximum size for docx images is 20MB.`,
      };
    }

    // Check IPC availability
    const useIpc = await isIpcAvailable();
    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ documentId, resolvedPath, index }, 'insert_docx_image: calling IPC');

    // Call IPC to Primary Node which has the Feishu client
    const ipcClient = getIpcClient();
    const result = await ipcClient.insertDocxImage(documentId, resolvedPath, index);

    if (!result.success) {
      const errorMsg = result.error || 'Unknown IPC error';
      logger.error({ documentId, imagePath, error: errorMsg }, 'insert_docx_image IPC failed');
      return {
        success: false,
        error: errorMsg,
        message: `❌ Image insertion failed: ${errorMsg}`,
      };
    }

    logger.info({ documentId, blockId: result.blockId, fileToken: result.fileToken, index }, 'Image inserted successfully');

    return {
      success: true,
      message: `✅ Image inserted at position ${index} in document ${documentId}`,
      blockId: result.blockId,
      fileToken: result.fileToken,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, documentId, imagePath, index }, 'insert_docx_image failed');

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to insert image: ${errorMessage}`,
    };
  }
}
