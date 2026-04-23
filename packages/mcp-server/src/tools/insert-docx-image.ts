/**
 * insert_docx_image tool implementation.
 *
 * Issue #2278: Insert an image at a specific position in a Feishu document.
 *
 * This tool implements the three-step Feishu API flow for inline image insertion:
 * 1. Create an empty image block (block_type: 27) at the specified index
 * 2. Upload the image file via Drive Media Upload API
 * 3. Bind the uploaded file to the image block via replace_image
 *
 * This bypasses lark-cli's `docs +media-insert` limitation which always
 * appends images to the end of the document.
 *
 * @module mcp-server/tools/insert-docx-image
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { InsertDocxImageResult } from './types.js';

const logger = createLogger('InsertDocxImage');

/** Feishu open API base URL */
const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';

/** Maximum image file size: 20 MB */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Supported image MIME types */
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
]);

/**
 * Get a Feishu tenant access token using app credentials.
 */
async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const url = `${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  const data = await res.json() as { code?: number; msg?: string; tenant_access_token?: string };

  if (data.code !== 0) {
    throw new Error(`Failed to get tenant access token: code=${data.code}, msg=${data.msg}`);
  }

  if (!data.tenant_access_token) {
    throw new Error('Tenant access token not found in response');
  }

  return data.tenant_access_token;
}

/**
 * Step 1: Create an empty image block at the specified position.
 *
 * API: POST /open-apis/docx/v1/documents/{document_id}/blocks/{document_id}/children
 * block_type 27 = image block
 *
 * @returns The block_id of the newly created image block
 */
async function createImageBlock(
  token: string,
  documentId: string,
  index: number,
): Promise<string> {
  const url = `${FEISHU_OPEN_API}/docx/v1/documents/${documentId}/blocks/${documentId}/children`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      children: [
        {
          block_type: 27, // Image block type
          image: {
            width: 0,  // Will be auto-calculated after binding
            height: 0,
          },
        },
      ],
      index,
    }),
  });

  const data = await res.json() as {
    code?: number;
    msg?: string;
    data?: {
      children?: Array<{ block_id?: string }>;
    };
  };

  if (data.code !== 0) {
    throw new Error(`Failed to create image block: code=${data.code}, msg=${data.msg}`);
  }

  const blockId = data.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error('Image block created but block_id not returned');
  }

  return blockId;
}

/**
 * Step 2: Upload an image file to Feishu Drive.
 *
 * API: POST /open-apis/drive/v1/medias/upload_all
 * parent_type: "docx_image" for document image embedding
 *
 * @returns The file_token of the uploaded image
 */
async function uploadImageFile(
  token: string,
  documentId: string,
  imageBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const url = `${FEISHU_OPEN_API}/drive/v1/medias/upload_all`;

  // Build multipart form data manually (native fetch doesn't have FormData
  // with file support in all Node versions, but Node 20+ supports it)
  const formData = new FormData();
  formData.append('file_type', 'message');
  formData.append('file_name', fileName);
  formData.append('parent_type', 'docx_image');
  formData.append('parent_node', documentId);

  // Create a Blob from the buffer for the file part
  const blob = new Blob([imageBuffer]);
  formData.append('file', blob, fileName);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });

  const data = await res.json() as {
    code?: number;
    msg?: string;
    data?: { file_token?: string };
  };

  if (data.code !== 0) {
    throw new Error(`Failed to upload image: code=${data.code}, msg=${data.msg}`);
  }

  const fileToken = data.data?.file_token;
  if (!fileToken) {
    throw new Error('Image uploaded but file_token not returned');
  }

  return fileToken;
}

/**
 * Step 3: Bind the uploaded image to the image block.
 *
 * API: PATCH /open-apis/docx/v1/documents/{document_id}/blocks/{block_id}
 * Uses replace_image update element to associate the uploaded file with the block.
 */
async function bindImageToBlock(
  token: string,
  documentId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  const url = `${FEISHU_OPEN_API}/docx/v1/documents/${documentId}/blocks/${blockId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      request_id: `insert_image_${Date.now()}`,
      update_image: {
        replace_image: {
          token: fileToken,
        },
      },
    }),
  });

  const data = await res.json() as { code?: number; msg?: string };

  if (data.code !== 0) {
    throw new Error(`Failed to bind image to block: code=${data.code}, msg=${data.msg}`);
  }
}

/**
 * Detect MIME type from file extension.
 */
function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

/**
 * Insert an image at a specific position in a Feishu document.
 *
 * @param params - Tool parameters
 * @param params.documentId - The Feishu document ID
 * @param params.imagePath - Path to the image file (absolute or relative to workspace)
 * @param params.index - The 0-based position to insert the image at
 * @returns Result with success status and metadata
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
      return { success: false, message: '❌ documentId is required', error: 'missing_documentId' };
    }
    if (!imagePath) {
      return { success: false, message: '❌ imagePath is required', error: 'missing_imagePath' };
    }
    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
      return { success: false, message: '❌ index must be a non-negative integer', error: 'invalid_index' };
    }

    // Check credentials
    const { appId, appSecret } = getFeishuCredentials();
    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ Image insertion skipped: Platform is not configured.',
      };
    }

    // Resolve and validate file path
    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceDir, imagePath);

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      return { success: false, message: `❌ Path is not a file: ${imagePath}`, error: 'not_a_file' };
    }

    if (stats.size > MAX_IMAGE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      return {
        success: false,
        message: `❌ Image file too large: ${sizeMB} MB (max 20 MB)`,
        error: 'file_too_large',
      };
    }

    // Validate image type
    const mimeType = getMimeTypeFromPath(resolvedPath);
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      return {
        success: false,
        message: `❌ Unsupported image type: ${mimeType}. Supported: PNG, JPEG, GIF, WebP, BMP, SVG`,
        error: 'unsupported_type',
      };
    }

    logger.debug({ documentId, imagePath: resolvedPath, index, fileSize: stats.size, mimeType }, 'Starting image insertion');

    // Step 0: Get tenant access token
    const token = await getTenantAccessToken(appId, appSecret);

    // Step 1: Create empty image block at position
    logger.debug({ documentId, index }, 'Step 1: Creating image block');
    const blockId = await createImageBlock(token, documentId, index);

    // Step 2: Upload image file
    logger.debug({ documentId, blockId }, 'Step 2: Uploading image file');
    const imageBuffer = await fs.readFile(resolvedPath);
    const fileName = path.basename(resolvedPath);
    const fileToken = await uploadImageFile(token, documentId, imageBuffer, fileName);

    // Step 3: Bind image to block
    logger.debug({ documentId, blockId, fileToken }, 'Step 3: Binding image to block');
    await bindImageToBlock(token, documentId, blockId, fileToken);

    const sizeKB = (stats.size / 1024).toFixed(1);
    logger.info({ documentId, blockId, fileToken, index, fileName }, 'Image inserted successfully');

    return {
      success: true,
      message: `✅ Image inserted at position ${index}: ${fileName} (${sizeKB} KB, block: ${blockId})`,
      blockId,
      fileToken,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, documentId, imagePath, index }, 'insert_docx_image failed');

    // Extract platform error details if available
    let platformCode: number | undefined;
    let platformMsg: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & { code?: number; msg?: string };
      if (typeof err.code === 'number') { platformCode = err.code; }
      if (err.msg) { platformMsg = err.msg; }
    }

    let message = `❌ Failed to insert image: ${errorMessage}`;
    if (platformCode) {
      message += `\n**Platform API Error:** Code: ${platformCode}`;
      if (platformMsg) { message += `, Message: ${platformMsg}`; }
    }

    return {
      success: false,
      error: errorMessage,
      message,
      platformCode,
      platformMsg,
    };
  }
}
