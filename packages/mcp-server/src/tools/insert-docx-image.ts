/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Insert an image at a specific position in a Feishu document.
 *
 * Feishu's `lark-cli docs +media-insert` always appends images to the end of a document.
 * This tool uses the Feishu API directly to support position-based image insertion:
 *   1. Upload image via Drive Media Upload API (parent_type: "docx_image")
 *   2. Create image block at the specified index via docx.documentBlockChildren.create
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { InsertDocxImageResult } from './types.js';

const logger = createLogger('InsertDocxImage');

/** Image block type in Feishu docx API */
const BLOCK_TYPE_IMAGE = 27;

/**
 * Lark client type (subset used by this module).
 * Issue #918: Define explicit interface for dependency injection instead of mocking SDK.
 */
export interface LarkDocxClient {
  drive: {
    media: {
      uploadAll: (payload: {
        data: {
          file_name: string;
          parent_type: string;
          parent_node: string;
          size: number;
          file: Buffer;
        };
      }) => Promise<{ file_token?: string } | null>;
    };
  };
  docx: {
    documentBlockChildren: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (payload: any) => Promise<any>;
    };
  };
}

/**
 * Factory for creating Lark Client instances.
 * Overridable for testing via _setLarkClientFactory().
 */
let larkClientFactory = (appId: string, appSecret: string): LarkDocxClient => {
  return new lark.Client({
    appId,
    appSecret,
    domain: lark.Domain.Feishu,
  }) as unknown as LarkDocxClient;
};

/**
 * Override the Lark client factory (for testing only).
 * Issue #918: Dependency injection instead of vi.mock() for external SDKs.
 */
export function _setLarkClientFactory(factory: typeof larkClientFactory) {
  larkClientFactory = factory;
}

/**
 * Reset the Lark client factory to default (for testing teardown).
 */
export function _resetLarkClientFactory() {
  larkClientFactory = (appId, appSecret) => {
    return new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    }) as unknown as LarkDocxClient;
  };
}

/**
 * Validate that a string looks like a Feishu document ID.
 * Document IDs are typically alphanumeric strings.
 */
function isValidDocumentId(id: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(id) && id.length > 0;
}

/**
 * Validate that the index is a non-negative integer or -1 (append to end).
 */
function isValidIndex(index: number): boolean {
  return Number.isInteger(index) && (index >= -1);
}

/**
 * Insert an image at a specific position in a Feishu document.
 *
 * @param params.documentId - The Feishu document ID
 * @param params.imagePath - Path to the image file (relative to workspace or absolute)
 * @param params.index - Position to insert at (0-based). -1 or omitted means append to end.
 * @param params.caption - Optional caption for the image
 */
export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index?: number;
  caption?: string;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index, caption } = params;

  logger.info({ documentId, imagePath, index }, 'insert_docx_image called');

  try {
    // Validate required params
    if (!documentId) {
      throw new Error('documentId is required');
    }
    if (!imagePath) {
      throw new Error('imagePath is required');
    }
    if (!isValidDocumentId(documentId)) {
      throw new Error(`Invalid documentId: ${documentId}`);
    }
    if (index !== undefined && !isValidIndex(index)) {
      throw new Error(`Invalid index: ${index}. Must be a non-negative integer or -1 (append).`);
    }

    // Get credentials
    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Please set FEISHU_APP_ID and FEISHU_APP_SECRET.';
      logger.error({ documentId }, errorMsg);
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Resolve image path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Verify file exists and is a file
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${imagePath}`);
    }

    const fileSize = stats.size;
    const fileName = path.basename(resolvedPath);

    logger.debug({ documentId, resolvedPath, fileSize, index }, 'Inserting docx image');

    // Create Lark client via injectable factory
    const client = larkClientFactory(appId, appSecret);

    // Step 1: Upload image via Drive Media Upload API
    logger.debug({ documentId, fileName, fileSize }, 'Uploading image to Drive');
    const fileBuffer = await fs.readFile(resolvedPath);
    const uploadResp = await client.drive.media.uploadAll({
      data: {
        file_name: fileName,
        parent_type: 'docx_image',
        parent_node: documentId,
        size: fileSize,
        file: fileBuffer,
      },
    });

    const fileToken = uploadResp?.file_token;
    if (!fileToken) {
      throw new Error('Image upload succeeded but no file_token was returned');
    }

    logger.info({ documentId, fileToken, fileName }, 'Image uploaded to Drive');

    // Step 2: Create image block at the specified position
    const imageBlock: Record<string, unknown> = {
      token: fileToken,
    };
    if (caption) {
      imageBlock.caption = { content: caption };
    }

    const createData: Record<string, unknown> = {
      children: [{
        block_type: BLOCK_TYPE_IMAGE,
        image: imageBlock,
      }],
    };

    // Set index if specified (omit to append to end by default)
    if (index !== undefined && index >= 0) {
      createData.index = index;
    }

    logger.debug({ documentId, index, fileToken }, 'Creating image block');
    const blockResp = await client.docx.documentBlockChildren.create({
      data: createData,
      path: {
        document_id: documentId,
        block_id: documentId, // Root block ID is the document ID
      },
    });

    // The lark SDK response has deeply nested optional types; cast for safe access
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = blockResp as any;
    const blockId: string | undefined = resp?.data?.children?.[0]?.block_id;
    const respCode: number | undefined = resp?.code;

    if (respCode !== undefined && respCode !== 0) {
      const respMsg: string | undefined = resp?.msg ?? 'Unknown error';
      throw new Error(`Feishu API error: code=${respCode}, msg=${respMsg}`);
    }

    logger.info({
      documentId,
      blockId,
      fileToken,
      index,
      fileName,
    }, 'Image block created successfully');

    const positionDesc = index !== undefined && index >= 0
      ? `at index ${index}`
      : 'at end of document';

    return {
      success: true,
      message: `✅ Image inserted ${positionDesc} in document ${documentId}`,
      blockId,
      fileToken,
      fileName,
      fileSize,
    };

  } catch (error) {
    let platformCode: number | undefined;
    let platformMsg: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
      };
      if (typeof err.code === 'number') { platformCode = err.code; }
      platformMsg = err.msg || err.message;
    }

    logger.error({ err: error, documentId, imagePath, platformCode, platformMsg }, 'insert_docx_image failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let errorDetails = `❌ Failed to insert image: ${errorMessage}`;
    if (platformCode) {
      errorDetails += `\n\n**Feishu API Error:** Code: ${platformCode}`;
      if (platformMsg) { errorDetails += `, Message: ${platformMsg}`; }
    }

    return {
      success: false,
      error: errorMessage,
      message: errorDetails,
      platformCode,
      platformMsg,
    };
  }
}
