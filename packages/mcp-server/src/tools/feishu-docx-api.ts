/**
 * Feishu Document API utilities for inline image insertion.
 *
 * Provides low-level API wrappers for the 3-step document image insertion flow:
 * 1. Create empty image block (block_type: 27) at a specified index
 * 2. Upload image file via Drive Media Upload API
 * 3. Bind uploaded file to image block via replace_image
 *
 * Issue #2278: Support inline image insertion in Feishu documents.
 *
 * @module mcp-server/tools/feishu-docx-api
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createLogger } from '@disclaude/core';

const logger = createLogger('FeishuDocxApi');

/** Feishu Open API base URL */
const FEISHU_API_BASE = 'https://open.feishu.cn';

/** Maximum image file size for docx upload (20 MB) */
const MAX_DOCX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Image extensions supported by Feishu docx image upload */
const DOCX_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg',
]);

/**
 * Response from creating a document block child.
 */
interface CreateBlockChildResponse {
  code: number;
  msg: string;
  data?: {
    children?: Array<{
      block_id: string;
      block_type: number;
    }>;
  };
}

/**
 * Response from Drive media upload.
 */
interface UploadMediaResponse {
  code: number;
  msg: string;
  data?: {
    file_token: string;
  };
}

/**
 * Response from updating a block (replace_image).
 */
interface UpdateBlockResponse {
  code: number;
  msg: string;
  data?: {
    block: {
      block_id: string;
      block_type: number;
    };
  };
}

/**
 * Cached tenant access token.
 */
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Get a Feishu tenant access token.
 *
 * Uses the internal tenant_access_token API with app_id/app_secret.
 * Caches the token until 5 minutes before expiry.
 *
 * @param appId - Feishu App ID
 * @param appSecret - Feishu App Secret
 * @returns Tenant access token string
 */
export async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<string> {
  // Return cached token if still valid
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const url = `${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`;

  const response = await fetch(url, {
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

  const data = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };

  if (data.code !== 0) {
    throw new Error(`Feishu auth error ${data.code}: ${data.msg}`);
  }

  if (!data.tenant_access_token) {
    throw new Error('No tenant_access_token in response');
  }

  // Cache token (expire 5 minutes early for safety)
  const expiresIn = (data.expire || 7200) - 300;
  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  logger.debug({ expiresIn }, 'Obtained Feishu tenant access token');
  return data.tenant_access_token;
}

/**
 * Step 1: Create an empty image block in a Feishu document.
 *
 * Uses block_type: 27 (Image) to create an empty image placeholder
 * at the specified index in the document.
 *
 * @param token - Tenant access token
 * @param documentId - Feishu document ID
 * @param index - Position to insert the image block (0-based)
 * @returns Block ID of the created image block
 */
export async function createImageBlock(
  token: string,
  documentId: string,
  index: number,
): Promise<string> {
  const url = `${FEISHU_API_BASE}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`;

  const response = await fetch(url, {
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
            // Create an empty image block - token will be bound later
            token: '',
          },
        },
      ],
      index,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create image block: HTTP ${response.status} - ${errorText}`);
  }

  const data = await response.json() as CreateBlockChildResponse;

  if (data.code !== 0) {
    throw new Error(`Feishu API error ${data.code}: ${data.msg}`);
  }

  const blockId = data.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error('No block_id returned from create image block API');
  }

  logger.debug({ documentId, index, blockId }, 'Created empty image block');
  return blockId;
}

/**
 * Step 2: Upload an image file to Feishu Drive for docx embedding.
 *
 * Uses the Drive Media Upload API with parent_type: "docx_image"
 * to upload the image file and get a file_token.
 *
 * @param token - Tenant access token
 * @param imagePath - Local file path to the image
 * @returns File token for the uploaded image
 */
export async function uploadDocxImage(
  token: string,
  imagePath: string,
): Promise<string> {
  const ext = path.extname(imagePath).toLowerCase();
  if (!DOCX_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported image format: ${ext}. Supported: ${[...DOCX_IMAGE_EXTENSIONS].join(', ')}`,
    );
  }

  const stats = fs.statSync(imagePath);
  if (stats.size > MAX_DOCX_IMAGE_SIZE) {
    throw new Error(
      `Image file too large: ${stats.size} bytes (max ${MAX_DOCX_IMAGE_SIZE / 1024 / 1024}MB)`,
    );
  }

  const fileName = path.basename(imagePath);
  const fileBuffer = fs.readFileSync(imagePath);
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Build multipart form data manually (Node.js FormData)
  const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];

  // Add file_type field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file_type"\r\n\r\n' +
    'docx_image\r\n',
  ));

  // Add file_name field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file_name"\r\n\r\n' +
    `${fileName}\r\n`,
  ));

  // Add parent_type field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="parent_type"\r\n\r\n' +
    'docx_image\r\n',
  ));

  // Add parent_node field (required by API, use "0" for docx_image uploads)
  // Note: For docx_image parent_type, parent_node can be omitted or set to the document ID
  // The API accepts uploads without parent_node for docx_image type

  // Add file field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n',
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const url = `${FEISHU_API_BASE}/open-apis/drive/v1/medias/upload_all`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload docx image: HTTP ${response.status} - ${errorText}`);
  }

  const data = await response.json() as UploadMediaResponse;

  if (data.code !== 0) {
    throw new Error(`Feishu upload error ${data.code}: ${data.msg}`);
  }

  const fileToken = data.data?.file_token;
  if (!fileToken) {
    throw new Error('No file_token returned from upload API');
  }

  logger.debug({ fileName, fileSize: stats.size, fileHash: fileHash.slice(0, 16) }, 'Uploaded docx image');
  return fileToken;
}

/**
 * Step 3: Bind uploaded image file to an image block (replace_image).
 *
 * Updates the empty image block with the uploaded file token,
 * effectively placing the image at the block's position.
 *
 * @param token - Tenant access token
 * @param documentId - Feishu document ID
 * @param blockId - Block ID from step 1
 * @param fileToken - File token from step 2
 * @returns Updated block ID
 */
export async function replaceImageBlock(
  token: string,
  documentId: string,
  blockId: string,
  fileToken: string,
): Promise<string> {
  const url = `${FEISHU_API_BASE}/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      replace_image: {
        token: fileToken,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to replace image block: HTTP ${response.status} - ${errorText}`);
  }

  const data = await response.json() as UpdateBlockResponse;

  if (data.code !== 0) {
    throw new Error(`Feishu replace_image error ${data.code}: ${data.msg}`);
  }

  const updatedBlockId = data.data?.block?.block_id;
  if (!updatedBlockId) {
    throw new Error('No block_id returned from update block API');
  }

  logger.debug({ documentId, blockId, fileToken }, 'Replaced image block with uploaded file');
  return updatedBlockId;
}

/**
 * Clear the cached tenant access token.
 * Useful for testing or when credentials change.
 */
export function clearTokenCache(): void {
  cachedToken = null;
}
