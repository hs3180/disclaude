/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Inline image insertion into Feishu documents.
 *
 * Inserts an image into a Feishu document body at a specified position using
 * the three-step Feishu Document API:
 *
 *   Step 1: Create an empty image block (block_type: 27)
 *   Step 2: Upload the image file to get a file token
 *   Step 3: Bind the uploaded image to the block via replace_image
 *
 * Unlike messaging tools that go through IPC, document operations call the
 * Feishu API directly since there is no existing IPC path for document
 * mutations.
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { InsertDocxImageResult } from './types.js';

const logger = createLogger('InsertDocxImage');

/** Feishu Open API base URL */
const FEISHU_API_BASE = 'https://open.feishu.cn';

/** Feishu block type for image */
const BLOCK_TYPE_IMAGE = 27;

/** Maximum image file size: 20 MB */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/**
 * Get a tenant_access_token from Feishu.
 *
 * @see https://open.feishu.cn/document/server-docs/authentication/tenant_access_token/tenant-access-token-of-custom-app
 */
async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<string> {
  const url = `${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal/`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = await resp.json() as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(
      `Failed to obtain tenant_access_token: code=${data.code}, msg=${data.msg}`,
    );
  }

  return data.tenant_access_token;
}

/**
 * Step 1: Create an empty image block in the document.
 *
 * @see https://open.feishu.cn/document/server-docs/docs/docx-v1/document-block-children/create
 */
async function createImageBlock(
  documentId: string,
  index: number,
  token: string,
): Promise<string> {
  const url =
    `${FEISHU_API_BASE}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children?document_revision_id=-1`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      children: [{ block_type: BLOCK_TYPE_IMAGE, image: {} }],
      index,
    }),
  });

  const data = await resp.json() as {
    code: number;
    msg: string;
    data?: {
      children?: Array<{ block_id?: string }>;
    };
  };

  if (data.code !== 0) {
    throw new Error(
      `Failed to create image block: code=${data.code}, msg=${data.msg}`,
    );
  }

  const blockId = data.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error(
      'Failed to create image block: block_id not returned in response',
    );
  }

  return blockId;
}

/**
 * Step 2: Upload image file to Feishu Drive.
 *
 * @see https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all
 */
async function uploadImage(
  filePath: string,
  imageBlockId: string,
  token: string,
): Promise<string> {
  const fileBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const fileSize = fileBuffer.length;

  if (fileSize > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image file too large: ${(fileSize / 1024 / 1024).toFixed(2)} MB (max 20 MB)`,
    );
  }

  // Build multipart/form-data manually using FormData (available in Node 18+)
  const formData = new FormData();
  formData.append('file_name', fileName);
  formData.append('parent_type', 'docx_image');
  formData.append('parent_node', imageBlockId);
  formData.append('size', String(fileSize));
  formData.append(
    'file',
    new Blob([fileBuffer]),
    fileName,
  );

  const url = `${FEISHU_API_BASE}/open-apis/drive/v1/medias/upload_all`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const data = await resp.json() as {
    code: number;
    msg: string;
    data?: { file_token?: string };
  };

  if (data.code !== 0) {
    throw new Error(
      `Failed to upload image: code=${data.code}, msg=${data.msg}`,
    );
  }

  const fileToken = data.data?.file_token;
  if (!fileToken) {
    throw new Error(
      'Failed to upload image: file_token not returned in response',
    );
  }

  return fileToken;
}

/**
 * Step 3: Bind the uploaded image to the block.
 *
 * @see https://open.feishu.cn/document/server-docs/docs/docx-v1/document-block/patch
 */
async function replaceImageBlock(
  documentId: string,
  blockId: string,
  fileToken: string,
  token: string,
): Promise<void> {
  const url =
    `${FEISHU_API_BASE}/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}?document_revision_id=-1`;

  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replace_image: { token: fileToken },
    }),
  });

  const data = await resp.json() as {
    code: number;
    msg: string;
  };

  if (data.code !== 0) {
    throw new Error(
      `Failed to bind image to block: code=${data.code}, msg=${data.msg}`,
    );
  }
}

/**
 * Insert an image into a Feishu document.
 *
 * @param params.documentId - The document ID (from URL: /docx/{documentId})
 * @param params.filePath - Path to the image file (relative to workspace or absolute)
 * @param params.index - 0-based position to insert at (default: append to end)
 */
export async function insert_docx_image(params: {
  documentId: string;
  filePath: string;
  index?: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, filePath, index } = params;

  try {
    if (!documentId) {
      throw new Error('documentId is required');
    }
    if (!filePath) {
      throw new Error('filePath is required');
    }

    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'Platform credentials not configured',
        message:
          '⚠️ Image insertion skipped: Platform credentials are not configured.',
      };
    }

    // Resolve file path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceDir, filePath);

    logger.debug(
      { documentId, filePath, resolvedPath, index },
      'insert_docx_image called',
    );

    // Verify file exists and get stats
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    if (stats.size > MAX_IMAGE_SIZE) {
      throw new Error(
        `Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)} MB (max 20 MB)`,
      );
    }

    // Step 0: Acquire tenant_access_token
    logger.debug({ documentId }, 'Acquiring tenant_access_token');
    const token = await getTenantAccessToken(appId, appSecret);

    // Step 1: Create empty image block
    const insertIndex = index ?? -1; // -1 means append
    logger.debug(
      { documentId, insertIndex },
      'Creating image block',
    );
    const blockId = await createImageBlock(documentId, insertIndex, token);
    logger.debug({ documentId, blockId }, 'Image block created');

    // Step 2: Upload image file
    logger.debug(
      { documentId, blockId, filePath: resolvedPath },
      'Uploading image',
    );
    const fileToken = await uploadImage(resolvedPath, blockId, token);
    logger.debug({ documentId, blockId, fileToken }, 'Image uploaded');

    // Step 3: Bind image to block
    logger.debug(
      { documentId, blockId, fileToken },
      'Binding image to block',
    );
    await replaceImageBlock(documentId, blockId, fileToken, token);

    const fileName = path.basename(resolvedPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    logger.info(
      { documentId, blockId, fileName, sizeMB },
      'Image inserted into document successfully',
    );

    return {
      success: true,
      message: `✅ Image inserted into document: ${fileName} (${sizeMB} MB) at block ${blockId}`,
      blockId,
      fileToken,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    logger.error(
      { err: error, documentId, filePath },
      'insert_docx_image failed',
    );
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to insert image: ${errorMessage}`,
    };
  }
}
