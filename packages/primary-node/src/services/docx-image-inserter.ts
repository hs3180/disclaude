/**
 * Docx Image Inserter - Inserts images into Feishu documents at specified positions.
 *
 * Issue #2278: Implements the three-step API flow for inline image insertion:
 * 1. Create an empty image block (block_type: 27) at the specified index
 * 2. Upload image file via Drive Media Upload API
 * 3. Bind uploaded file to the image block via batchUpdate with replace_image
 *
 * @module services/docx-image-inserter
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@disclaude/core';
import type * as lark from '@larksuiteoapi/node-sdk';

const logger = createLogger('DocxImageInserter');

/** Maximum image file size for docx insertion (20 MB). */
const MAX_DOCX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Feishu docx image block type constant. */
const BLOCK_TYPE_IMAGE = 27;

/**
 * Result of inserting an image into a docx document.
 */
export interface InsertDocxImageResult {
  success: boolean;
  /** ID of the created image block (on success) */
  blockId?: string;
  /** Error message (on failure) */
  error?: string;
}

/**
 * DocxImageInserter - Inserts images into Feishu documents at specified positions.
 *
 * Uses the Lark Client to perform the three-step image insertion flow:
 * 1. POST /open-apis/docx/v1/documents/{doc_id}/blocks/{doc_id}/children
 *    → Creates empty image block with block_type: 27
 * 2. POST /open-apis/drive/v1/medias/upload_all
 *    → Uploads the image file with parent_type: "docx_image"
 * 3. POST /open-apis/docx/v1/documents/{doc_id}/blocks/batch_update
 *    → Binds the uploaded file token to the image block via replace_image
 */
export class DocxImageInserter {
  private client: lark.Client;

  constructor(client: lark.Client) {
    this.client = client;
  }

  /**
   * Insert an image into a Feishu document at the specified position.
   *
   * @param documentId - The Feishu document ID (also serves as root block ID)
   * @param imagePath - Local file path of the image to insert
   * @param index - 0-based position where the image block should be inserted
   * @returns Result with blockId on success, or error on failure
   */
  async insertImage(
    documentId: string,
    imagePath: string,
    index: number,
  ): Promise<InsertDocxImageResult> {
    // ─── Pre-flight validation ────────────────────────────────────────────

    if (!documentId) {
      return { success: false, error: 'documentId is required' };
    }
    if (!imagePath) {
      return { success: false, error: 'imagePath is required' };
    }
    if (typeof index !== 'number' || index < 0) {
      return { success: false, error: 'index must be a non-negative number' };
    }

    // Validate file exists and size
    let fileSize: number;
    try {
      const stat = fs.statSync(imagePath);
      if (!stat.isFile()) {
        return { success: false, error: `Path is not a file: ${imagePath}` };
      }
      fileSize = stat.size;
    } catch {
      return { success: false, error: `File not found: ${imagePath}` };
    }

    if (fileSize > MAX_DOCX_IMAGE_SIZE) {
      return { success: false, error: `Image file too large: ${fileSize} bytes (max ${MAX_DOCX_IMAGE_SIZE / 1024 / 1024}MB)` };
    }

    const fileName = path.basename(imagePath);
    logger.info({ documentId, imagePath: fileName, index, fileSize }, 'Starting docx image insertion');

    // ─── Step 1: Create empty image block ─────────────────────────────────

    let imageBlockId: string;
    try {
      imageBlockId = await this.createEmptyImageBlock(documentId, index);
      logger.debug({ documentId, imageBlockId, index }, 'Step 1: Created empty image block');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, documentId, index }, 'Step 1 failed: create image block');
      return { success: false, error: `Failed to create image block: ${msg}` };
    }

    // ─── Step 2: Upload image file ────────────────────────────────────────

    let fileToken: string;
    try {
      fileToken = await this.uploadImageFile(documentId, imagePath, fileSize);
      logger.debug({ documentId, imageBlockId, fileToken }, 'Step 2: Uploaded image file');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, documentId, imagePath: fileName }, 'Step 2 failed: upload image file');
      return { success: false, error: `Failed to upload image file: ${msg}` };
    }

    // ─── Step 3: Bind file to image block ─────────────────────────────────

    try {
      await this.bindImageToFile(documentId, imageBlockId, fileToken);
      logger.debug({ documentId, imageBlockId, fileToken }, 'Step 3: Bound file to image block');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, documentId, imageBlockId, fileToken }, 'Step 3 failed: bind image');
      return { success: false, error: `Failed to bind image to block: ${msg}` };
    }

    logger.info({ documentId, imageBlockId, index, fileName }, 'Docx image inserted successfully');
    return { success: true, blockId: imageBlockId };
  }

  /**
   * Step 1: Create an empty image block at the specified position.
   *
   * Uses the Feishu docx API to create a child block with block_type: 27 (image).
   * The document ID also serves as the root block ID.
   */
  private async createEmptyImageBlock(
    documentId: string,
    index: number,
  ): Promise<string> {
    const resp = await this.client.docx.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children: [
          {
            block_type: BLOCK_TYPE_IMAGE,
            // SDK type expects align/caption/scale; pass empty object for defaults
            image: {},
          },
        ] as Array<{ block_type: number; image: Record<string, unknown> }>,
        index,
      },
    });

    const children = resp?.data?.children;
    if (!children || !Array.isArray(children) || children.length === 0) {
      throw new Error('No children returned from create block API');
    }

    const blockId = children[0]?.block_id;
    if (!blockId) {
      throw new Error('block_id not found in create block response');
    }

    return blockId;
  }

  /**
   * Step 2: Upload image file via Drive Media Upload API.
   *
   * Uses the Feishu Drive API to upload the image file with parent_type "docx_image".
   * Returns the file_token needed for binding in Step 3.
   */
  private async uploadImageFile(
    documentId: string,
    imagePath: string,
    fileSize: number,
  ): Promise<string> {
    const resp = await this.client.drive.media.uploadAll({
      data: {
        parent_type: 'docx_image',
        parent_node: documentId,
        file: fs.createReadStream(imagePath),
        file_name: path.basename(imagePath),
        size: fileSize,
      },
    });

    // SDK returns file_token directly (not wrapped in .data)
    const fileToken = resp?.file_token;
    if (!fileToken) {
      throw new Error('file_token not returned from upload API');
    }

    return fileToken;
  }

  /**
   * Step 3: Bind the uploaded file to the image block via batchUpdate.
   *
   * Uses the Feishu docx API's batchUpdate with replace_image request to
   * associate the uploaded file with the previously created empty image block.
   *
   * Note: Uses type assertion because the SDK's batchUpdate types are
   * focused on text element updates; replace_image is a valid API operation
   * but not fully typed in the SDK.
   */
  private async bindImageToFile(
    documentId: string,
    blockId: string,
    fileToken: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.client.docx.documentBlock as any).batchUpdate({
      path: {
        document_id: documentId,
      },
      data: {
        requests: [
          {
            replace_image: {
              block_id: blockId,
              token: fileToken,
            },
          },
        ],
        document_revision_id: -1,
      },
    });
  }
}
