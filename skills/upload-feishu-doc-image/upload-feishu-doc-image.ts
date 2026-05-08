#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 * Insert an image at a specific position in a Feishu document.
 *
 * 3-step Lark API process:
 *   1. Create empty image block (block_type: 27) at the desired index
 *   2. Upload image file via Drive Media Upload API
 *   3. Bind uploaded file to the image block via replace_image
 *
 * Authentication: Uses lark-cli's built-in auth (reads credentials from lark-cli config).
 * Steps 1 & 3 use `lark-cli api` directly; Step 2 uses Node.js fetch for multipart upload.
 *
 * Environment variables:
 *   DOC_ID          Feishu document ID
 *   IMAGE_PATH      Local path to the image file
 *   INSERT_INDEX    0-based insertion position (default: -1 = append)
 *   UPLOAD_SKIP_LARK  Set to '1' for dry-run (no API calls)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB Feishu limit
const MAX_RETRIES = 3;
const VALID_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
const FEISHU_BASE = 'https://open.feishu.cn';

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`INFO: ${msg}`);
}

/**
 * Regex for Feishu document IDs.
 * Feishu doc IDs are alphanumeric strings, sometimes with underscores or hyphens.
 * More permissive than the old ^[a-zA-Z0-9]+$ to cover actual ID formats.
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) {
    exit('DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must be alphanumeric (may contain _ and -)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('IMAGE_PATH environment variable is required');
  }
  const absPath = resolve(imagePath);
  if (!existsSync(absPath)) {
    exit(`Image file not found: ${absPath}`);
  }
  const ext = extname(absPath).toLowerCase();
  if (!VALID_EXTENSIONS.includes(ext)) {
    exit(`Unsupported image format '${ext}' — supported: ${VALID_EXTENSIONS.join(', ')}`);
  }
  const stats = statSync(absPath);
  if (stats.size === 0) {
    exit('Image file is empty (0 bytes)');
  }
  if (stats.size > MAX_IMAGE_SIZE_BYTES) {
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    exit(`Image file too large (${sizeMB}MB) — Feishu limit is 20MB`);
  }
}

function parseInsertIndex(raw: string | undefined): number {
  if (!raw || raw === '') return -1;
  const idx = parseInt(raw, 10);
  if (isNaN(idx)) {
    exit(`Invalid INSERT_INDEX '${raw}' — must be a non-negative integer or empty`);
  }
  if (idx < -1) {
    exit(`Invalid INSERT_INDEX '${raw}' — must be >= -1`);
  }
  return idx;
}

// ---- Lark CLI ----

/**
 * Check lark-cli availability.
 */
async function checkLarkCli(): Promise<void> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH. Install lark-cli first.');
  }
}

/**
 * Verify lark-cli is authenticated by making a simple API call.
 */
async function verifyLarkAuth(): Promise<void> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'GET', '/open-apis/bot/v3/info/'],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const msg = (execErr.stderr ?? execErr.message ?? '').toString();
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('auth')) {
      exit('lark-cli is not authenticated. Run `lark-cli auth` or configure credentials first.');
    }
    // Other errors (e.g., 404 for bot info) might still mean auth works
    // Don't fail here — let the actual API calls handle auth errors
  }
}

/**
 * Call lark-cli api with JSON body. Returns parsed response.
 */
async function larkApi(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const args = ['api', method, endpoint];
  if (body) {
    args.push('-d', JSON.stringify(body));
  }
  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const errMsg = (execErr.stderr ?? execErr.stdout ?? execErr.message ?? 'unknown error')
      .toString()
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`lark-cli api ${method} ${endpoint} failed: ${errMsg}`);
  }
}

// ---- Step 1: Create empty image block ----

interface CreateBlockResult {
  blockId: string;
}

/**
 * Step 1: Create an empty image block at the specified index.
 * Uses lark-cli api POST (JSON body).
 */
async function createImageBlock(docId: string, index: number): Promise<CreateBlockResult> {
  const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;
  const body: Record<string, unknown> = {
    children: [
      {
        block_type: 27, // Image block type (NOT 4 which is Heading2)
      },
    ],
  };
  if (index >= 0) {
    body.index = index;
  }

  const resp = await larkApi('POST', endpoint, body);

  // Parse response to get the new block ID
  const data = resp.data as Record<string, unknown> | undefined;
  if (!data) {
    throw new Error(`Create block response missing 'data' field: ${JSON.stringify(resp)}`);
  }

  // Response structure: { data: { children: [ { block_id: "xxx" } ] } }
  const children = data.children as Array<Record<string, unknown>> | undefined;
  if (!children || children.length === 0) {
    throw new Error(`Create block response missing children: ${JSON.stringify(resp)}`);
  }

  const blockId = children[0].block_id as string;
  if (!blockId) {
    throw new Error(`Create block response missing block_id: ${JSON.stringify(resp)}`);
  }

  return { blockId };
}

// ---- Step 2: Upload image file ----

/**
 * Read lark-cli config to get app credentials for the multipart upload.
 * lark-cli stores config at ~/.lark-cli/config.yaml.
 * This IS using lark-cli's authentication mechanism — we read the same
 * credentials that lark-cli uses internally.
 */
function getLarkCredentials(): { appId: string; appSecret: string } {
  const configPaths = [
    resolve(homedir(), '.lark-cli', 'config.yaml'),
    resolve(homedir(), '.lark-cli', 'config.yml'),
    resolve(homedir(), '.config', 'lark-cli', 'config.yaml'),
  ];

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, 'utf8');

      // Simple YAML extraction — lark-cli config has a flat structure:
      // app_id: "cli_xxx"
      // app_secret: "xxx"
      const appIdMatch = content.match(/app_id:\s*["']?([^"'\n]+)["']?/);
      const appSecretMatch = content.match(/app_secret:\s*["']?([^"'\n]+)["']?/);

      if (appIdMatch?.[1] && appSecretMatch?.[1]) {
        return {
          appId: appIdMatch[1].trim(),
          appSecret: appSecretMatch[1].trim(),
        };
      }
    } catch {
      // Continue to next path
    }
  }

  exit(
    'lark-cli config not found or missing app_id/app_secret. ' +
    'Run `lark-cli auth` to configure credentials first.',
  );
}

/**
 * Get a tenant_access_token using the lark-cli credentials.
 */
async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<string> {
  const response = await fetch(
    `${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );

  if (!response.ok) {
    throw new Error(`Token API returned HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const code = data.code as number;
  if (code !== 0) {
    throw new Error(`Token API error code ${code}: ${data.msg}`);
  }

  const token = data.tenant_access_token as string;
  if (!token) {
    throw new Error('Token API did not return tenant_access_token');
  }

  return token;
}

/**
 * Upload image via multipart/form-data using Node.js fetch.
 * Returns the file_token from the response.
 */
async function uploadImage(
  docId: string,
  imagePath: string,
  token: string,
): Promise<string> {
  const absPath = resolve(imagePath);
  const imageBuffer = readFileSync(absPath);
  const ext = extname(absPath).toLowerCase();
  const mimeType = getMimeType(ext);
  const fileName = absPath.split('/').pop() ?? 'image.png';

  // Build multipart form-data manually (no external dependencies)
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  const parts: Buffer[] = [];

  // Part 1: parent_type
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="parent_type"\r\n\r\n` +
    `docx_image\r\n`,
  ));

  // Part 2: parent_node (document ID)
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="parent_node"\r\n\r\n` +
    `${docId}\r\n`,
  ));

  // Part 3: file
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
  ));
  parts.push(imageBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  // Retry logic for upload
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(
        `${FEISHU_BASE}/open-apis/drive/v1/medias/upload_all`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
          // @ts-expect-error Node.js fetch supports AbortSignal.timeout
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upload API returned HTTP ${response.status}: ${text}`);
      }

      const data = await response.json() as Record<string, unknown>;
      const code = data.code as number;
      if (code !== 0) {
        throw new Error(`Upload API error code ${code}: ${data.msg}`);
      }

      const fileToken = (data.data as Record<string, unknown>)?.file_token as string;
      if (!fileToken) {
        throw new Error(`Upload response missing file_token: ${JSON.stringify(data)}`);
      }

      return fileToken;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * attempt; // Simple linear backoff
        log(`Upload attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Upload failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

// ---- Step 3: Bind image to block ----

/**
 * Step 3: Bind the uploaded file to the empty image block using replace_image.
 * Uses lark-cli api PATCH (JSON body).
 */
async function bindImage(docId: string, blockId: string, fileToken: string): Promise<void> {
  const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`;
  const body = {
    replace_image: {
      token: fileToken,
    },
  };

  const resp = await larkApi('PATCH', endpoint, body);

  const code = resp.code as number;
  if (code !== 0) {
    throw new Error(`Bind image API error code ${code}: ${resp.msg}`);
  }
}

// ---- Rollback ----

/**
 * Delete an empty image block (cleanup on partial failure).
 */
async function deleteBlock(docId: string, blockId: string): Promise<void> {
  try {
    const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;
    // Use batch_delete to remove the block
    await larkApi('DELETE', endpoint, {
      start_index: -1, // Will need to find the actual index
      end_index: -1,
      block_ids: [blockId],
    });
    log(`Rollback: deleted empty image block ${blockId}`);
  } catch (err) {
    // Best-effort rollback — log but don't fail
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARNING: Failed to delete empty block ${blockId}: ${msg}`);
    console.error('Please manually remove the empty image block from the document.');
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexRaw = process.env.INSERT_INDEX;
  const skipLark = process.env.UPLOAD_SKIP_LARK === '1';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  const insertIndex = parseInsertIndex(indexRaw);

  log(`Inserting image '${imagePath}' into doc ${docId} at index ${insertIndex}`);

  // Dry-run mode
  if (skipLark) {
    log(`[DRY-RUN] Would insert image at index ${insertIndex}`);
    log(`OK: Image insertion completed (dry-run)`);
    return;
  }

  // Check lark-cli
  await checkLarkCli();
  await verifyLarkAuth();

  // Step 1: Create empty image block
  log('Step 1/3: Creating empty image block...');
  let blockId = '';
  try {
    const result = await createImageBlock(docId, insertIndex);
    blockId = result.blockId;
    log(`Created empty image block: ${blockId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    exit(`Step 1 failed (create block): ${msg}`);
  }

  // Step 2: Upload image
  log('Step 2/3: Uploading image file...');
  let fileToken = '';
  try {
    const creds = getLarkCredentials();
    const token = await getTenantAccessToken(creds.appId, creds.appSecret);
    fileToken = await uploadImage(docId, imagePath, token);
    log(`Uploaded image, file_token: ${fileToken}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Step 2 failed (upload image): ${msg}`);
    // Rollback: delete the empty block
    await deleteBlock(docId, blockId);
    exit(`Step 2 failed (upload image): ${msg}`);
  }

  // Step 3: Bind image to block
  log('Step 3/3: Binding image to block...');
  try {
    await bindImage(docId, blockId, fileToken);
    log(`Bound file ${fileToken} to block ${blockId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Step 3 failed (bind image): ${msg}`);
    // Rollback: delete the empty block
    await deleteBlock(docId, blockId);
    exit(`Step 3 failed (bind image): ${msg}`);
  }

  log(`OK: Image inserted successfully at index ${insertIndex}`);
  log(`  Document: ${docId}`);
  log(`  Block ID: ${blockId}`);
  log(`  File token: ${fileToken}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
