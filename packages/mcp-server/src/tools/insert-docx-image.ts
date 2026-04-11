/**
 * insert_docx_image tool implementation.
 *
 * Inserts an image into a Feishu document at a specified position.
 * Uses the three-step Lark API flow:
 *   1. Upload image via Drive Media Upload API (parent_type: 'docx_image')
 *   2. Create image block in document at the specified index
 *
 * Issue #2278: feat: 支持飞书文档图片正文中插入（inline image insertion）
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';

const logger = createLogger('InsertDocxImage');

/**
 * Result type for insert_docx_image tool.
 */
export interface InsertDocxImageResult {
  success: boolean;
  message: string;
  blockId?: string;
  fileToken?: string;
  error?: string;
}

/**
 * Insert an image into a Feishu document at a specific position.
 *
 * The tool communicates with the Primary Node via IPC, which has access
 * to the authenticated Lark SDK client for Feishu Document API calls.
 *
 * @param params - Tool parameters
 * @param params.documentId - Feishu document ID (from URL or API)
 * @param params.imagePath - Path to image file (relative to workspace or absolute)
 * @param params.index - Optional 0-based insertion position (defaults to end of document)
 */
export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index?: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index } = params;

  try {
    if (!documentId) {
      throw new Error('documentId is required');
    }
    if (!imagePath) {
      throw new Error('imagePath is required');
    }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      logger.warn({ documentId, imagePath }, 'insert_docx_image skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Cannot insert image: Platform is not configured.',
      };
    }

    // Resolve relative paths against workspace dir
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Verify file exists
    try {
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${imagePath}`);
      }
    } catch {
      throw new Error(`File not found: ${imagePath}`);
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

    logger.debug({ documentId, resolvedPath, index }, 'insert_docx_image: sending IPC request');

    const result = await getIpcClient().insertDocxImage(documentId, resolvedPath, index);

    if (!result.success) {
      logger.warn({ documentId, error: result.error }, 'insert_docx_image failed via IPC');
      return {
        success: false,
        error: result.error,
        message: `❌ Failed to insert image: ${result.error}`,
      };
    }

    const positionInfo = index !== undefined ? `at position ${index}` : 'at end of document';
    logger.info({ documentId, blockId: result.blockId, fileToken: result.fileToken }, 'Image inserted successfully');

    return {
      success: true,
      blockId: result.blockId,
      fileToken: result.fileToken,
      message: `✅ Image inserted ${positionInfo} in document ${documentId}`,
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
