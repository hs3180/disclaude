#!/usr/bin/env tsx
/**
 * skills/upload-docx-image/upload-docx-image.ts
 *
 * Insert an image into a Feishu document at a specific position.
 *
 * Uses a 3-step Lark API process:
 *   1. Create empty image block (block_type: 27) at the desired index
 *   2. Upload the image file via Drive Media API (multipart/form-data)
 *   3. Bind the uploaded file to the block (replace_image)
 *
 * Authentication: reads app credentials from lark-cli's config store
 * (~/.config/lark-cli/config.json) and obtains a tenant_access_token.
 * Falls back to LARK_ACCESS_TOKEN env var if lark-cli config is unavailable.
 *
 * Environment variables:
 *   DOC_ID            Feishu document ID
 *   IMAGE_PATH        Local path to the image file
 *   INSERT_INDEX      Block index for insertion (-1 = append)
 *   LARK_ACCESS_TOKEN Optional pre-obtained tenant access token
 *   UPLOAD_SKIP_LARK  Set to '1' for dry-run testing
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_BASE = 'https://open.feishu.cn';
const LARK_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const BLOCK_TYPE_IMAGE = 27;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`INFO: ${msg}`);
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) exit('DOC_ID environment variable is required');
  // Feishu doc IDs are alphanumeric, may contain underscores and hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(docId)) {
    exit(`Invalid DOC_ID '${docId}'`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) exit('IMAGE_PATH environment variable is required');
  if (!existsSync(imagePath)) exit(`Image file not found: ${imagePath}`);

  const ext = extname(imagePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    exit(`Unsupported image format '${ext}'. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }

  const stat = statSync(imagePath);
  if (stat.size === 0) exit('Image file is empty');
  if (stat.size > MAX_FILE_SIZE) {
    exit(`Image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 20MB`);
  }
}

function validateIndex(index: string): number {
  if (!index && index !== '0') exit('INSERT_INDEX environment variable is required');
  const n = Number(index);
  if (!Number.isInteger(n)) exit(`Invalid INSERT_INDEX '${index}' — must be an integer`);
  if (n < -1) exit(`Invalid INSERT_INDEX '${index}' — must be >= -1`);
  return n;
}

// ---- Auth ----

interface LarkConfig {
  app_id?: string;
  app_secret?: string;
  [key: string]: unknown;
}

/**
 * Try to read lark-cli config from common file locations.
 * lark-cli stores config in ~/.config/lark-cli/ or uses the OS keychain.
 * When keychain is unavailable (e.g. headless Linux), it may fall back to files.
 */
function readLarkConfig(): LarkConfig | null {
  const candidates = [
    `${homedir()}/.config/lark-cli/config.json`,
    `${homedir()}/.lark-cli/config.json`,
    `${homedir()}/.lark/config.json`,
  ];

  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf-8');
        const config = JSON.parse(content);
        if (config.app_id && config.app_secret) return config;
      }
    } catch {
      // Ignore read errors, try next candidate
    }
  }
  return null;
}

/** Obtain a tenant_access_token from the Feishu auth API. */
async function fetchTenantToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch(`${LARK_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await resp.json()) as { code?: number; tenant_access_token?: string; msg?: string };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Auth failed: code=${data.code}, msg=${data.msg}`);
  }
  return data.tenant_access_token;
}

/**
 * Get a valid tenant_access_token.
 * Priority:
 *   1. LARK_ACCESS_TOKEN env var (explicit override)
 *   2. Read lark-cli config file → fetch token
 *   3. Error out
 */
async function getAccessToken(): Promise<string> {
  // Method 1: Explicit env var
  if (process.env.LARK_ACCESS_TOKEN) {
    log('Using LARK_ACCESS_TOKEN from environment');
    return process.env.LARK_ACCESS_TOKEN;
  }

  // Method 2: Read lark-cli config
  const config = readLarkConfig();
  if (config?.app_id && config?.app_secret) {
    log(`Using lark-cli config (app_id: ${config.app_id.substring(0, 8)}...)`);
    return await fetchTenantToken(config.app_id, config.app_secret);
  }

  // Method 3: Try lark-cli auth status to verify auth is working
  try {
    await execFileAsync('lark-cli', ['auth', 'status'], { timeout: 5000 });
  } catch {
    exit(
      'lark-cli is not authenticated. Please run:\n' +
      '  1. lark-cli config init\n' +
      '  2. lark-cli auth login --recommend\n' +
      'Or set LARK_ACCESS_TOKEN environment variable manually.',
    );
  }

  exit(
    'Could not obtain tenant_access_token. lark-cli stores credentials in the OS keychain\n' +
    'which is not directly accessible by this script.\n' +
    'Options:\n' +
    '  1. Set LARK_ACCESS_TOKEN env var (obtain via: lark-cli auth status)\n' +
    '  2. Ensure lark-cli config file exists at ~/.config/lark-cli/config.json',
  );
}

// ---- Lark API calls (using native fetch with token) ----

interface LarkResponse {
  code: number;
  msg?: string;
  data?: Record<string, unknown>;
}

/** Step 1: Create an empty image block at the desired index. */
async function createImageBlock(
  docId: string,
  index: number,
  token: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    children: [{ block_type: BLOCK_TYPE_IMAGE, image: {} }],
  };
  if (index >= 0) {
    body.index = index;
  }

  const resp = await fetch(
    `${LARK_BASE}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
    },
  );

  const data = (await resp.json()) as LarkResponse & {
    data?: { children?: Array<{ block_id?: string }> };
  };

  if (data.code !== 0) {
    throw new Error(`Create block failed: code=${data.code}, msg=${data.msg}`);
  }

  const blockId = data.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error('Create block succeeded but no block_id returned');
  }
  return blockId;
}

/** Step 2: Upload an image file via Drive Media API (multipart/form-data). */
async function uploadImage(
  docId: string,
  imagePath: string,
  token: string,
): Promise<string> {
  const fileBuffer = readFileSync(imagePath);
  const fileName = basename(imagePath);

  // Build multipart/form-data manually (no external dependencies)
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  const parts: Buffer[] = [];

  // field: parent_type
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="parent_type"\r\n\r\n` +
      `docx_image\r\n`,
    ),
  );

  // field: parent_node (use doc_id as parent)
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="parent_node"\r\n\r\n` +
      `${docId}\r\n`,
    ),
  );

  // field: file_size
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file_size"\r\n\r\n` +
      `${fileBuffer.length}\r\n`,
    ),
  );

  // field: file (binary)
  // Sanitize filename to prevent header injection
  const safeName = fileName.replace(/[\r\n"]/g, '_');
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const resp = await fetch(`${LARK_BASE}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    // @ts-expect-error Node.js fetch supports duplex for streaming
    duplex: 'half',
    signal: AbortSignal.timeout(60_000), // longer timeout for uploads
  });

  const data = (await resp.json()) as LarkResponse & {
    data?: { file_token?: string };
  };

  if (data.code !== 0) {
    throw new Error(`Upload failed: code=${data.code}, msg=${data.msg}`);
  }

  const fileToken = data.data?.file_token;
  if (!fileToken) {
    throw new Error('Upload succeeded but no file_token returned');
  }
  return fileToken;
}

/** Step 3: Bind the uploaded image to the empty block. */
async function bindImage(
  docId: string,
  blockId: string,
  fileToken: string,
  token: string,
): Promise<void> {
  const resp = await fetch(
    `${LARK_BASE}/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replace_image: { token: fileToken },
      }),
      signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
    },
  );

  const data = (await resp.json()) as LarkResponse;
  if (data.code !== 0) {
    throw new Error(`Bind image failed: code=${data.code}, msg=${data.msg}`);
  }
}

/** Cleanup: Delete an orphaned empty image block. */
async function deleteBlock(
  docId: string,
  blockId: string,
  token: string,
): Promise<void> {
  try {
    const resp = await fetch(
      `${LARK_BASE}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ start_index: -1, end_index: -1, block_ids: [blockId] }),
        signal: AbortSignal.timeout(LARK_TIMEOUT_MS),
      },
    );

    const data = (await resp.json()) as LarkResponse;
    if (data.code !== 0) {
      console.error(`WARN: Cleanup delete block failed: code=${data.code}, msg=${data.msg}`);
    } else {
      log(`Cleaned up orphan block ${blockId}`);
    }
  } catch (err) {
    console.error(`WARN: Cleanup delete block error: ${err instanceof Error ? err.message : err}`);
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX ?? '';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  const index = validateIndex(indexStr);

  log(`Doc: ${docId}`);
  log(`Image: ${imagePath} (${(statSync(imagePath).size / 1024).toFixed(1)}KB)`);
  log(`Index: ${index === -1 ? 'append' : index}`);

  // Dry-run mode
  if (process.env.UPLOAD_SKIP_LARK === '1') {
    log('OK: Image insertion (dry-run)');
    return;
  }

  // Check lark-cli availability
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('lark-cli not found in PATH. Install: npm install -g @larksuite/cli');
  }

  // Get auth token
  const token = await getAccessToken();
  log('Auth token obtained');

  // Step 1: Create empty image block
  let blockId: string;
  try {
    blockId = await createImageBlock(docId, index, token);
    log(`Step 1 OK: Created empty image block ${blockId}`);
  } catch (err) {
    exit(`Step 1 failed (create block): ${err instanceof Error ? err.message : err}`);
  }

  // Step 2: Upload image
  let fileToken: string;
  try {
    fileToken = await uploadImage(docId, imagePath, token);
    log(`Step 2 OK: Uploaded image (file_token: ${fileToken.substring(0, 16)}...)`);
  } catch (err) {
    // Cleanup: delete the orphaned empty block
    log(`Step 2 failed (upload): ${err instanceof Error ? err.message : err}`);
    log('Cleaning up empty block...');
    await deleteBlock(docId, blockId, token);
    exit(`Step 2 failed (upload): ${err instanceof Error ? err.message : err}`);
  }

  // Step 3: Bind image to block
  try {
    await bindImage(docId, blockId, fileToken, token);
    log(`Step 3 OK: Bound image to block ${blockId}`);
  } catch (err) {
    // Cleanup: delete the orphaned empty block
    log(`Step 3 failed (bind): ${err instanceof Error ? err.message : err}`);
    log('Cleaning up empty block...');
    await deleteBlock(docId, blockId, token);
    exit(`Step 3 failed (bind): ${err instanceof Error ? err.message : err}`);
  }

  log(`OK: Image inserted successfully at index ${index === -1 ? 'end' : index} (block: ${blockId})`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
