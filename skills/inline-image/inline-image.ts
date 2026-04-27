#!/usr/bin/env tsx
/**
 * skills/inline-image/inline-image.ts — Insert an image into a Feishu document at a specific position.
 *
 * Feishu's `lark-cli docs +media-insert` only appends images to the end of a document.
 * This script uses the Lark API directly to insert images at arbitrary positions via
 * the 3-step process:
 *
 *   1. Create an empty image block (block_type: 27) at the desired index
 *   2. Upload the image file via the Drive Media Upload API (parent_type: "docx_image")
 *   3. Bind the uploaded file to the image block via replace_image
 *
 * Environment variables:
 *   DOC_ID              (required) Feishu document ID
 *   IMAGE_PATH          (required) Absolute path to the image file (PNG/JPG/JPEG)
 *   INSERT_INDEX        (required) 0-based position to insert at (-1 to append)
 *   FEISHU_APP_ID       (required) Feishu application ID
 *   FEISHU_APP_SECRET   (required) Feishu application secret
 *   INLINE_IMAGE_SKIP_API (optional) Set to '1' to skip actual API calls (dry-run)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

// ---- Constants (exported for testing) ----

export const LARK_BASE_URL = 'https://open.feishu.cn';
export const AUTH_ENDPOINT = '/open-apis/auth/v3/tenant_access_token/internal';
export const BLOCK_CHILDREN_ENDPOINT = (docId: string) =>
  `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;
export const UPLOAD_ENDPOINT = '/open-apis/drive/v1/medias/upload_all';
export const BLOCK_UPDATE_ENDPOINT = (docId: string, blockId: string) =>
  `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`;

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
export const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
export const DOC_ID_REGEX = /^[a-zA-Z0-9]+$/;

// ---- Lark API response types (exported for testing) ----

export interface TokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

export interface BlockChildrenResponse {
  code: number;
  msg: string;
  data?: {
    children?: Array<{ block_id: string; block_type?: number }>;
  };
}

export interface UploadResponse {
  code: number;
  msg: string;
  data?: {
    file_token: string;
  };
}

export interface BlockUpdateResponse {
  code: number;
  msg: string;
}

// ---- Validation helpers (exported for testing) ----

export function validateDocId(docId: string): void {
  if (!docId) {
    throw new Error('DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    throw new Error(`Invalid DOC_ID '${docId}' — must be alphanumeric`);
  }
}

export function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    throw new Error('IMAGE_PATH environment variable is required');
  }
  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Invalid IMAGE_PATH extension '${ext}' — must be one of: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }
}

export function validateIndex(indexStr: string): number {
  if (!indexStr && indexStr !== '0') {
    throw new Error('INSERT_INDEX environment variable is required');
  }
  const index = parseInt(indexStr, 10);
  if (!Number.isFinite(index)) {
    throw new Error(`Invalid INSERT_INDEX '${indexStr}' — must be an integer`);
  }
  if (index < -1) {
    throw new Error(`Invalid INSERT_INDEX '${indexStr}' — must be >= -1 (-1 means append)`);
  }
  return index;
}

export function validateCredentials(appId: string, appSecret: string): void {
  if (!appId) {
    throw new Error('FEISHU_APP_ID environment variable is required');
  }
  if (!appSecret) {
    throw new Error('FEISHU_APP_SECRET environment variable is required');
  }
}

// ---- Lark API helpers (exported for testing) ----

/**
 * Get a tenant access token using app_id + app_secret.
 */
export async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const url = `${LARK_BASE_URL}${AUTH_ENDPOINT}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  if (!response.ok) {
    throw new Error(`Auth API HTTP error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (data.code !== 0) {
    throw new Error(`Auth API error: code=${data.code}, msg=${data.msg}`);
  }

  return data.tenant_access_token;
}

/**
 * Step 1: Create an empty image block at the specified index.
 * Returns the block_id of the created image block.
 */
export async function createImageBlock(
  token: string,
  docId: string,
  index: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    children: [
      {
        block_type: 27, // Image block type
      },
    ],
  };

  // Only include index if it's not -1 (append)
  // When index is -1, the API appends to the end
  if (index >= 0) {
    body.index = index;
  }

  const url = `${LARK_BASE_URL}${BLOCK_CHILDREN_ENDPOINT(docId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Create block HTTP error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as BlockChildrenResponse;
  if (data.code !== 0) {
    throw new Error(`Create block API error: code=${data.code}, msg=${data.msg}`);
  }

  const children = data.data?.children;
  if (!children || children.length === 0 || !children[0].block_id) {
    throw new Error('Create block returned no block_id');
  }

  return children[0].block_id;
}

/**
 * Step 2: Upload an image file via multipart form-data.
 * Returns the file_token of the uploaded file.
 */
export async function uploadImage(
  token: string,
  docId: string,
  imageBuffer: Buffer,
  fileName: string,
): Promise<string> {
  // Build multipart form-data manually (no external dependency needed)
  const boundary = `----FormBoundary${Date.now()}`;

  const parentTypePart = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="parent_type"',
    '',
    'docx_image',
  ].join('\r\n');

  // parent_node is required for docx_image — use the document_id
  const parentNodePart = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="parent_node"',
    '',
    docId,
  ].join('\r\n');

  const fileNameSafe = fileName || 'image.png';
  const filePart = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileNameSafe}"`,
    'Content-Type: application/octet-stream',
    '',
  ].join('\r\n') + '\r\n';

  const closingBoundary = `\r\n--${boundary}--\r\n`;

  // Combine all parts into a single Buffer
  const parts = [
    Buffer.from(parentTypePart + '\r\n', 'utf-8'),
    Buffer.from(parentNodePart + '\r\n', 'utf-8'),
    Buffer.from(filePart, 'utf-8'),
    imageBuffer,
    Buffer.from(closingBoundary, 'utf-8'),
  ];

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const body = Buffer.concat(parts, totalLength);

  const url = `${LARK_BASE_URL}${UPLOAD_ENDPOINT}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload HTTP error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as UploadResponse;
  if (data.code !== 0) {
    throw new Error(`Upload API error: code=${data.code}, msg=${data.msg}`);
  }

  if (!data.data?.file_token) {
    throw new Error('Upload returned no file_token');
  }

  return data.data.file_token;
}

/**
 * Step 3: Bind the uploaded file to the image block via replace_image.
 */
export async function replaceImageBlock(
  token: string,
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  const url = `${LARK_BASE_URL}${BLOCK_UPDATE_ENDPOINT(docId, blockId)}`;
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
    const text = await response.text();
    throw new Error(`Replace image HTTP error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as BlockUpdateResponse;
  if (data.code !== 0) {
    throw new Error(`Replace image API error: code=${data.code}, msg=${data.msg}`);
  }
}

// ---- Main ----

async function main(): Promise<void> {
  // ---- Parse and validate environment variables ----
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX ?? '';
  const appId = process.env.FEISHU_APP_ID ?? '';
  const appSecret = process.env.FEISHU_APP_SECRET ?? '';
  const skipApi = process.env.INLINE_IMAGE_SKIP_API === '1';

  try {
    validateDocId(docId);
    validateImagePath(imagePath);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  let index: number;
  try {
    index = validateIndex(indexStr);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  try {
    validateCredentials(appId, appSecret);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Resolve absolute path
  const absoluteImagePath = resolve(imagePath);

  // Check file exists and size
  let fileSize: number;
  try {
    const fileStat = await stat(absoluteImagePath);
    fileSize = fileStat.size;
  } catch {
    console.error(`ERROR: Image file not found: ${absoluteImagePath}`);
    process.exit(1);
  }

  if (fileSize === 0) {
    console.error('ERROR: Image file is empty');
    process.exit(1);
  }

  if (fileSize > MAX_IMAGE_SIZE) {
    console.error(`ERROR: Image file too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max: 20 MB)`);
    process.exit(1);
  }

  const fileName = basename(absoluteImagePath);
  const position = index === -1 ? 'end (append)' : `index ${index}`;
  console.log(`INFO: Inserting image '${fileName}' (${(fileSize / 1024).toFixed(1)} KB) into doc ${docId} at ${position}`);

  // Dry-run mode
  if (skipApi) {
    console.log(`OK: Image insertion prepared (dry-run — skipped API calls)`);
    console.log(`  doc_id: ${docId}`);
    console.log(`  image: ${fileName}`);
    console.log(`  index: ${index}`);
    return;
  }

  // ---- Step 0: Get tenant access token ----
  let token: string;
  try {
    token = await getTenantAccessToken(appId, appSecret);
    console.log('INFO: Authenticated successfully');
  } catch (err) {
    console.error(`ERROR: Failed to get access token: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // ---- Step 1: Create empty image block ----
  let blockId: string;
  try {
    blockId = await createImageBlock(token, docId, index);
    console.log(`INFO: Created image block ${blockId} at ${position}`);
  } catch (err) {
    console.error(`ERROR: Step 1 failed (create block): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // ---- Step 2: Upload image file ----
  let fileToken: string;
  try {
    const imageBuffer = await readFile(absoluteImagePath);
    fileToken = await uploadImage(token, docId, imageBuffer, fileName);
    console.log(`INFO: Uploaded image, file_token: ${fileToken}`);
  } catch (err) {
    console.error(`ERROR: Step 2 failed (upload image): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // ---- Step 3: Bind image to block ----
  try {
    await replaceImageBlock(token, docId, blockId, fileToken);
    console.log(`INFO: Bound image to block ${blockId}`);
  } catch (err) {
    console.error(`ERROR: Step 3 failed (bind image): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`OK: Image inserted successfully`);
  console.log(`  block_id: ${blockId}`);
  console.log(`  file_token: ${fileToken}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
