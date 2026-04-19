/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Insert an image into a Feishu docx document at a specific position.
 *
 * This tool enables agents to insert images inline within Feishu documents
 * at precise positions, rather than appending them to the end.
 *
 * The tool performs a 3-step API process:
 * 1. Create empty image block (block_type: 27) at the specified index
 * 2. Upload image file via Drive Media API (parent_type: "docx_image")
 * 3. Bind uploaded file to image block via batchUpdate (replace_image)
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
 * Insert image into docx via IPC to PrimaryNode's Feishu client.
 * Issue #2278: Uses dedicated insertDocxImage IPC method.
 */
async function insertDocxImageViaIpc(
  documentId: string,
  imagePath: string,
  index?: number,
  caption?: string
): Promise<{ blockId: string }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.insertDocxImage(documentId, imagePath, index, caption);
  if (!result.success) {
    const errorDetail = result.error ? `: ${result.error}` : '';
    throw new Error(`Failed to insert docx image via IPC${errorDetail}`);
  }
  if (!result.blockId) {
    throw new Error('Image insertion succeeded but no blockId was returned');
  }
  return { blockId: result.blockId };
}

export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index?: number;
  caption?: string;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index, caption } = params;

  try {
    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      logger.warn({ imagePath }, 'Docx image insertion skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image cannot be inserted: Platform is not configured.',
      };
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    logger.debug({ documentId, imagePath, resolvedPath, index, caption }, 'insert_docx_image called');

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${imagePath}`);
    }

    // Validate image extension
    const ext = path.extname(resolvedPath).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp'];
    if (!imageExtensions.includes(ext)) {
      throw new Error(`Not an image file: ${path.basename(resolvedPath)} (supported: ${imageExtensions.join(', ')})`);
    }

    // Validate file size (max 20MB for Drive Media upload)
    if (stats.size > 20 * 1024 * 1024) {
      throw new Error(`Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 20MB)`);
    }

    // Validate documentId format (Feishu document IDs are typically alphanumeric)
    if (!documentId || typeof documentId !== 'string') {
      throw new Error('Invalid documentId: must be a non-empty string');
    }

    // Issue #2278: Use IPC for docx image insertion
    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Docx image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ documentId, imagePath: resolvedPath, index }, 'Using IPC for docx image insertion');
    const { blockId } = await insertDocxImageViaIpc(documentId, resolvedPath, index, caption);

    const sizeKB = (stats.size / 1024).toFixed(1);

    logger.info({ documentId, blockId, imagePath: resolvedPath }, 'Image inserted into docx successfully');

    const indexInfo = index !== undefined ? ` at position ${index}` : ' at the end';
    const captionInfo = caption ? ` with caption "${caption}"` : '';

    return {
      success: true,
      message: `✅ Image inserted into document${indexInfo}${captionInfo}\n\n**Document ID:** ${documentId}\n**Block ID:** ${blockId}\n**File:** ${path.basename(resolvedPath)} (${sizeKB} KB)`,
      blockId,
    };

  } catch (error) {
    let platformCode: number | string | undefined;
    let platformMsg: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: unknown } | unknown
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseData = (err as any).response?.data;
      if (responseData && Array.isArray(responseData) && responseData[0]) {
        platformCode = responseData[0].code;
        platformMsg = responseData[0].msg;
      }
      if (!platformCode && typeof err.code === 'number') {
        platformCode = err.code;
      }
      if (!platformMsg) {
        platformMsg = err.msg || err.message;
      }
    }

    logger.error({ err: error, documentId, imagePath, platformCode, platformMsg }, 'insert_docx_image failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let errorDetails = `❌ Failed to insert image into docx: ${errorMessage}`;
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
