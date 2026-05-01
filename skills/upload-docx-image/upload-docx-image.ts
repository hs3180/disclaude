#!/usr/bin/env tsx
/**
 * skills/upload-docx-image/upload-docx-image.ts — Insert an image into a Feishu document at a specific position.
 *
 * Three-step API flow:
 * 1. Create empty image block (block_type: 27) at specified position
 * 2. Upload image via Drive Media Upload API (multipart/form-data)
 * 3. Bind uploaded image to the block (update_image)
 *
 * Auth: Uses lark-cli's built-in authentication (reads cached tenant token from config).
 * Does NOT read FEISHU_APP_ID / FEISHU_APP_SECRET from environment variables.
 *
 * Environment variables:
 *   UPLOAD_DOC_ID      Feishu document ID
 *   UPLOAD_IMAGE_PATH  Local file path to the image (max 20 MB)
 *   UPLOAD_INDEX       Insertion position index (optional, default: append to end)
 *   UPLOAD_SKIP_LARK   Set to '1' to skip lark-cli check and API calls (for testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB (Feishu limit for docx images)
const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.bmp', '.svg', '.tiff', '.ico',
]);
const LARK_CONFIG_PATH = join(homedir(), '.config', 'lark', 'config.json');

// ---- Types ----

interface LarkConfig {
  tenant_access_token?: string;
  tenant_access_token_expires_at?: number;
  base_url?: string;
}

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateDocId(docId: string): void {
  if (!docId) {
    exit('UPLOAD_DOC_ID environment variable is required');
  }
  // Feishu document IDs are alphanumeric (may also contain underscores)
  if (!/^[a-zA-Z0-9_]+$/.test(docId)) {
    exit(`Invalid UPLOAD_DOC_ID '${docId}' — must be alphanumeric`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('UPLOAD_IMAGE_PATH environment variable is required');
  }
  if (!existsSync(imagePath)) {
    exit(`Image file not found: ${imagePath}`);
  }
  const stat = statSync(imagePath);
  if (!stat.isFile()) {
    exit(`Path is not a file: ${imagePath}`);
  }
  if (stat.size === 0) {
    exit('Image file is empty');
  }
  if (stat.size > MAX_IMAGE_SIZE) {
    exit(`Image exceeds ${MAX_IMAGE_SIZE / 1024 / 1024} MB limit`);
  }
}

function validateImageExtension(imagePath: string): void {
  const name = basename(imagePath).toLowerCase();
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex < 0) {
    console.warn('WARN: Image file has no extension, upload may fail');
    return;
  }
  const ext = name.substring(dotIndex);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    console.warn(`WARN: Unusual image extension '${ext}', upload may fail`);
  }
}

function parseIndex(indexStr: string | undefined): number {
  if (!indexStr) return -1; // append to end
  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0) {
    exit('UPLOAD_INDEX must be a non-negative integer');
  }
  return index;
}

// ---- Auth: Read lark-cli cached token ----

function readLarkConfig(): LarkConfig {
  try {
    const data = readFileSync(LARK_CONFIG_PATH, 'utf-8');
    return JSON.parse(data) as LarkConfig;
  } catch {
    exit(
      `Cannot read lark-cli config at ${LARK_CONFIG_PATH}. ` +
      `Ensure lark-cli is installed and authenticated (run 'lark-cli auth login').`,
    );
  }
}

async function getTenantToken(): Promise<string> {
  const config = readLarkConfig();
  const token = config.tenant_access_token;
  const expiresAt = config.tenant_access_token_expires_at ?? 0;

  if (!token) {
    exit(
      'No tenant access token in lark-cli config. ' +
      'Run \'lark-cli auth login --app-id <ID> --app-secret <SECRET>\' first.',
    );
  }

  // Refresh if expired (with 60s buffer)
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt > 0 && now >= expiresAt - 60) {
    console.log('INFO: Tenant token may be expired, attempting refresh...');
    try {
      // Running any lark-cli command triggers automatic token refresh
      await execFileAsync('lark-cli', ['--version'], { timeout: 10_000 });
    } catch {
      // Ignore errors — refresh may still have happened
    }
    const refreshed = readLarkConfig();
    if (refreshed.tenant_access_token && (refreshed.tenant_access_token_expires_at ?? 0) > now) {
      return refreshed.tenant_access_token;
    }
    exit('Tenant access token expired and refresh failed. Re-authenticate with lark-cli.');
  }

  return token;
}

function getBaseUrl(): string {
  const config = readLarkConfig();
  return (config.base_url || 'https://open.feishu.cn').replace(/\/+$/, '');
}

// ---- Step 0: Count block children (for append mode) ----

async function getBlockChildrenCount(docId: string): Promise<number> {
  let total = 0;
  let pageToken = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children?page_size=200`
      + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');

    const { stdout } = await execFileAsync(
      'lark-cli',
      ['api', 'GET', endpoint],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
    );

    let resp: { code?: number; msg?: string; data?: { items?: unknown[]; has_more?: boolean; page_token?: string } };
    try {
      resp = JSON.parse(stdout);
    } catch {
      throw new Error(`Invalid JSON from list-children: ${stdout.substring(0, 200)}`);
    }

    if (resp.code !== 0) {
      throw new Error(`List-children API error ${resp.code}: ${resp.msg}`);
    }

    total += (resp.data?.items ?? []).length;

    if (!resp.data?.has_more || !resp.data?.page_token) break;
    pageToken = resp.data.page_token;
  }

  return total;
}

// ---- Step 1: Create empty image block ----

async function createEmptyImageBlock(
  docId: string,
  effectiveIndex: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    children: [{ block_type: 27 }],
  };
  if (effectiveIndex >= 0) {
    body.index = effectiveIndex;
  }

  const { stdout } = await execFileAsync(
    'lark-cli',
    [
      'api', 'POST',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      '-d', JSON.stringify(body),
    ],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );

  let resp: { code?: number; msg?: string; data?: { children?: { block_id?: string }[] } };
  try {
    resp = JSON.parse(stdout);
  } catch {
    throw new Error(`Invalid JSON from create-block: ${stdout.substring(0, 200)}`);
  }

  if (resp.code !== 0) {
    throw new Error(`Create-block API error ${resp.code}: ${resp.msg}`);
  }

  const blockId = resp.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error('No block_id in create-block response');
  }
  return blockId;
}

// ---- Step 2: Upload image (multipart/form-data) ----

async function uploadImage(
  docId: string,
  imagePath: string,
  tenantToken: string,
  baseUrl: string,
): Promise<string> {
  const fileName = basename(imagePath);
  const fileSize = statSync(imagePath).size;
  const fileData = readFileSync(imagePath);

  // Build multipart/form-data manually (no external deps)
  const boundary = `----FormBoundary${Date.now().toString(16)}`;

  const textPart = (name: string, value: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n` +
      `\r\n` +
      `${value}\r\n`,
    );

  const filePart = (data: Buffer, name: string): Buffer =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: application/octet-stream\r\n` +
        `\r\n`,
      ),
      data,
      Buffer.from('\r\n'),
    ]);

  const body = Buffer.concat([
    textPart('parent_type', 'docx_image'),
    textPart('parent_node', docId),
    textPart('file_name', fileName),
    textPart('size', String(fileSize)),
    filePart(fileData, fileName),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/open-apis/drive/v1/medias/upload_all`);
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const req = reqFn(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tenantToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let resp: { code?: number; msg?: string; data?: { file_token?: string } };
          try {
            resp = JSON.parse(raw);
          } catch {
            reject(new Error(`Invalid JSON from upload: ${raw.substring(0, 200)}`));
            return;
          }
          if (resp.code !== 0) {
            reject(new Error(`Upload API error ${resp.code}: ${resp.msg}`));
            return;
          }
          const fileToken = resp.data?.file_token;
          if (!fileToken) {
            reject(new Error('No file_token in upload response'));
            return;
          }
          resolve(fileToken);
        });
      },
    );

    req.on('error', (err: Error) => reject(new Error(`Upload network error: ${err.message}`)));
    req.setTimeout(UPLOAD_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Upload timed out'));
    });

    req.write(body);
    req.end();
  });
}

// ---- Step 3: Bind image to block ----

async function bindImageToBlock(
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  await execFileAsync(
    'lark-cli',
    [
      'api', 'PATCH',
      `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
      '-d', JSON.stringify({ update_image: { token: fileToken } }),
    ],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
}

// ---- Rollback: Delete empty image block ----

async function rollbackBlock(docId: string, effectiveIndex: number): Promise<void> {
  if (effectiveIndex < 0) {
    console.error('WARN: Cannot rollback — insertion index unknown.');
    console.error('WARN: Document may contain an empty image block. Please clean up manually.');
    return;
  }
  try {
    await execFileAsync(
      'lark-cli',
      [
        'api', 'DELETE',
        `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
        '-d', JSON.stringify({ start_index: effectiveIndex, end_index: effectiveIndex + 1 }),
      ],
      { timeout: LARK_TIMEOUT_MS },
    );
    console.log(`INFO: Rolled back — deleted empty block at index ${effectiveIndex}`);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const detail = (execErr.stderr ?? execErr.message ?? '').replace(/\n/g, ' ').trim();
    console.error(`WARN: Rollback failed: ${detail}`);
    console.error('WARN: Document may contain an empty image block. Please clean up manually.');
  }
}

// ---- Main ----

async function main() {
  const docId = process.env.UPLOAD_DOC_ID ?? '';
  const imagePath = process.env.UPLOAD_IMAGE_PATH ?? '';
  const indexStr = process.env.UPLOAD_INDEX;
  const skipLark = process.env.UPLOAD_SKIP_LARK === '1';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  validateImageExtension(imagePath);
  const index = parseIndex(indexStr);

  const displayName = basename(imagePath);
  const positionLabel = index >= 0 ? ` at index ${index}` : ' (append)';
  console.log(`INFO: Uploading '${displayName}' to document ${docId}${positionLabel}`);

  // Check lark-cli availability
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Dry-run mode
  if (skipLark) {
    console.log(`OK: Image '${displayName}' would be uploaded to document ${docId}${positionLabel} (dry-run)`);
    return;
  }

  // Determine effective index (for append mode, count existing children)
  let effectiveIndex = index;
  if (index < 0) {
    try {
      effectiveIndex = await getBlockChildrenCount(docId);
      console.log(`INFO: Document has ${effectiveIndex} blocks, will append at index ${effectiveIndex}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`WARN: Could not count block children: ${msg}`);
      effectiveIndex = -1;
    }
  }

  // Step 1: Create empty image block
  let blockId: string;
  try {
    blockId = await createEmptyImageBlock(docId, effectiveIndex);
    console.log(`INFO: Created empty image block ${blockId}`);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const msg = (execErr.stderr ?? (err instanceof Error ? err.message : String(err)))
      .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    exit(`Step 1 failed (create empty block): ${msg}`);
  }

  // Step 2: Upload image
  let fileToken: string;
  try {
    const tenantToken = await getTenantToken();
    const baseUrl = getBaseUrl();
    fileToken = await uploadImage(docId, imagePath, tenantToken, baseUrl);
    console.log(`INFO: Uploaded image, file_token: ${fileToken}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Step 2 failed (upload image): ${msg}`);
    await rollbackBlock(docId, effectiveIndex);
    process.exit(1);
  }

  // Step 3: Bind image to block
  try {
    await bindImageToBlock(docId, blockId, fileToken);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const msg = (execErr.stderr ?? (err instanceof Error ? err.message : String(err)))
      .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    console.error(`ERROR: Step 3 failed (bind image): ${msg}`);
    await rollbackBlock(docId, effectiveIndex);
    process.exit(1);
  }

  console.log(`OK: Image '${displayName}' inserted into document ${docId} at block ${blockId}`);
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
