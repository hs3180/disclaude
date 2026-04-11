/**
 * Feishu Document Image Inserter.
 *
 * Inserts an image into a Feishu document at a specific position using
 * the three-step API flow:
 *   1. Upload image to Drive via media upload API (parent_type: 'docx_image')
 *   2. Create image block in document at specified index
 *
 * Issue #2278: feat: 支持飞书文档图片正文中插入（inline image insertion）
 *
 * @module utils/docx-image-inserter
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';

const logger = createLogger('DocxImageInserter');

/** Maximum image file size for Drive media upload (20 MB). */
const MAX_MEDIA_SIZE = 20 * 1024 * 1024;

/** Image file extensions recognized by Feishu. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico', '.svg',
]);

/** Block type for image in Feishu document API. */
const BLOCK_TYPE_IMAGE = 27;

/**
 * Result of inserting an image into a document.
 */
export interface InsertDocxImageResult {
  success: boolean;
  blockId?: string;
  fileToken?: string;
  error?: string;
}

/**
 * Insert an image into a Feishu document at a specific position.
 *
 * @param client - Authenticated Lark SDK client
 * @param documentId - Feishu document ID
 * @param imagePath - Absolute path to the image file
 * @param index - Optional 0-based insertion position (defaults to end of document)
 * @returns Result with blockId and fileToken on success
 */
export async function insertDocxImage(
  client: lark.Client,
  documentId: string,
  imagePath: string,
  index?: number,
): Promise<InsertDocxImageResult> {
  // ── Validate inputs ────────────────────────────────────────────────
  if (!documentId) {
    return { success: false, error: 'documentId is required' };
  }
  if (!imagePath) {
    return { success: false, error: 'imagePath is required' };
  }

  // Check file exists and get metadata
  let fileSize: number;
  try {
    const stats = fs.statSync(imagePath);
    if (!stats.isFile()) {
      return { success: false, error: `Path is not a file: ${imagePath}` };
    }
    fileSize = stats.size;
  } catch {
    return { success: false, error: `File not found: ${imagePath}` };
  }

  // Validate file extension
  const ext = path.extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return { success: false, error: `Unsupported image format: ${ext}. Supported: ${[...IMAGE_EXTENSIONS].join(', ')}` };
  }

  // Validate file size
  if (fileSize > MAX_MEDIA_SIZE) {
    return { success: false, error: `Image file too large: ${(fileSize / 1024 / 1024).toFixed(2)} MB (max ${MAX_MEDIA_SIZE / 1024 / 1024} MB)` };
  }

  const fileName = path.basename(imagePath);

  try {
    // ── Step 1: Upload image to Drive with docx_image parent_type ────
    logger.info({ documentId, fileName, fileSize, index }, 'Step 1: Uploading image to Drive');

    const uploadResult = await client.drive.media.uploadAll({
      data: {
        file_name: fileName,
        parent_type: 'docx_image',
        parent_node: documentId,
        size: fileSize,
        file: fs.createReadStream(imagePath),
      },
    });

    const fileToken = uploadResult?.file_token;
    if (!fileToken) {
      return { success: false, error: `Failed to upload image: no file_token returned (file: ${fileName})` };
    }

    logger.info({ documentId, fileToken }, 'Step 1 complete: Image uploaded');

    // ── Step 2: Create image block in document ───────────────────────
    logger.info({ documentId, fileToken, index }, 'Step 2: Creating image block');

    // The Lark SDK types for documentBlockChildren.create use a generic
    // block_type: number with many optional properties. For image blocks
    // (block_type: 27), we need to pass the image token via the 'image'
    // property which the SDK types may not explicitly declare.
    const children: Array<Record<string, unknown>> = [{
      block_type: BLOCK_TYPE_IMAGE,
      image: {
        token: fileToken,
      },
    }];

    const createPayload: Record<string, unknown> = {
      data: {
        children,
        ...(index !== undefined && index >= 0 ? { index } : {}),
      },
      path: {
        document_id: documentId,
        block_id: documentId, // Root block ID = document ID
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createResult = await (client.docx.documentBlockChildren.create as any)(createPayload);

    // Extract block ID from response
    const blockId = extractBlockId(createResult);
    if (!blockId) {
      logger.warn({ documentId, fileToken, createResult }, 'Block created but no block_id in response');
    }

    logger.info({ documentId, blockId, fileToken }, 'Image inserted successfully');

    return {
      success: true,
      blockId: blockId ?? undefined,
      fileToken,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, documentId, imagePath, index }, 'Failed to insert image into document');

    // Extract platform error details if available
    let platformDetails = '';
    const errObj = error as { code?: number | string; msg?: string; response?: { data?: Array<{ code?: number; msg?: string }> } };
    if (errObj.response?.data?.[0]) {
      const [firstErr] = errObj.response.data;
      const { code, msg } = firstErr;
      platformDetails = ` (Platform error ${code}: ${msg})`;
    }

    return {
      success: false,
      error: `Failed to insert image: ${errorMessage}${platformDetails}`,
    };
  }
}

/**
 * Extract block ID from the documentBlockChildren.create response.
 *
 * The response structure varies by SDK version but typically contains
 * children array with block_id in the first element.
 */
function extractBlockId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  // Try common response shapes
  const resp = response as Record<string, unknown>;

  // Shape 1: { data: { children: [{ block_id: "..." }] } }
  const data = resp.data as Record<string, unknown> | undefined;
  if (data) {
    const dataChildren = data.children as Array<Record<string, unknown>> | undefined;
    if (dataChildren?.[0]?.block_id) {
      const [firstChild] = dataChildren;
      return String(firstChild.block_id);
    }
    // Shape 2: { data: { block_id: "..." } }
    if (data.block_id) {
      return String(data.block_id);
    }
  }

  // Shape 3: { children: [{ block_id: "..." }] }
  const respChildren = resp.children as Array<Record<string, unknown>> | undefined;
  if (respChildren?.[0]?.block_id) {
    const [firstChild] = respChildren;
    return String(firstChild.block_id);
  }

  return undefined;
}
