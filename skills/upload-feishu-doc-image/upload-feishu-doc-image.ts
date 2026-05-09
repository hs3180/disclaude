#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 * Insert an image into a Feishu document at a specific position via lark-cli.
 *
 * Three-step API flow:
 *   1. POST create empty image block (block_type: 27) at given index
 *   2. POST upload image file via Drive Media API (parent_type: "docx_image")
 *   3. PATCH bind uploaded file to the image block (replace_image)
 *
 * On partial failure (step 1 succeeds but step 2/3 fails), the empty block
 * is automatically cleaned up via DELETE.
 *
 * Authentication: uses lark-cli's built-in auth — no direct credential handling.
 *
 * Environment variables:
 *   FEISHU_DOC_ID       Feishu document ID
 *   FEISHU_IMAGE_PATH   Local path to the image file
 *   FEISHU_IMAGE_INDEX  Insert position (0-based, -1 for append to end)
 *   FEISHU_SKIP_LARK    Set to '1' for dry-run testing
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 60_000;
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
const VALID_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/** Feishu document IDs are typically alphanumeric, may contain underscores. */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function getImageExtension(filePath: string): string {
  const ext = basename(filePath).toLowerCase().split('.').pop() ?? '';
  return `.${ext}`;
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) {
    exit('FEISHU_DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid FEISHU_DOC_ID '${docId}' — must be alphanumeric (underscores/dashes allowed)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('FEISHU_IMAGE_PATH environment variable is required');
  }
  if (!existsSync(imagePath)) {
    exit(`Image file not found: ${imagePath}`);
  }
  const ext = getImageExtension(imagePath);
  if (!VALID_IMAGE_EXTENSIONS.has(ext)) {
    exit(`Unsupported image format '${ext}' — supported: ${[...VALID_IMAGE_EXTENSIONS].join(', ')}`);
  }
  const size = statSync(imagePath).size;
  if (size === 0) {
    exit('Image file is empty');
  }
  if (size > MAX_IMAGE_SIZE_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    exit(`Image file too large: ${mb}MB (max 20MB)`);
  }
}

function parseIndex(raw: string): number {
  if (!raw && raw !== '0') {
    return -1; // default: append
  }
  const idx = parseInt(raw, 10);
  if (isNaN(idx)) {
    exit(`Invalid FEISHU_IMAGE_INDEX '${raw}' — must be an integer or -1`);
  }
  return idx;
}

// ---- Core API calls via lark-cli ----

interface LarkResponse {
  code: number;
  msg?: string;
  data?: Record<string, unknown>;
}

function parseLarkResponse(stdout: string): LarkResponse {
  try {
    return JSON.parse(stdout);
  } catch {
    return { code: -1, msg: `Failed to parse lark-cli response: ${stdout.slice(0, 200)}` };
  }
}

/**
 * Step 1: Create an empty image block at the given index.
 * Returns the block_id of the newly created image block.
 */
async function createEmptyImageBlock(
  docId: string,
  index: number,
): Promise<string> {
  const children = [{ block_type: 27, image: {} }];
  const body = index >= 0 ? { children, index } : { children };

  console.log(`INFO: Creating empty image block in doc ${docId} at index ${index}`);

  const { stdout } = await execFileAsync(
    'lark-cli',
    [
      'api', 'POST',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      '-d', JSON.stringify(body),
    ],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
  );

  const resp = parseLarkResponse(stdout);
  if (resp.code !== 0) {
    exit(`Step 1 failed — create image block: code=${resp.code} msg=${resp.msg}`);
  }

  // Extract block_id from response: data.children[0].block_id
  const children_resp = (resp.data?.children as Array<{ block_id?: string }>) ?? [];
  const blockId = children_resp[0]?.block_id;
  if (!blockId) {
    exit(`Step 1 failed — no block_id in response: ${stdout.slice(0, 300)}`);
  }

  console.log(`INFO: Created image block ${blockId}`);
  return blockId;
}

/**
 * Step 2: Upload image file via Drive Media API.
 * Returns the file_token of the uploaded image.
 *
 * lark-cli does not support multipart form-data directly,
 * so we use curl with the access token from lark-cli.
 */
async function uploadImageFile(
  imagePath: string,
  docId: string,
): Promise<string> {
  console.log(`INFO: Uploading image file ${imagePath}`);

  // Get access token from lark-cli
  const { stdout: tokenOut } = await execFileAsync(
    'lark-cli',
    ['token', '--access'],
    { timeout: 10_000 },
  );
  const accessToken = tokenOut.trim();
  if (!accessToken) {
    exit('Failed to get access token from lark-cli — is lark-cli authenticated?');
  }

  const fileName = basename(imagePath);
  // Sanitize filename for header safety
  const safeFileName = fileName.replace(/["\r\n]/g, '_');

  // Use curl for multipart upload (lark-cli api doesn't support file upload)
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sS',
      '-X', 'POST',
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
      '-H', `Authorization: Bearer ${accessToken}`,
      '-F', `file_type=image`,
      '-F', `file_name=${safeFileName}`,
      '-F', `parent_type=docx_image`,
      '-F', `parent_node=${docId}`,
      '-F', `file=@${imagePath}`,
    ],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
  );

  const resp = parseLarkResponse(stdout);
  if (resp.code !== 0) {
    throw new Error(`Step 2 failed — upload image: code=${resp.code} msg=${resp.msg}`);
  }

  const fileToken = (resp.data as { file_token?: string })?.file_token;
  if (!fileToken) {
    throw new Error(`Step 2 failed — no file_token in response: ${stdout.slice(0, 300)}`);
  }

  console.log(`INFO: Uploaded image, file_token=${fileToken}`);
  return fileToken;
}

/**
 * Step 3: Bind the uploaded file to the image block.
 */
async function bindImageToBlock(
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  console.log(`INFO: Binding image ${fileToken} to block ${blockId}`);

  const body = {
    replace_image: {
      token: fileToken,
    },
  };

  const { stdout } = await execFileAsync(
    'lark-cli',
    [
      'api', 'PATCH',
      `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
      '-d', JSON.stringify(body),
    ],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
  );

  const resp = parseLarkResponse(stdout);
  if (resp.code !== 0) {
    throw new Error(`Step 3 failed — bind image: code=${resp.code} msg=${resp.msg}`);
  }

  console.log(`INFO: Image bound to block ${blockId}`);
}

/**
 * Cleanup: delete an empty image block on partial failure.
 */
async function deleteBlock(docId: string, blockId: string): Promise<void> {
  console.log(`INFO: Cleaning up empty block ${blockId} after failure`);
  try {
    await execFileAsync(
      'lark-cli',
      [
        'api', 'DELETE',
        `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
        '-d', JSON.stringify({ start_index: -1, end_index: -1, block_ids: [blockId] }),
      ],
      { timeout: LARK_TIMEOUT_MS },
    );
    console.log(`INFO: Cleaned up block ${blockId}`);
  } catch (err) {
    // Best-effort cleanup — log but don't fail
    console.error(`WARN: Failed to cleanup block ${blockId}: ${err}`);
  }
}

// ---- Main ----

async function main() {
  const docId = process.env.FEISHU_DOC_ID ?? '';
  const imagePath = process.env.FEISHU_IMAGE_PATH ?? '';
  const indexRaw = process.env.FEISHU_IMAGE_INDEX ?? '';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  const index = parseIndex(indexRaw);

  const fileName = basename(imagePath);
  console.log(`INFO: Inserting image '${fileName}' into doc ${docId} at index ${index}`);

  // Check lark-cli availability
  if (process.env.FEISHU_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH. Please install and authenticate lark-cli first.');
    }
  }

  // Dry-run mode
  if (process.env.FEISHU_SKIP_LARK === '1') {
    console.log(`OK: Image '${fileName}' would be inserted at index ${index} (dry-run)`);
    return;
  }

  // Step 1: Create empty image block
  const blockId = await createEmptyImageBlock(docId, index);

  // Steps 2+3 with rollback on failure
  try {
    // Step 2: Upload image file
    const fileToken = await uploadImageFile(imagePath, docId);

    // Step 3: Bind image to block
    await bindImageToBlock(docId, blockId, fileToken);
  } catch (err) {
    // Rollback: delete the empty block we created
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    await deleteBlock(docId, blockId);
    exit('Image insertion failed — empty block cleaned up. See errors above for details.');
  }

  console.log(`OK: Image '${fileName}' inserted at index ${index}, block_id=${blockId}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
