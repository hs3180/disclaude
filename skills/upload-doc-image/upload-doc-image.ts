#!/usr/bin/env tsx
/**
 * skills/upload-doc-image/upload-doc-image.ts — Insert an image into a Feishu document at a specific position.
 *
 * lark-cli's `docs +media-insert` only appends images to the end. This script
 * uses the Lark API directly to insert images at arbitrary positions via the
 * 3-step process:
 *
 *   1. Create an empty image block (block_type: 27) at the desired index
 *   2. Upload the image file via the Drive Media Upload API (multipart/form-data)
 *   3. Bind the uploaded file to the image block via replace_image
 *
 * Auth: Steps 1 & 3 use `lark-cli api` (automatic auth). Step 2 (multipart
 * upload) reads lark-cli's configured credentials since `lark-cli api` does not
 * support multipart/form-data.
 *
 * Environment variables:
 *   DOC_ID              (required) Feishu document ID
 *   IMAGE_PATH          (required) Absolute path to the image file (PNG/JPG/JPEG/WEBP)
 *   INSERT_INDEX        (required) 0-based position to insert at (-1 to append)
 *   UPLOAD_SKIP_API     (optional) Set to '1' to skip API calls (dry-run)
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

const LARK_BASE_URL = 'https://open.feishu.cn';
const LARK_TIMEOUT_MS = 30_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// Less strict than PR #2929 — allows underscores and hyphens found in real doc IDs
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function sanitizeFileName(name: string): string {
  // Strip characters that could cause header injection in multipart boundaries
  return name.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '');
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) exit('DOC_ID environment variable is required');
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must be alphanumeric (underscores and hyphens allowed)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) exit('IMAGE_PATH environment variable is required');
  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    exit(`Invalid IMAGE_PATH extension '${ext}' — must be one of: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }
}

function validateIndex(indexStr: string): number {
  if (!indexStr && indexStr !== '0') exit('INSERT_INDEX environment variable is required');
  const index = parseInt(indexStr, 10);
  if (!Number.isFinite(index)) exit(`Invalid INSERT_INDEX '${indexStr}' — must be an integer`);
  if (index < -1) exit(`Invalid INSERT_INDEX '${indexStr}' — must be >= -1 (-1 means append)`);
  return index;
}

// ---- Auth: Obtain tenant_access_token using lark-cli's configured credentials ----

async function getLarkCredentials(): Promise<{ appId: string; appSecret: string }> {
  try {
    const { stdout: appIdOut } = await execFileAsync('lark-cli', ['config', 'get', 'appId'], { timeout: 5000 });
    const { stdout: appSecretOut } = await execFileAsync('lark-cli', ['config', 'get', 'appSecret'], { timeout: 5000 });
    const appId = appIdOut.trim();
    const appSecret = appSecretOut.trim();
    if (!appId || !appSecret) {
      exit('lark-cli credentials incomplete. Run: lark-cli config set appId YOUR_ID && lark-cli config set appSecret YOUR_SECRET');
    }
    return { appId, appSecret };
  } catch {
    exit('Failed to read lark-cli config. Ensure lark-cli is installed and configured (lark-cli config set appId ...)');
  }
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const url = `${LARK_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!response.ok) {
    throw new Error(`Auth API HTTP error: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { code: number; msg: string; tenant_access_token?: string };
  if (data.code !== 0) {
    throw new Error(`Auth API error: code=${data.code}, msg=${data.msg}`);
  }
  if (!data.tenant_access_token) {
    throw new Error('Auth API returned no tenant_access_token');
  }
  return data.tenant_access_token;
}

// ---- Step 1: Create empty image block via lark-cli api ----

async function createImageBlock(docId: string, index: number): Promise<string> {
  const body: Record<string, unknown> = {
    children: [{ block_type: 27 }], // Image block type (NOT 4, which is Heading2)
  };
  if (index >= 0) body.index = index;

  const { stdout } = await execFileAsync(
    'lark-cli',
    ['api', 'POST', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`, '-d', JSON.stringify(body)],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );

  const data = JSON.parse(stdout) as {
    code: number; msg: string;
    data?: { children?: Array<{ block_id: string }> };
  };
  if (data.code !== 0) {
    throw new Error(`Create block API error: code=${data.code}, msg=${data.msg}`);
  }
  const blockId = data.data?.children?.[0]?.block_id;
  if (!blockId) throw new Error('Create block returned no block_id');
  return blockId;
}

// ---- Step 2: Upload image via fetch() (multipart/form-data) ----

async function uploadImage(
  token: string,
  docId: string,
  imageBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const boundary = `----FormBoundary${Date.now()}`;
  const safeName = sanitizeFileName(fileName || 'image.png');

  // Build multipart form-data manually (no external dependencies)
  const headerParts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="parent_type"',
    '',
    'docx_image',
    `--${boundary}`,
    'Content-Disposition: form-data; name="parent_node"',
    '',
    docId,
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${safeName}"`,
    'Content-Type: application/octet-stream',
    '',
  ].join('\r\n') + '\r\n';

  const closingBoundary = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(headerParts, 'utf-8'),
    imageBuffer,
    Buffer.from(closingBoundary, 'utf-8'),
  ]);

  const response = await fetch(`${LARK_BASE_URL}/open-apis/drive/v1/medias/upload_all`, {
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

  const data = (await response.json()) as {
    code: number; msg: string; data?: { file_token?: string };
  };
  if (data.code !== 0) {
    throw new Error(`Upload API error: code=${data.code}, msg=${data.msg}`);
  }
  if (!data.data?.file_token) {
    throw new Error('Upload returned no file_token');
  }
  return data.data.file_token;
}

// ---- Step 3: Bind image to block via lark-cli api ----

async function bindImageToBlock(docId: string, blockId: string, fileToken: string): Promise<void> {
  const { stdout } = await execFileAsync(
    'lark-cli',
    ['api', 'PATCH', `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`, '-d', JSON.stringify({ replace_image: { token: fileToken } })],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );

  const data = JSON.parse(stdout) as { code: number; msg: string };
  if (data.code !== 0) {
    throw new Error(`Bind image API error: code=${data.code}, msg=${data.msg}`);
  }
}

// ---- Rollback: Delete empty block on partial failure ----

async function rollbackBlock(docId: string, blockId: string, index: number): Promise<void> {
  try {
    if (index >= 0) {
      // Use batch_delete with known index
      await execFileAsync(
        'lark-cli',
        ['api', 'DELETE',
          `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
          '-d', JSON.stringify({ start_index: index, end_index: index + 1 }),
        ],
        { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
    } else {
      // For append (-1), we don't know the exact index without listing children.
      // Try listing children to find the block position.
      const { stdout } = await execFileAsync(
        'lark-cli',
        ['api', 'GET', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`, '-p', 'page_size=50'],
        { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      const listData = JSON.parse(stdout) as {
        code: number;
        data?: { items?: Array<{ block_id: string }> };
      };
      if (listData.code === 0 && listData.data?.items) {
        const blockIndex = listData.data.items.findIndex((b) => b.block_id === blockId);
        if (blockIndex >= 0) {
          await execFileAsync(
            'lark-cli',
            ['api', 'DELETE',
              `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
              '-d', JSON.stringify({ start_index: blockIndex, end_index: blockIndex + 1 }),
            ],
            { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          );
        }
      }
    }
    console.log(`INFO: Rolled back — deleted empty block ${blockId}`);
  } catch (err) {
    console.error(`WARN: Failed to rollback block ${blockId}: ${err instanceof Error ? err.message : err}`);
    console.error('WARN: You may need to manually delete the empty image block from the document.');
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX ?? '';
  const skipApi = process.env.UPLOAD_SKIP_API === '1';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  const index = validateIndex(indexStr);

  // Resolve and check image file
  const absoluteImagePath = resolve(imagePath);
  let fileSize: number;
  try {
    const fileStat = await stat(absoluteImagePath);
    fileSize = fileStat.size;
  } catch {
    exit(`Image file not found: ${absoluteImagePath}`);
  }
  if (fileSize === 0) exit('Image file is empty');
  if (fileSize > MAX_IMAGE_SIZE) {
    exit(`Image file too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max: 20 MB)`);
  }

  const fileName = basename(absoluteImagePath);
  const position = index === -1 ? 'end (append)' : `index ${index}`;
  console.log(`INFO: Inserting image '${fileName}' (${(fileSize / 1024).toFixed(1)} KB) into doc ${docId} at ${position}`);

  // Dry-run mode
  if (skipApi) {
    console.log('OK: Image insertion prepared (dry-run — skipped API calls)');
    console.log(`  doc_id: ${docId}`);
    console.log(`  image: ${fileName}`);
    console.log(`  index: ${index}`);
    return;
  }

  // Check lark-cli availability
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH. Install with: npm install -g @larksuite/cli');
  }

  // Get auth credentials from lark-cli config for the multipart upload step
  const { appId, appSecret } = await getLarkCredentials();
  const token = await getTenantAccessToken(appId, appSecret);
  console.log('INFO: Authenticated successfully');

  // Step 1: Create empty image block
  let blockId: string;
  try {
    blockId = await createImageBlock(docId, index);
    console.log(`INFO: Created image block ${blockId} at ${position}`);
  } catch (err) {
    exit(`Step 1 failed (create block): ${err instanceof Error ? err.message : err}`);
  }

  // Step 2: Upload image file
  let fileToken: string;
  try {
    const imageBuffer = await readFile(absoluteImagePath);
    fileToken = await uploadImage(token, docId, imageBuffer, fileName);
    console.log(`INFO: Uploaded image, file_token: ${fileToken}`);
  } catch (err) {
    console.error(`ERROR: Step 2 failed (upload image): ${err instanceof Error ? err.message : err}`);
    await rollbackBlock(docId, blockId, index);
    process.exit(1);
  }

  // Step 3: Bind image to block
  try {
    await bindImageToBlock(docId, blockId, fileToken);
    console.log(`INFO: Bound image to block ${blockId}`);
  } catch (err) {
    console.error(`ERROR: Step 3 failed (bind image): ${err instanceof Error ? err.message : err}`);
    await rollbackBlock(docId, blockId, index);
    process.exit(1);
  }

  console.log('OK: Image inserted successfully');
  console.log(`  block_id: ${blockId}`);
  console.log(`  file_token: ${fileToken}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
