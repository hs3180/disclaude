/**
 * Feishu document image insertion utility.
 *
 * Implements the 3-step API flow to insert an image at a specific position
 * in a Feishu document (docx):
 *
 * 1. Create an empty image block (block_type: 27) at the specified index
 * 2. Upload the image file via Drive Media Upload API (parent_type: "docx_image")
 * 3. Bind the uploaded image to the block via replace_image
 *
 * Issue #2278: Inline image insertion support.
 *
 * @module primary-node/platforms/feishu/docx-image-inserter
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';

const logger = createLogger('DocxImageInserter');

/** Maximum image file size for Drive upload (20 MB). */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Image file extensions accepted for docx insertion. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico', '.svg',
]);

/** Result of a successful image insertion. */
export interface InsertDocxImageResult {
  /** ID of the created image block in the document. */
  blockId: string;
  /** File token of the uploaded image. */
  fileToken: string;
}

/**
 * Insert an image into a Feishu document at a specific position.
 *
 * @param client - Lark SDK client with authenticated credentials
 * @param documentId - Feishu document ID (from URL: /docx/{documentId})
 * @param imagePath - Absolute path to the local image file
 * @param opts - Optional parameters
 * @returns The block ID and file token of the inserted image
 *
 * @throws Error if the image file is invalid, too large, or API calls fail
 */
export async function insertDocxImage(
  client: lark.Client,
  documentId: string,
  imagePath: string,
  opts?: {
    /** Insert position index (0-based). Omit to append at end. */
    index?: number;
    /** Image width in pixels. */
    width?: number;
    /** Image height in pixels. */
    height?: number;
    /** Caption text below the image. */
    caption?: string;
  }
): Promise<InsertDocxImageResult> {
  const { index, width, height, caption } = opts ?? {};

  // Validate image file
  const ext = path.extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported image format: ${ext}. Supported: ${[...IMAGE_EXTENSIONS].join(', ')}`
    );
  }

  const stats = fs.statSync(imagePath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a file: ${imagePath}`);
  }
  if (stats.size > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max ${MAX_IMAGE_SIZE / 1024 / 1024} MB)`
    );
  }

  const fileName = path.basename(imagePath);

  logger.info(
    { documentId, imagePath, fileName, index, fileSize: stats.size },
    'Starting docx image insertion (3-step process)'
  );

  // Step 1: Create an empty image block (block_type: 27) at the specified index
  logger.debug({ documentId, index }, 'Step 1/3: Creating empty image block');
  const createResp = await client.docx.documentBlockChildren.create({
    data: {
      children: [
        {
          block_type: 27, // Image block type
        },
      ],
      ...(index !== undefined && index >= 0 ? { index } : {}),
    },
    path: {
      document_id: documentId,
      block_id: documentId, // Parent block is the document root
    },
  });

  // Extract the block ID from the response
  const children = createResp?.data?.children;
  if (!children || !Array.isArray(children) || children.length === 0) {
    throw new Error('Failed to create image block: no children returned in response');
  }
  const blockId = (children[0] as { block_id?: string })?.block_id;
  if (!blockId) {
    throw new Error('Failed to create image block: block_id not found in response');
  }
  logger.debug({ documentId, blockId }, 'Step 1/3: Image block created');

  // Step 2: Upload the image file via Drive Media Upload API
  logger.debug({ documentId, fileName }, 'Step 2/3: Uploading image file');
  const uploadResp = await client.drive.media.uploadAll({
    data: {
      file_name: fileName,
      parent_type: 'docx_image',
      parent_node: documentId,
      size: stats.size,
      file: fs.createReadStream(imagePath),
    },
  });

  const fileToken = uploadResp?.file_token;
  if (!fileToken) {
    throw new Error('Failed to upload image: no file_token returned');
  }
  logger.debug({ documentId, blockId, fileToken }, 'Step 2/3: Image uploaded');

  // Step 3: Bind the uploaded image to the block via replace_image
  logger.debug({ documentId, blockId, fileToken }, 'Step 3/3: Binding image to block');
  await client.docx.documentBlock.patch({
    data: {
      replace_image: {
        token: fileToken,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(caption ? { caption: { content: caption } } : {}),
      },
    },
    path: {
      document_id: documentId,
      block_id: blockId,
    },
  });

  logger.info(
    { documentId, blockId, fileToken, fileName, index },
    'Docx image insertion completed successfully'
  );

  return { blockId, fileToken };
}
