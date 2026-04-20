/**
 * Docx Image Service - Insert images into Feishu documents at specified positions.
 *
 * Issue #2278: Implements the 3-step Feishu API flow for inline image insertion:
 * 1. Create empty image block (block_type: 27) at specified index
 * 2. Upload image file via Drive Media Upload API
 * 3. Bind uploaded file to image block via replace_image (batchUpdate)
 *
 * @module services/docx-image-service
 */

import * as fs from 'fs';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';

const logger = createLogger('DocxImageService');

/**
 * Result of inserting an image into a Feishu document.
 */
export interface InsertDocxImageResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

/**
 * Maximum image file size (20MB, matching Feishu API limit for docx_image).
 */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/**
 * Supported image MIME types for Feishu docx images.
 */
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

/**
 * Get MIME type from file extension.
 */
function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Insert an image into a Feishu document at a specified position.
 *
 * This function implements the 3-step API flow described in Issue #2278:
 *
 * Step 1: Create an empty image block at the specified index.
 *   Uses client.docx.documentBlockChildren.create() with block_type: 27
 *
 * Step 2: Upload the image file via Drive Media Upload API.
 *   Uses client.drive.media.uploadAll() with parent_type: "docx_image"
 *
 * Step 3: Update the image block with the uploaded file.
 *   Uses client.docx.documentBlock.batchUpdate() with replace_image request
 *
 * @param client - Lark SDK client instance
 * @param documentId - Feishu document ID
 * @param imagePath - Local file path of the image to insert
 * @param index - Position in the document to insert (0-based, -1 for append)
 * @returns Result with blockId on success or error message on failure
 */
export async function insertDocxImage(
  client: lark.Client,
  documentId: string,
  imagePath: string,
  index: number
): Promise<InsertDocxImageResult> {
  // Validate inputs
  if (!documentId) {
    return { success: false, error: 'documentId is required' };
  }
  if (!imagePath) {
    return { success: false, error: 'imagePath is required' };
  }
  if (typeof index !== 'number' || index < -1) {
    return { success: false, error: 'index must be a non-negative integer or -1 for append' };
  }

  // Validate file exists and is an image
  if (!fs.existsSync(imagePath)) {
    return { success: false, error: `Image file not found: ${imagePath}` };
  }

  const stats = fs.statSync(imagePath);
  if (!stats.isFile()) {
    return { success: false, error: `Path is not a file: ${imagePath}` };
  }
  if (stats.size > MAX_IMAGE_SIZE) {
    return { success: false, error: `Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max 20MB)` };
  }

  const mimeType = getImageMimeType(imagePath);
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    return { success: false, error: `Unsupported image type: ${mimeType}. Supported: PNG, JPEG, GIF, WebP, BMP` };
  }

  logger.info({ documentId, imagePath, index, fileSize: stats.size }, 'Starting docx image insertion');

  try {
    // Step 1: Create empty image block at specified position
    // block_type: 27 = Image block (NOT 4, which is Heading2)
    // The children are created under the document root (block_id = document_id)
    logger.debug({ documentId, index }, 'Step 1: Creating empty image block');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createData: any = {
      children: [
        {
          block_type: 27,
        },
      ],
    };
    if (index >= 0) {
      createData.index = index;
    }

    const createResp = await client.docx.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      params: {
        document_revision_id: -1,
      },
      data: createData,
    });

    if (!createResp?.data?.children || createResp.data.children.length === 0) {
      return { success: false, error: 'Failed to create image block: no children returned' };
    }

    const blockId = createResp.data.children[0].block_id;
    if (!blockId) {
      return { success: false, error: 'Failed to create image block: no block_id returned' };
    }

    logger.debug({ documentId, blockId }, 'Step 1 complete: image block created');

    // Step 2: Upload image file via Drive Media Upload API
    // parent_type: "docx_image" for document images
    logger.debug({ documentId, imagePath }, 'Step 2: Uploading image file');
    const fileName = path.basename(imagePath);
    const uploadResp = await client.drive.media.uploadAll({
      data: {
        parent_type: 'docx_image',
        parent_node: documentId,
        file_name: fileName,
        size: stats.size,
        file: fs.createReadStream(imagePath),
      },
    });

    // uploadAll returns { file_token } directly (not wrapped in data)
    const fileToken = uploadResp?.file_token;
    if (!fileToken) {
      return { success: false, error: 'Failed to upload image: no file_token returned' };
    }

    logger.debug({ documentId, fileToken }, 'Step 2 complete: image uploaded');

    // Step 3: Update block with replace_image via batchUpdate
    // Uses batchUpdate with replace_image request to bind the uploaded file
    logger.debug({ documentId, blockId, fileToken }, 'Step 3: Binding image to block');
    await client.docx.documentBlock.batchUpdate({
      path: {
        document_id: documentId,
      },
      params: {
        document_revision_id: -1,
      },
      data: {
        requests: [
          {
            replace_image: {
              token: fileToken,
            },
            block_id: blockId,
          },
        ],
      },
    });

    logger.info({ documentId, blockId, fileToken }, 'Docx image insertion complete');

    return {
      success: true,
      blockId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, documentId, imagePath, index }, 'Docx image insertion failed');
    return {
      success: false,
      error: `Image insertion failed: ${errorMessage}`,
    };
  }
}
