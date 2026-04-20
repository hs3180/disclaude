#!/usr/bin/env tsx
/**
 * skills/insert-docx-image/insert-docx-image.ts — Insert image at a specific position in a Feishu document.
 *
 * Uses the 3-step Feishu Document API flow:
 * 1. Create empty image block (block_type: 27) at specified index
 * 2. Upload image file via Drive Media Upload API (multipart)
 * 3. Bind uploaded file to image block via replace_image
 *
 * Authentication is handled by lark-cli for JSON API calls (steps 1 & 3).
 * For multipart upload (step 2), uses Node.js fetch with tenant access token
 * obtained via FEISHU_APP_ID / FEISHU_APP_SECRET env vars.
 *
 * Environment variables:
 *   DOCX_DOCUMENT_ID  Feishu document ID (required)
 *   DOCX_IMAGE_PATH   Local path to the image file (required)
 *   DOCX_INSERT_INDEX Position index, 0-based (optional, default: -1 = append)
 *   DOCX_SKIP_API     Set to '1' to skip actual API calls (testing)
 *   FEISHU_APP_ID     Feishu app ID (required for upload step)
 *   FEISHU_APP_SECRET Feishu app secret (required for upload step)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const FEISHU_BASE_URL = 'https://open.feishu.cn';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB Feishu limit
const MAX_INDEX = 10000; // Reasonable upper bound for block index
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

/** Regex for Feishu document IDs. */
const DOC_ID_REGEX = /^[a-zA-Z0-9]{10,}$/;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateDocumentId(docId: string): void {
  if (!docId) {
    exit('DOCX_DOCUMENT_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOCX_DOCUMENT_ID '${docId}' — must be alphanumeric (10+ chars)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('DOCX_IMAGE_PATH environment variable is required');
  }
  const ext = extname(imagePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    exit(`Unsupported image format '${ext}'. Supported: png, jpg, jpeg, gif, bmp, webp`);
  }
}

function validateIndex(indexStr: string): number {
  if (!indexStr || indexStr === '') return -1;
  const index = parseInt(indexStr, 10);
  if (!Number.isFinite(index)) {
    exit(`Invalid DOCX_INSERT_INDEX '${indexStr}' — must be a number`);
  }
  if (index < -1) {
    exit(`Invalid DOCX_INSERT_INDEX '${index}' — must be >= -1 (-1 = append)`);
  }
  if (index > MAX_INDEX) {
    exit(`DOCX_INSERT_INDEX '${index}' exceeds maximum (${MAX_INDEX})`);
  }
  return index;
}

async function validateImageFile(imagePath: string): Promise<{ size: number; resolved: string }> {
  const resolved = resolve(imagePath);
  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      exit(`DOCX_IMAGE_PATH '${resolved}' is not a file`);
    }
    if (fileStat.size === 0) {
      exit(`Image file '${resolved}' is empty (0 bytes)`);
    }
    if (fileStat.size > MAX_FILE_SIZE) {
      exit(`Image file '${resolved}' exceeds 20MB limit (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`);
    }
    return { size: fileStat.size, resolved };
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Image file not found: '${resolved}'`);
    }
    throw err;
  }
}

// ---- Auth ----

interface TokenResponse {
  tenant_access_token: string;
  expire: number;
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const url = `${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth API returned ${response.status}: ${text}`);
  }

  const data = (await response.json()) as TokenResponse & { code?: number; msg?: string };
  if (data.code && data.code !== 0) {
    throw new Error(`Auth failed: code=${data.code}, msg=${data.msg}`);
  }
  if (!data.tenant_access_token) {
    throw new Error('Auth response missing tenant_access_token');
  }
  return data.tenant_access_token;
}

// ---- API Calls ----

interface ApiResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Create an empty image block at the specified position using lark-cli.
 */
async function createEmptyImageBlock(
  documentId: string,
  index: number,
): Promise<ApiResult> {
  const body: Record<string, unknown> = {
    children: [{ block_type: 27, image: {} }],
  };
  if (index >= 0) {
    body.index = index;
  }

  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      ['api', 'POST', `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, '-d', JSON.stringify(body)],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    const response = JSON.parse(stdout) as { code?: number; msg?: string; data?: Record<string, unknown> };
    if (response.code !== undefined && response.code !== 0) {
      return { success: false, error: `API error ${response.code}: ${response.msg}` };
    }

    return { success: true, data: response.data };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

/**
 * Upload image file to Feishu Drive using multipart form upload.
 * Uses Node.js fetch directly since lark-cli doesn't support multipart.
 */
async function uploadImageFile(
  documentId: string,
  imageFilePath: string,
  accessToken: string,
): Promise<ApiResult> {
  const fileName = basename(imageFilePath);
  const fileBuffer = await readFile(imageFilePath);
  const ext = extname(fileName).toLowerCase();

  // Determine content type
  const contentTypeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
  };
  const contentType = contentTypeMap[ext] ?? 'application/octet-stream';

  // Build multipart form data manually (no external dependencies)
  const boundary = `----FormBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  // Part 1: parent_type
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\ndocx_image\r\n`,
  ));

  // Part 2: parent_node (document ID)
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${documentId}\r\n`,
  ));

  // Part 3: file
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  try {
    const url = `${FEISHU_BASE_URL}/open-apis/drive/v1/medias/upload_all`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const responseText = await response.text();
    const responseData = JSON.parse(responseText) as { code?: number; msg?: string; data?: Record<string, unknown> };

    if (responseData.code !== undefined && responseData.code !== 0) {
      return { success: false, error: `Upload API error ${responseData.code}: ${responseData.msg}` };
    }

    return { success: true, data: responseData.data };
  } catch (err: unknown) {
    const error = err as { message?: string };
    return { success: false, error: `Upload failed: ${error.message ?? 'unknown error'}` };
  }
}

/**
 * Bind uploaded image file to the empty image block using lark-cli.
 */
async function bindImageToBlock(
  documentId: string,
  blockId: string,
  fileToken: string,
): Promise<ApiResult> {
  const body = {
    replace_image: {
      token: fileToken,
    },
  };

  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      ['api', 'PATCH', `/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`, '-d', JSON.stringify(body)],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    const response = JSON.parse(stdout) as { code?: number; msg?: string; data?: Record<string, unknown> };
    if (response.code !== undefined && response.code !== 0) {
      return { success: false, error: `Bind API error ${response.code}: ${response.msg}` };
    }

    return { success: true, data: response.data };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

// ---- Helpers ----

/**
 * Extract block_id from the create block response.
 * The response structure is: { block: { children: [{ block_id: "xxx" }] } }
 * or: { children: [{ block_id: "xxx" }] }
 */
function extractBlockId(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;

  // Try data.block.children[0].block_id
  const block = data.block as Record<string, unknown> | undefined;
  if (block?.children) {
    const children = block.children as Array<Record<string, unknown>>;
    if (children.length > 0 && children[0].block_id) {
      return children[0].block_id as string;
    }
  }

  // Try data.children[0].block_id
  if (data.children) {
    const children = data.children as Array<Record<string, unknown>>;
    if (children.length > 0 && children[0].block_id) {
      return children[0].block_id as string;
    }
  }

  return null;
}

/**
 * Extract file_token from the upload response.
 * The response structure is: { file_token: "xxx" }
 */
function extractFileToken(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  return (data.file_token as string) ?? null;
}

// ---- Main ----

async function main(): Promise<void> {
  const documentId = process.env.DOCX_DOCUMENT_ID ?? '';
  const imagePath = process.env.DOCX_IMAGE_PATH ?? '';
  const indexStr = process.env.DOCX_INSERT_INDEX ?? '';
  const skipApi = process.env.DOCX_SKIP_API === '1';

  // Validate inputs
  validateDocumentId(documentId);
  validateImagePath(imagePath);
  const index = validateIndex(indexStr);
  const { size, resolved } = await validateImageFile(imagePath);

  console.log(`INFO: Inserting image into document ${documentId}`);
  console.log(`INFO: Image: ${resolved} (${(size / 1024).toFixed(1)}KB)`);
  console.log(`INFO: Position: ${index === -1 ? 'append (end)' : `index ${index}`}`);

  // Dry-run mode (validation only)
  if (skipApi) {
    console.log('OK: Validation passed (dry-run mode, no API calls)');
    return;
  }

  // Check lark-cli availability
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH');
  }

  // Step 1: Create empty image block at the desired position
  console.log('INFO: Step 1/3 — Creating empty image block...');
  const createResult = await createEmptyImageBlock(documentId, index);
  if (!createResult.success) {
    exit(`Step 1 failed: ${createResult.error}`);
  }

  const blockId = extractBlockId(createResult.data);
  if (!blockId) {
    exit(`Step 1 failed: Could not extract block_id from response. Response: ${JSON.stringify(createResult.data)}`);
  }
  console.log(`INFO: Created image block: ${blockId}`);

  // Step 2: Upload image file
  // Need tenant access token for multipart upload (lark-cli doesn't support it)
  console.log('INFO: Step 2/3 — Uploading image file...');
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    exit('FEISHU_APP_ID and FEISHU_APP_SECRET environment variables are required for image upload');
  }

  let accessToken: string;
  try {
    accessToken = await getTenantAccessToken(appId, appSecret);
  } catch (err: unknown) {
    const error = err as { message?: string };
    exit(`Failed to get tenant access token: ${error.message ?? 'unknown error'}`);
  }

  const uploadResult = await uploadImageFile(documentId, resolved, accessToken);
  if (!uploadResult.success) {
    exit(`Step 2 failed: ${uploadResult.error}`);
  }

  const fileToken = extractFileToken(uploadResult.data);
  if (!fileToken) {
    exit(`Step 2 failed: Could not extract file_token from response. Response: ${JSON.stringify(uploadResult.data)}`);
  }
  console.log(`INFO: Uploaded image, file_token: ${fileToken}`);

  // Step 3: Bind the uploaded image to the empty block
  console.log('INFO: Step 3/3 — Binding image to block...');
  const bindResult = await bindImageToBlock(documentId, blockId, fileToken);
  if (!bindResult.success) {
    exit(`Step 3 failed: ${bindResult.error}`);
  }

  console.log(`OK: Image inserted successfully at ${index === -1 ? 'end' : `index ${index}`} of document ${documentId}`);
  console.log(`OK: Block ID: ${blockId}, File token: ${fileToken}`);
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
