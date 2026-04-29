#!/usr/bin/env tsx
/**
 * skills/upload-docx-image/upload-docx-image.ts — Insert an image into a Feishu docx document.
 *
 * Takes a document ID, an image file path, and a block index, then:
 *   1. Creates an empty image block at the given index
 *   2. Uploads the image file as document media
 *   3. Binds the file_token to the image block
 *   4. Rolls back (deletes empty block) on partial failure
 *
 * Uses lark-cli for all operations (auth handled by lark-cli, not env vars).
 *
 * Environment variables:
 *   DOC_ID            Feishu document ID (doxcnXXX format)
 *   IMAGE_PATH        Path to the image file
 *   INSERT_INDEX      0-based index for block insertion
 *   UPLOAD_SKIP_LARK  Set to '1' to skip lark-cli calls (testing/dry-run)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 60_000;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Supported image extensions (lowercase) */
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

/**
 * Regex for Feishu document IDs.
 * Accepts formats like doxcnXXX, docxXXX, and other alphanumeric identifiers.
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_]+$/;

/**
 * Regex for valid filenames (no path traversal, no control chars).
 */
const SAFE_FILENAME_REGEX = /^[^/\x00-\x1F\x7F\\]+$/;

// ---- Validation ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateDocId(docId: string): void {
  if (!docId) {
    exit('DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must be alphanumeric (underscores allowed)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('IMAGE_PATH environment variable is required');
  }
  if (!existsSync(imagePath)) {
    exit(`Image file not found: ${imagePath}`);
  }

  const ext = extname(imagePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    exit(
      `Unsupported image format '${ext}' — supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    );
  }

  const stat = statSync(imagePath);
  if (stat.size === 0) {
    exit('Image file is empty (0 bytes)');
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    exit(`Image file too large (${sizeMB} MB) — maximum is 20 MB`);
  }
}

function validateInsertIndex(indexStr: string): number {
  if (!indexStr && indexStr !== '0') {
    exit('INSERT_INDEX environment variable is required');
  }
  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0) {
    exit(`Invalid INSERT_INDEX '${indexStr}' — must be a non-negative integer`);
  }
  return index;
}

/**
 * Sanitize a filename: extract basename, strip path traversal characters.
 */
function sanitizeFilename(filePath: string): string {
  const name = basename(filePath);
  if (!SAFE_FILENAME_REGEX.test(name)) {
    exit(`Unsafe filename '${name}' — contains invalid characters`);
  }
  return name;
}

// ---- JSON response parsing ----

interface LarkApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

/**
 * Parse JSON output from a lark-cli command.
 * lark-cli wraps API responses, so the useful data is often in `data` field.
 */
function parseLarkJson(stdout: string): LarkApiResponse {
  try {
    return JSON.parse(stdout.trim()) as LarkApiResponse;
  } catch {
    throw new Error(`Failed to parse lark-cli output as JSON: ${stdout.slice(0, 200)}`);
  }
}

/**
 * Extract block_id from block creation response.
 * Response shape: { code: 0, data: { children: [ { block_id: "blkxxx" } ] } }
 */
function extractBlockId(stdout: string): string {
  const resp = parseLarkJson(stdout);
  if (resp.code !== 0) {
    throw new Error(`Block creation failed: code=${resp.code}, msg=${resp.msg}`);
  }
  const children = resp.data?.children;
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error('Block creation returned no children in response');
  }
  const blockId = (children[0] as Record<string, unknown>).block_id as string;
  if (!blockId) {
    throw new Error('Block creation response missing block_id');
  }
  return blockId;
}

/**
 * Extract file_token from media upload response.
 * Response shape: { code: 0, data: { file_token: "boxcnXXX" } }
 * or from shortcut: { file_token: "boxcnXXX", ... }
 */
function extractFileToken(stdout: string): string {
  const resp = parseLarkJson(stdout);

  // Shortcut output may have file_token at top level
  if (resp.file_token) {
    return resp.file_token as string;
  }

  // Standard API response
  if (resp.code !== undefined && resp.code !== 0) {
    throw new Error(`Media upload failed: code=${resp.code}, msg=${resp.msg}`);
  }

  const data = resp.data ?? resp;
  const fileToken = data.file_token as string;
  if (!fileToken) {
    throw new Error('Media upload response missing file_token');
  }
  return fileToken;
}

// ---- Core logic ----

/**
 * Step 1: Create an empty image block at the given index.
 * Uses raw API: POST /open-apis/docx/v1/apps/{docId}/blocks/{docId}/children
 */
async function createEmptyImageBlock(
  docId: string,
  index: number,
): Promise<string> {
  const body = JSON.stringify({
    children: [{ block_type: 27 }], // 27 = image block type
    index,
  });

  const { stdout } = await execFileAsync(
    'lark-cli',
    ['api', 'POST', `/open-apis/docx/v1/apps/${docId}/blocks/${docId}/children`, '-d', body],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );

  return extractBlockId(stdout);
}

/**
 * Step 2: Upload the image file as document media.
 * Uses lark-cli drive shortcut: drive +upload --as-media --doc
 */
async function uploadImageAsMedia(
  docId: string,
  imagePath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'lark-cli',
    ['drive', '+upload', '--as-media', '--doc', docId, '--file', imagePath],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );

  return extractFileToken(stdout);
}

/**
 * Step 3: Bind the file_token to the image block.
 * Uses raw API: PATCH /open-apis/docx/v1/apps/{docId}/blocks/{blockId}
 */
async function bindImageToBlock(
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  const body = JSON.stringify({
    replace_image: { token: fileToken },
  });

  await execFileAsync(
    'lark-cli',
    ['api', 'PATCH', `/open-apis/docx/v1/apps/${docId}/blocks/${blockId}`, '-d', body],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
}

/**
 * Rollback: Delete the empty image block at the given index.
 * Best-effort — logs warning if cleanup also fails.
 */
async function rollbackEmptyBlock(docId: string, index: number): Promise<void> {
  const body = JSON.stringify({
    start_index: index,
    end_index: index + 1,
  });

  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'POST', `/open-apis/docx/v1/apps/${docId}/blocks/${docId}/children/batch_delete`, '-d', body],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    console.log(`INFO: Rollback succeeded — deleted empty block at index ${index}`);
  } catch (rollbackErr) {
    console.error(
      `WARN: Rollback failed — empty image block may remain at index ${index}. ` +
      `Error: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`,
    );
  }
}

// ---- Main ----

async function main() {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX ?? '';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  const insertIndex = validateInsertIndex(indexStr);
  const fileName = sanitizeFilename(imagePath);

  console.log(`INFO: Uploading '${fileName}' to document ${docId} at index ${insertIndex}`);

  // Check lark-cli availability (skippable for testing)
  if (process.env.UPLOAD_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }
  }

  // Dry-run mode: skip actual API calls
  if (process.env.UPLOAD_SKIP_LARK === '1') {
    console.log(`OK: Image '${fileName}' inserted at index ${insertIndex} (dry-run)`);
    console.log(`    doc_id=${docId}, index=${insertIndex}`);
    return;
  }

  // Step 1: Create empty image block at the desired index
  let blockId: string;
  try {
    blockId = await createEmptyImageBlock(docId, insertIndex);
    console.log(`INFO: Created empty image block ${blockId} at index ${insertIndex}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    exit(`Failed to create image block: ${msg}`);
  }

  // Step 2: Upload image file as document media
  let fileToken: string;
  try {
    fileToken = await uploadImageAsMedia(docId, imagePath);
    console.log(`INFO: Uploaded image, file_token=${fileToken}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Image upload failed: ${msg}`);
    console.error('INFO: Attempting rollback...');
    await rollbackEmptyBlock(docId, insertIndex);
    exit(`Image upload failed, rollback attempted: ${msg}`);
  }

  // Step 3: Bind file_token to the image block
  try {
    await bindImageToBlock(docId, blockId, fileToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Block binding failed: ${msg}`);
    console.error('INFO: Attempting rollback...');
    await rollbackEmptyBlock(docId, insertIndex);
    exit(`Block binding failed, rollback attempted: ${msg}`);
  }

  // Success
  const result = {
    document_id: docId,
    block_id: blockId,
    file_token: fileToken,
    file_name: fileName,
    index: insertIndex,
  };
  console.log(`OK: Image inserted successfully`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
