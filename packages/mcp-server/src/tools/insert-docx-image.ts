/**
 * insert_docx_image tool implementation.
 *
 * Inserts an image at a specific position in a Feishu document.
 * Implements Issue #2278: 方案 A — encapsulates the 3-step Feishu API call:
 *   1. Create empty image block (block_type: 27) at specified index
 *   2. Upload image via Drive Media Upload API
 *   3. Bind uploaded image to the empty block via replace_image
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';

const logger = createLogger('InsertDocxImage');

// ============================================================================
// Feishu API Helpers
// ============================================================================

/** Feishu API base URL */
const FEISHU_API_BASE = 'https://open.feishu.cn';

/** Cached tenant access token */
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Get a tenant_access_token using app_id/app_secret.
 * Caches the token until near expiry.
 */
async function getTenantAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const { appId, appSecret } = getFeishuCredentials();
  if (!appId || !appSecret) {
    throw new Error('Feishu credentials not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET.');
  }

  const response = await fetch(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get tenant access token: HTTP ${response.status}`);
  }

  const data = await response.json() as { code: number; msg: string; tenant_access_token: string; expire: number };
  if (data.code !== 0) {
    throw new Error(`Feishu auth error: ${data.code} ${data.msg}`);
  }

  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + data.expire * 1000,
  };

  return cachedToken.token;
}

/**
 * Make an authenticated request to Feishu API.
 */
async function feishuApiRequest(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<unknown> {
  const token = await getTenantAccessToken();
  const response = await fetch(`${FEISHU_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json() as { code: number; msg: string; data?: unknown };
  if (data.code !== 0) {
    throw new Error(`Feishu API error (${method} ${endpoint}): ${data.code} ${data.msg}`);
  }
  return data.data;
}

// ============================================================================
// Three-step image insertion
// ============================================================================

/**
 * Step 1: Create an empty image block at the specified index.
 * @returns The block ID of the created image block.
 */
async function createEmptyImageBlock(
  documentId: string,
  index: number,
): Promise<string> {
  logger.debug({ documentId, index }, 'Step 1: Creating empty image block');

  const result = await feishuApiRequest(
    'POST',
    `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    {
      children: [
        {
          block_type: 27, // Image block type
          image: {
            width: 0,
            height: 0,
          },
        },
      ],
      index,
    },
  ) as { children: Array<{ block_id: string }> };

  if (!result?.children?.[0]?.block_id) {
    throw new Error('Failed to create image block: no block_id returned');
  }

  const blockId = result.children[0].block_id;
  logger.debug({ documentId, blockId, index }, 'Empty image block created');
  return blockId;
}

/**
 * Step 2: Upload image file via Drive Media Upload API.
 * @returns The file_token of the uploaded image.
 */
async function uploadImageFile(
  documentId: string,
  imagePath: string,
  fileName: string,
): Promise<string> {
  logger.debug({ documentId, imagePath }, 'Step 2: Uploading image file');

  const token = await getTenantAccessToken();

  // Read the image file
  const fileBuffer = await fs.readFile(imagePath);

  // Create multipart form data using Web API FormData (Node 18+)
  const formData = new FormData();
  formData.append('file_type', '1'); // 1 = image
  formData.append('file_name', fileName);
  formData.append('parent_type', 'docx_image');
  formData.append('parent_node', documentId);
  formData.append('file', new Blob([fileBuffer]), fileName);

  const response = await fetch(`${FEISHU_API_BASE}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });

  const data = await response.json() as { code: number; msg: string; data?: { file_token: string } };
  if (data.code !== 0) {
    throw new Error(`Image upload failed: ${data.code} ${data.msg}`);
  }

  const fileToken = data.data?.file_token;
  if (!fileToken) {
    throw new Error('Image upload succeeded but no file_token returned');
  }

  logger.debug({ documentId, fileToken }, 'Image uploaded');
  return fileToken;
}

/**
 * Step 3: Bind the uploaded image to the empty image block.
 */
async function bindImageToBlock(
  documentId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  logger.debug({ documentId, blockId, fileToken }, 'Step 3: Binding image to block');

  await feishuApiRequest(
    'PATCH',
    `/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`,
    {
      replace_image: {
        token: fileToken,
      },
    },
  );

  logger.debug({ documentId, blockId }, 'Image bound to block');
}

// ============================================================================
// Public tool function
// ============================================================================

export interface InsertDocxImageResult {
  success: boolean;
  message: string;
  blockId?: string;
  error?: string;
}

/**
 * Insert an image at a specific position in a Feishu document.
 *
 * Implements the three-step process from Issue #2278:
 * 1. Create empty image block at specified index
 * 2. Upload image via Drive Media Upload API
 * 3. Bind uploaded image to the block
 *
 * @param params.documentId - The Feishu document ID
 * @param params.imagePath - Path to the image file (relative to workspace or absolute)
 * @param params.index - Position to insert the image at (0-based)
 */
export async function insert_docx_image(params: {
  documentId: string;
  imagePath: string;
  index: number;
}): Promise<InsertDocxImageResult> {
  const { documentId, imagePath, index } = params;

  logger.info({ documentId, imagePath, index }, 'insert_docx_image called');

  try {
    // Validate parameters
    if (!documentId || typeof documentId !== 'string') {
      return { success: false, error: 'documentId is required', message: '❌ documentId 参数不能为空' };
    }
    if (!imagePath || typeof imagePath !== 'string') {
      return { success: false, error: 'imagePath is required', message: '❌ imagePath 参数不能为空' };
    }
    if (typeof index !== 'number' || index < 0) {
      return { success: false, error: 'index must be a non-negative integer', message: '❌ index 必须为非负整数' };
    }

    // Check credentials
    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      const errorMsg = 'Feishu credentials not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET.';
      return { success: false, error: errorMsg, message: `❌ ${errorMsg}` };
    }

    // Resolve file path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    // Verify file exists and is readable
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      return { success: false, error: `Path is not a file: ${imagePath}`, message: `❌ 路径不是文件: ${imagePath}` };
    }

    const fileName = path.basename(resolvedPath);
    logger.debug({ documentId, resolvedPath, fileName, index }, 'Starting image insertion');

    // Step 1: Create empty image block
    const blockId = await createEmptyImageBlock(documentId, index);

    // Step 2: Upload image file
    let fileToken: string;
    try {
      fileToken = await uploadImageFile(documentId, resolvedPath, fileName);
    } catch (uploadError) {
      // Attempt cleanup: delete the empty image block we created
      logger.warn({ documentId, blockId, err: uploadError }, 'Upload failed, attempting to clean up empty block');
      try {
        await feishuApiRequest(
          'DELETE',
          `/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`,
        );
        logger.info({ documentId, blockId }, 'Cleaned up empty block after upload failure');
      } catch (cleanupError) {
        logger.warn({ documentId, blockId, err: cleanupError }, 'Failed to clean up empty block');
      }
      throw uploadError;
    }

    // Step 3: Bind image to block
    await bindImageToBlock(documentId, blockId, fileToken);

    logger.info({ documentId, blockId, index, fileName }, 'Image inserted successfully');
    return {
      success: true,
      blockId,
      message: `✅ Image inserted at index ${index} (block: ${blockId})`,
    };
  } catch (error) {
    logger.error({ err: error, documentId, imagePath, index }, 'insert_docx_image FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to insert image: ${errorMessage}`,
    };
  }
}
