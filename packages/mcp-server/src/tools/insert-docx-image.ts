/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Inserts an image into a Feishu document at a specified position.
 * Uses IPC to delegate the three-step API flow to the Primary Node:
 * 1. Create empty image block (block_type: 27) at the specified index
 * 2. Upload image file via Drive Media Upload API
 * 3. Bind uploaded file to the image block via replace_image
 *
 * @module mcp-server/tools/insert-docx-image
 */

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
  /** ID of the created image block (on success) */
  blockId?: string;
  /** Human-readable result message */
  message: string;
  /** Error details (on failure) */
  error?: string;
}

/**
 * Insert an image into a Feishu document at a specified position.
 *
 * This tool enables Agents to insert images inline into Feishu documents,
 * rather than only being able to append them to the end. It wraps the
 * three-step Feishu API flow (create block → upload → bind) into a
 * single tool call.
 *
 * Prerequisites:
 * - The document must already exist (use `lark-cli docs +create` first)
 * - The image file must exist on the local filesystem
 * - Primary Node must be running (IPC required)
 *
 * @param params - Tool parameters
 * @param params.documentId - Feishu document ID (from URL or create response)
 * @param params.imagePath - Path to the image file (absolute or relative to workspace)
 * @param params.index - 0-based position where the image block should be inserted
 * @returns Result with blockId on success, or error on failure
 */
export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index } = params;

  try {
    if (!documentId) { throw new Error('documentId is required'); }
    if (!imagePath) { throw new Error('imagePath is required'); }
    if (typeof index !== 'number' || index < 0) {
      throw new Error('index must be a non-negative number');
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    logger.debug({ documentId, imagePath: resolvedPath, index }, 'insert_docx_image called');

    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ Image insertion requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.insertDocxImage(documentId, resolvedPath, index);

    if (result.success) {
      logger.info({ documentId, blockId: result.blockId, index }, 'Image inserted into docx');
      return {
        success: true,
        blockId: result.blockId,
        message: `✅ Image inserted at position ${index} in document ${documentId} (block: ${result.blockId || 'N/A'})`,
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
