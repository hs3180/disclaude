/**
 * insert_docx_image tool implementation.
 *
 * Inserts an image at a specified position in a Feishu document using
 * the 3-step API flow:
 * 1. Create empty image block (block_type: 27) at the target index
 * 2. Upload image file via Drive Media Upload API (parent_type: docx_image)
 * 3. Bind uploaded file to image block via replace_image
 *
 * Issue #2278: Support inline image insertion in Feishu documents.
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import {
  getTenantAccessToken,
  createImageBlock,
  uploadDocxImage,
  replaceImageBlock,
} from './feishu-docx-api.js';
import type { InsertDocxImageResult } from './types.js';

const logger = createLogger('InsertDocxImage');

/**
 * Insert an image at a specified position in a Feishu document.
 *
 * @param params - Tool parameters
 * @param params.documentId - Feishu document ID (from URL: /docx/{documentId})
 * @param params.imagePath - Path to the image file (relative to workspace or absolute)
 * @param params.index - 0-based position to insert the image block in the document
 * @returns Result with block ID and success status
 */
export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index } = params;

  try {
    // Validate required parameters
    if (!documentId) {
      return { success: false, message: '❌ documentId is required', error: 'Missing documentId' };
    }
    if (!imagePath) {
      return { success: false, message: '❌ imagePath is required', error: 'Missing imagePath' };
    }
    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
      return { success: false, message: '❌ index must be a non-negative integer', error: 'Invalid index' };
    }

    // Get Feishu credentials
    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      return {
        success: false,
        message: '⚠️ Feishu credentials not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET.',
        error: 'Missing credentials',
      };
    }

    // Resolve image path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(workspaceDir, imagePath);

    // Verify file exists
    if (!fs.existsSync(resolvedPath)) {
      return {
        success: false,
        message: `❌ Image file not found: ${imagePath}`,
        error: `File not found: ${resolvedPath}`,
      };
    }

    const fileStats = fs.statSync(resolvedPath);
    if (!fileStats.isFile()) {
      return {
        success: false,
        message: `❌ Path is not a file: ${imagePath}`,
        error: `Not a file: ${resolvedPath}`,
      };
    }

    const fileName = path.basename(resolvedPath);
    const sizeKB = (fileStats.size / 1024).toFixed(1);

    logger.info({ documentId, imagePath: resolvedPath, index, fileName }, 'Starting docx image insertion');

    // Step 0: Get tenant access token
    const token = await getTenantAccessToken(appId, appSecret);

    // Step 1: Create empty image block at the target index
    logger.debug({ documentId, index }, 'Step 1: Creating empty image block');
    const blockId = await createImageBlock(token, documentId, index);
    logger.debug({ blockId }, 'Image block created');

    // Step 2: Upload image file via Drive Media Upload API
    logger.debug({ imagePath: resolvedPath }, 'Step 2: Uploading image file');
    const fileToken = await uploadDocxImage(token, resolvedPath);
    logger.debug({ fileToken }, 'Image uploaded');

    // Step 3: Bind uploaded file to image block
    logger.debug({ blockId, fileToken }, 'Step 3: Binding image to block');
    await replaceImageBlock(token, documentId, blockId, fileToken);

    logger.info({ documentId, blockId, index, fileName }, 'Docx image inserted successfully');

    return {
      success: true,
      message: `✅ Image inserted at position ${index} in document ${documentId} (${fileName}, ${sizeKB} KB)`,
      blockId,
      index,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, documentId, imagePath, index }, 'Failed to insert docx image');

    return {
      success: false,
      message: `❌ Failed to insert image: ${errorMessage}`,
      error: errorMessage,
    };
  }
}
