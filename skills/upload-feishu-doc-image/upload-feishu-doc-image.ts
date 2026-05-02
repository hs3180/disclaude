#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 *
 * Insert an image into a Feishu document at a specific position.
 *
 * Uses the Lark API 3-step process:
 *   1. Create empty image block (block_type: 27) at desired index
 *   2. Upload image file via multipart/form-data
 *   3. Bind uploaded file to the block via replace_image
 *
 * Authentication: reads lark-cli credentials from environment variables
 * (LARKSUITE_CLI_APP_ID / LARKSUITE_CLI_APP_SECRET) — the same source
 * lark-cli uses internally. Does NOT read FEISHU_APP_ID / FEISHU_APP_SECRET.
 *
 * Environment variables:
 *   DOC_ID       Feishu document ID (required)
 *   IMAGE_PATH   Local path to image file (required)
 *   INSERT_INDEX Position to insert at, 0-based (optional, default: append)
 *   SKIP_AUTH    Set to '1' to skip auth and API calls (dry-run for testing)
 *
 * Exit codes:
 *   0  success
 *   1  validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_BASE_URL = 'https://open.feishu.cn';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const LARK_TIMEOUT_MS = 30_000;
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

/**
 * Regex for Feishu document IDs.
 * Feishu doc IDs are alphanumeric strings, sometimes with underscores.
 * Examples: `doxcnSxIjtYBxxxxxxxxxx`, `doxcneRxxxxxxxxxxxxxx`
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_]+$/;

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
  if (!docId) {
    exit('DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must be alphanumeric (underscores allowed)`);
  }
}

function validateImagePath(imagePath: string): { path: string; ext: string } {
  if (!imagePath) {
    exit('IMAGE_PATH environment variable is required');
  }
  if (!existsSync(imagePath)) {
    exit(`Image file not found: ${imagePath}`);
  }
  const stat = statSync(imagePath);
  if (!stat.isFile()) {
    exit(`IMAGE_PATH is not a file: ${imagePath}`);
  }
  if (stat.size === 0) {
    exit('Image file is empty');
  }
  if (stat.size > MAX_FILE_SIZE) {
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    exit(`Image file too large: ${mb}MB (max 20MB)`);
  }

  const ext = '.' + basename(imagePath).split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    exit(`Unsupported image format '${ext}'. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }

  return { path: imagePath, ext };
}

function validateIndex(indexStr: string | undefined): number {
  if (!indexStr || indexStr === '-1') return -1; // append
  const idx = parseInt(indexStr, 10);
  if (isNaN(idx) || idx < 0) {
    exit(`Invalid INSERT_INDEX '${indexStr}' — must be a non-negative integer or -1`);
  }
  return idx;
}

// ---- Authentication ----

/**
 * Obtain a tenant_access_token using lark-cli's own credential source.
 * Reads LARKSUITE_CLI_APP_ID / LARKSUITE_CLI_APP_SECRET env vars —
 * the same variables lark-cli reads internally.
 */
async function getTenantAccessToken(): Promise<string> {
  // Check lark-cli availability first
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
  } catch {
    exit('lark-cli not found in PATH. Install it: npm install -g @larksuite/cli');
  }

  const appId = process.env.LARKSUITE_CLI_APP_ID;
  const appSecret = process.env.LARKSUITE_CLI_APP_SECRET;

  if (!appId || !appSecret) {
    exit(
      'lark-cli credentials not found. Set LARKSUITE_CLI_APP_ID and LARKSUITE_CLI_APP_SECRET ' +
      'environment variables, or run: lark-cli auth login',
    );
  }

  try {
    const resp = await fetch(
      `${LARK_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );

    if (!resp.ok) {
      exit(`Auth request failed: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as {
      code: number;
      msg: string;
      tenant_access_token: string;
    };

    if (data.code !== 0) {
      exit(`Auth failed: code=${data.code}, msg=${data.msg}. Check your lark-cli credentials.`);
    }

    return data.tenant_access_token;
  } catch (err) {
    exit(`Auth error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- API calls ----

interface ApiResponse {
  code: number;
  msg: string;
  [key: string]: unknown;
}

/**
 * Step 1: Create an empty image block at the specified index.
 */
async function createImageBlock(
  token: string,
  docId: string,
  index: number,
): Promise<string> {
  const url = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;

  const body: Record<string, unknown> = {
    children: [
      {
        block_type: 27, // Image block
      },
    ],
  };
  if (index >= 0) {
    body.index = index;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as ApiResponse & {
    data?: { children?: Array<{ block_id?: string }> };
  };

  if (data.code !== 0) {
    throw new Error(`Create block failed: code=${data.code}, msg=${data.msg}`);
  }

  const blockId = data.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error('Create block returned no block_id');
  }

  return blockId;
}

/**
 * Step 2: Upload image file via multipart/form-data.
 */
async function uploadImage(
  token: string,
  imagePath: string,
): Promise<string> {
  const fileBuffer = readFileSync(imagePath);
  const fileName = basename(imagePath);

  // Build multipart/form-data manually — no external dependencies
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  const parts: Buffer[] = [];

  // Parent_type field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="parent_type"\r\n\r\n` +
      `docx_image\r\n`,
    ),
  );

  // Parent_node field (use doc_id)
  const parentDocId = process.env.DOC_ID ?? '';
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="parent_node"\r\n\r\n` +
      `${parentDocId}\r\n`,
    ),
  );

  // File field — sanitize filename for header safety
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

  const url = `${LARK_BASE_URL}/open-apis/drive/v1/medias/upload_all`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const data = (await resp.json()) as ApiResponse & {
    data?: { file_token?: string };
  };

  if (data.code !== 0) {
    throw new Error(`Upload image failed: code=${data.code}, msg=${data.msg}`);
  }

  const fileToken = data.data?.file_token;
  if (!fileToken) {
    throw new Error('Upload image returned no file_token');
  }

  return fileToken;
}

/**
 * Step 3: Bind the uploaded image to the block via replace_image.
 */
async function bindImage(
  token: string,
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  const url = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`;

  const resp = await fetch(url, {
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

  const data = (await resp.json()) as ApiResponse;

  if (data.code !== 0) {
    throw new Error(`Bind image failed: code=${data.code}, msg=${data.msg}`);
  }
}

/**
 * Cleanup: Delete the empty image block on partial failure.
 */
async function deleteBlock(
  token: string,
  docId: string,
  blockId: string,
): Promise<void> {
  try {
    const url = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;
    const start_index = await getBlockIndex(token, docId, blockId);

    const resp = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        start_index,
        end_index: start_index,
        block_type: 27,
      }),
    });

    const data = (await resp.json()) as ApiResponse;
    if (data.code !== 0) {
      // Best-effort cleanup — log but don't throw
      console.error(`WARN: Cleanup delete failed: code=${data.code}, msg=${data.msg}`);
    } else {
      log(`Cleaned up empty block ${blockId}`);
    }
  } catch (err) {
    // Best-effort — log but don't throw
    console.error(`WARN: Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get the index of a block in the document's children list.
 */
async function getBlockIndex(
  token: string,
  docId: string,
  blockId: string,
): Promise<number> {
  const url = `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  const data = (await resp.json()) as ApiResponse & {
    data?: { items?: Array<{ block_id?: string }> };
  };

  if (data.code !== 0) {
    return 0; // Fallback to index 0 if we can't determine
  }

  const items = data.data?.items ?? [];
  const idx = items.findIndex((item) => item.block_id === blockId);
  return idx >= 0 ? idx : 0;
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX;
  const skipAuth = process.env.SKIP_AUTH === '1';

  // 1. Validate inputs
  validateDocId(docId);
  const image = validateImagePath(imagePath);
  const insertIndex = validateIndex(indexStr);

  log(`DOC_ID=${docId}, IMAGE=${image.path} (${(statSync(image.path).size / 1024).toFixed(1)}KB), INDEX=${insertIndex === -1 ? 'append' : insertIndex}`);

  // Dry-run mode for testing
  if (skipAuth) {
    log('SKIP_AUTH=1 — dry-run mode, no API calls made');
    console.log(`OK: Image would be inserted at index ${insertIndex === -1 ? 'end' : insertIndex} (dry-run)`);
    return;
  }

  // 2. Obtain tenant_access_token via lark-cli credentials
  log('Obtaining tenant_access_token from lark-cli credentials...');
  const token = await getTenantAccessToken();
  log('Authentication successful');

  // 3. Step 1: Create empty image block
  let blockId: string;
  try {
    log('Step 1/3: Creating empty image block...');
    blockId = await createImageBlock(token, docId, insertIndex);
    log(`Created block: ${blockId}`);
  } catch (err) {
    exit(`Step 1 failed: ${err instanceof Error ? err.message : String(err)}`);
    // exit() never returns, but TypeScript doesn't know that
    return;
  }

  // 4. Step 2: Upload image file
  let fileToken: string;
  try {
    log('Step 2/3: Uploading image file...');
    fileToken = await uploadImage(token, image.path);
    log(`Uploaded, file_token: ${fileToken}`);
  } catch (err) {
    log('Step 2 failed — cleaning up empty block...');
    await deleteBlock(token, docId, blockId);
    exit(`Step 2 failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 5. Step 3: Bind image to block
  try {
    log('Step 3/3: Binding image to block...');
    await bindImage(token, docId, blockId, fileToken);
    log('Image bound successfully');
  } catch (err) {
    log('Step 3 failed — cleaning up empty block...');
    await deleteBlock(token, docId, blockId);
    exit(`Step 3 failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 6. Success
  const positionLabel = insertIndex === -1 ? 'end' : `index ${insertIndex}`;
  console.log(`OK: Image inserted at ${positionLabel}, block_id=${blockId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
