#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 *
 * Insert an image into a Feishu document at a specific position.
 *
 * Three-step Lark API flow:
 *   1. Create empty image block (block_type: 27) at desired index
 *   2. Upload image file via Drive Media Upload API (multipart)
 *   3. Bind uploaded file to image block via replace_image
 *
 * Authentication: Uses lark-cli for JSON API calls (steps 1, 3, rollback).
 * For multipart upload (step 2), reads lark-cli's stored credentials to
 * obtain a tenant_access_token via Node.js native fetch.
 *
 * Environment variables:
 *   DOC_ID       Feishu document ID
 *   IMAGE_PATH   Local file path to the image
 *   IMAGE_INDEX  Insert position (0-based, default: -1 = append)
 *   SKIP_LARK    Set to '1' for dry-run (skip lark-cli calls)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const VALID_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const LARK_BASE = 'https://open.feishu.cn';

/**
 * Relaxed DOC_ID regex — allows alphanumeric, hyphens, and underscores.
 * Feishu doc IDs typically look like "doccnxxxxxxxxxxxxxxx".
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

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
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must contain only alphanumeric, hyphen, or underscore characters`);
  }
}

function validateImagePath(imagePath: string): string {
  if (!imagePath) exit('IMAGE_PATH environment variable is required');
  const absPath = resolve(imagePath);
  if (!existsSync(absPath)) exit(`Image file not found: ${absPath}`);

  const ext = extname(absPath).toLowerCase();
  if (!VALID_EXTENSIONS.has(ext)) {
    exit(`Unsupported image format '${ext}' — allowed: ${Array.from(VALID_EXTENSIONS).join(', ')}`);
  }

  const stat = statSync(absPath);
  if (stat.size === 0) exit('Image file is empty');
  if (stat.size > MAX_FILE_SIZE) {
    exit(`Image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB) — max 20MB`);
  }

  return absPath;
}

function parseIndex(raw: string): number {
  const index = parseInt(raw, 10);
  if (isNaN(index)) exit(`Invalid IMAGE_INDEX '${raw}' — must be an integer or -1`);
  if (index < -1) exit(`Invalid IMAGE_INDEX ${index} — must be >= -1`);
  return index;
}

// ---- lark-cli API helpers ----

interface LarkResponse {
  code: number;
  msg: string;
  data?: Record<string, unknown>;
}

async function larkApi(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<LarkResponse> {
  const args = ['api', method, endpoint];
  if (body) {
    args.push('-d', JSON.stringify(body));
  }

  const { stdout, stderr } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  try {
    const resp = JSON.parse(stdout.trim()) as LarkResponse;
    if (resp.code !== 0) {
      throw new Error(`Lark API error ${resp.code}: ${resp.msg}`);
    }
    return resp;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Failed to parse lark-cli response: ${stdout.trim()}`);
    }
    throw e;
  }
}

// ---- Auth: Get tenant_access_token from lark-cli config ----

interface LarkCredentials {
  appId: string;
  appSecret: string;
}

/**
 * Read app credentials from lark-cli's configuration.
 * lark-cli stores config in ~/.config/lark-cli/ or ~/.lark-cli/.
 */
function readLarkCredentials(): LarkCredentials {
  const configDirs = [
    `${homedir()}/.config/lark-cli`,
    `${homedir()}/.lark-cli`,
  ];

  const configFiles = ['config.json', 'config.yaml', 'config.yml', 'config'];

  for (const dir of configDirs) {
    for (const file of configFiles) {
      const configPath = `${dir}/${file}`;
      if (!existsSync(configPath)) continue;

      try {
        const content = readFileSync(configPath, 'utf-8').trim();
        // Try JSON first
        if (content.startsWith('{')) {
          const config = JSON.parse(content);
          const appId = config.app_id ?? config.appId ?? config.cli_id;
          const appSecret = config.app_secret ?? config.appSecret ?? config.cli_secret;
          if (appId && appSecret) {
            return { appId: String(appId), appSecret: String(appSecret) };
          }
        }
        // Try simple key=value format
        const kvMatch = content.match(/(?:app_id|cli_id)[=:]\s*["']?([^"'\s\n]+)/);
        const secretMatch = content.match(/(?:app_secret|cli_secret)[=:]\s*["']?([^"'\s\n]+)/);
        if (kvMatch?.[1] && secretMatch?.[1]) {
          return { appId: kvMatch[1], appSecret: secretMatch[1] };
        }
      } catch {
        // Skip unreadable/invalid config files
      }
    }
  }

  exit(
    'Could not read lark-cli credentials. Please configure lark-cli first:\n' +
    '  lark-cli auth login\n' +
    '  or set app credentials in ~/.config/lark-cli/config.json',
  );
}

/**
 * Obtain a tenant_access_token from the Feishu Auth API.
 */
async function getTenantAccessToken(): Promise<string> {
  const { appId, appSecret } = readLarkCredentials();

  const resp = await fetch(`${LARK_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  if (!resp.ok) {
    exit(`Auth API HTTP error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    exit(`Failed to get tenant_access_token: code=${data.code}, msg=${data.msg}`);
  }

  return data.tenant_access_token;
}

// ---- Step 2: Multipart upload ----

/**
 * Build a multipart/form-data body for file upload.
 * Returns the body as Uint8Array and the Content-Type header value.
 */
function buildMultipartBody(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): { body: Buffer; contentType: string } {
  const boundary = `----FormBoundary${Date.now().toString(16)}`;

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${sanitiseFilename(fileName)}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat([header, fileBuffer, footer]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Sanitise filename to prevent header injection in multipart header. */
function sanitiseFilename(name: string): string {
  return basename(name).replace(/["\r\n]/g, '_');
}

/** Map file extension to MIME type. */
function mimeTypeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Upload image file to Feishu Drive.
 * Uses the medias/upload_all endpoint with multipart/form-data.
 */
async function uploadImage(
  docId: string,
  imagePath: string,
  token: string,
): Promise<string> {
  const ext = extname(imagePath).toLowerCase();
  const fileName = basename(imagePath);
  const fileBuffer = readFileSync(imagePath);
  const mimeType = mimeTypeForExt(ext);

  const { body, contentType } = buildMultipartBody(fileBuffer, fileName, mimeType);

  const url = `${LARK_BASE}/open-apis/drive/v1/medias/upload_all` +
    `?parent_type=docx_image&parent_node=${docId}&file_type=image`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body: body as unknown as BodyInit,
  });

  if (!resp.ok) {
    throw new Error(`Upload API HTTP error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    code: number;
    msg: string;
    data?: { file_token?: string };
  };

  if (data.code !== 0 || !data.data?.file_token) {
    throw new Error(`Upload failed: code=${data.code}, msg=${data.msg}`);
  }

  return data.data.file_token;
}

// ---- Rollback ----

/**
 * Delete an empty image block to clean up after a partial failure.
 */
async function rollbackBlock(docId: string, blockId: string, index: number): Promise<void> {
  log(`Rolling back: deleting empty block ${blockId} at index ${index}`);
  try {
    // Try batch_delete with index range
    await larkApi(
      'POST',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
      { start_index: index, end_index: index + 1 },
    );
    log('Rollback successful');
  } catch (rollbackErr) {
    // batch_delete might fail if block was already deleted or index shifted
    console.error(
      `WARNING: Rollback failed — document may contain an empty image block (${blockId}). ` +
      `Please delete it manually. Error: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`,
    );
  }
}

// ---- Main ----

async function main(): Promise<void> {
  // Parse and validate inputs
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const rawIndex = process.env.IMAGE_INDEX ?? '-1';

  validateDocId(docId);
  const absImagePath = validateImagePath(imagePath);
  const index = parseIndex(rawIndex);

  log(`Document: ${docId}`);
  log(`Image: ${absImagePath}`);
  log(`Index: ${index === -1 ? 'append (end)' : index}`);

  // Check lark-cli availability
  if (process.env.SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('lark-cli not found in PATH. Please install and configure lark-cli first.');
    }
  }

  // Dry-run mode
  if (process.env.SKIP_LARK === '1') {
    log('Dry-run mode — skipping API calls');
    log(`Would insert image '${basename(absImagePath)}' at index ${index} in doc ${docId}`);
    return;
  }

  // ---- Step 1: Create empty image block at desired index ----
  log('Step 1: Creating empty image block...');

  const step1Body: Record<string, unknown> = {
    children: [{ block_type: 27 }],
  };
  if (index >= 0) {
    step1Body.index = index;
  }

  let blockId: string;
  let blockIndex = index;

  try {
    const step1Resp = await larkApi(
      'POST',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      step1Body,
    );

    const children = step1Resp.data?.children as Array<{ block_id?: string }> | undefined;
    if (!children?.[0]?.block_id) {
      exit('Step 1 failed: no block_id in response');
    }

    blockId = children[0].block_id;
    log(`Step 1 OK: created block ${blockId}`);
  } catch (err) {
    exit(`Step 1 failed (create block): ${err instanceof Error ? err.message : err}`);
  }

  // If we don't know the actual index (was -1), we can't reliably rollback by index.
  // We'll try to rollback by finding the block via batch_delete or individual delete.
  // For now, if index was -1, the block is at the end.

  // ---- Step 2: Upload image file ----
  log('Step 2: Uploading image file...');

  let fileToken: string;
  try {
    const token = await getTenantAccessToken();
    fileToken = await uploadImage(docId, absImagePath, token);
    log(`Step 2 OK: uploaded, file_token ${fileToken.slice(0, 8)}...`);
  } catch (err) {
    // Rollback: delete the empty block
    const rollbackIndex = blockIndex >= 0 ? blockIndex : -1;
    if (rollbackIndex >= 0) {
      await rollbackBlock(docId, blockId, rollbackIndex);
    } else {
      console.error(
        `WARNING: Cannot auto-rollback block ${blockId} (index unknown). ` +
        `Please delete the empty image block manually.`,
      );
    }
    exit(`Step 2 failed (upload): ${err instanceof Error ? err.message : err}`);
  }

  // ---- Step 3: Bind image to block ----
  log('Step 3: Binding image to block...');

  try {
    await larkApi(
      'PATCH',
      `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
      { replace_image: { token: fileToken } },
    );
    log('Step 3 OK: image bound to block');
  } catch (err) {
    // Rollback: delete the empty block
    const rollbackIndex = blockIndex >= 0 ? blockIndex : -1;
    if (rollbackIndex >= 0) {
      await rollbackBlock(docId, blockId, rollbackIndex);
    } else {
      console.error(
        `WARNING: Cannot auto-rollback block ${blockId} (index unknown). ` +
        `Please delete the empty image block manually.`,
      );
    }
    exit(`Step 3 failed (bind): ${err instanceof Error ? err.message : err}`);
  }

  // ---- Success ----
  console.log(`OK: Image inserted successfully`);
  console.log(`  Document: ${docId}`);
  console.log(`  Block ID: ${blockId}`);
  console.log(`  Position: ${index === -1 ? 'end' : `index ${index}`}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
