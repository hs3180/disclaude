#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 *
 * Upload and insert an image into a Feishu document at a specific position.
 *
 * Uses lark-cli for all API operations (authentication handled automatically).
 * No external dependencies — only Node.js built-in modules.
 *
 * Strategy:
 *   index = -1 (append): lark-cli docs +media-insert (1 step)
 *   index >= 0 (insert at position):
 *     1. Upload via lark-cli docs +media-insert (at end)
 *     2. Extract file_token from the inserted block
 *     3. Delete the block from the end
 *     4. Create empty image block at the desired position
 *     5. Bind file_token to the new block
 *
 * Environment variables:
 *   FEISHU_DOC_ID       Feishu document ID (required)
 *   FEISHU_IMAGE_PATH   Path to image file (required)
 *   FEISHU_IMAGE_INDEX  Insert position: -1 = append, 0+ = specific index (default: -1)
 *   FEISHU_SKIP_LARK    Set to '1' for dry-run mode (testing only)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 60_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB (Lark Drive limit)
const VALID_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

/**
 * Regex for Feishu document IDs.
 * Real document IDs can contain letters, digits, underscores, and hyphens.
 * More permissive than the previous ^[a-zA-Z0-9]+$ regex to handle actual formats.
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,}$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseJsonOutput(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    exit(`Failed to parse lark-cli JSON output: ${raw.slice(0, 300)}`);
  }
}

/** Make a lark-cli raw API call with optional JSON body. */
async function larkApi(
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<Record<string, any>> {
  const args = ['api', method, apiPath];
  if (body) {
    args.push('--data', JSON.stringify(body));
  }

  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseJsonOutput(stdout);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { code: -1, msg: errorMsg };
  }
}

/** Upload and insert image at end of document via lark-cli shortcut. */
async function mediaInsert(
  docId: string,
  filePath: string,
): Promise<Record<string, any>> {
  try {
    const { stdout } = await execFileAsync('lark-cli', [
      'docs', '+media-insert',
      '--doc-id', docId,
      '--file', filePath,
      '--format', 'json',
    ], {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseJsonOutput(stdout);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { code: -1, msg: errorMsg };
  }
}

/** Safely delete blocks by index — used for cleanup, never throws. */
async function safeBatchDelete(
  docId: string,
  startIndex: number,
  endIndex: number,
): Promise<void> {
  try {
    await larkApi(
      'DELETE',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
      { start_index: startIndex, end_index: endIndex },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Cleanup delete failed (index ${startIndex}-${endIndex}): ${msg}`);
  }
}

// ---- Validation ----

function validateInputs(
  docId: string,
  imagePath: string,
  indexStr: string,
): { insertIndex: number; absolutePath: string } {
  if (!docId) exit('FEISHU_DOC_ID environment variable is required');
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid FEISHU_DOC_ID: '${docId}' — must be 6+ alphanumeric/underscore/hyphen chars`);
  }

  if (!imagePath) exit('FEISHU_IMAGE_PATH environment variable is required');
  const absolutePath = path.resolve(imagePath);
  const ext = path.extname(absolutePath).toLowerCase();
  if (!VALID_IMAGE_EXTENSIONS.has(ext)) {
    exit(`Unsupported image format: '${ext}'. Supported: ${[...VALID_IMAGE_EXTENSIONS].join(', ')}`);
  }

  const insertIndex = parseInt(indexStr, 10);
  if (isNaN(insertIndex) || insertIndex < -1) {
    exit(`Invalid FEISHU_IMAGE_INDEX: '${indexStr}'. Must be -1 (append) or a non-negative integer.`);
  }

  return { insertIndex, absolutePath };
}

async function validateImageFile(absolutePath: string): Promise<void> {
  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch {
    exit(`Image file not found: ${absolutePath}`);
  }
  if (!stat.isFile()) exit(`Path is not a regular file: ${absolutePath}`);
  if (stat.size === 0) exit('Image file is empty (0 bytes)');
  if (stat.size > MAX_IMAGE_SIZE) {
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    exit(`Image too large: ${sizeMB}MB (max: ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`);
  }
}

// ---- Core Logic ----

/**
 * Append image to the end of the document.
 * Simple case — just call lark-cli docs +media-insert.
 */
async function appendImage(docId: string, imagePath: string): Promise<void> {
  console.log(`INFO: Appending image to document ${docId}`);

  const result = await mediaInsert(docId, imagePath);
  if (result.code !== 0) {
    exit(`Failed to insert image: ${result.msg || JSON.stringify(result)}`);
  }

  console.log(`OK: Image appended to document ${docId}`);
}

/**
 * Insert image at a specific position in the document.
 *
 * Steps:
 *  1. Get current children count (N)
 *  2. Upload & insert at end → image at index N
 *  3. Extract file_token from the inserted block
 *  4. Delete the block from end (index N) → back to N children
 *  5. Create empty image block at desired index (targetIndex)
 *  6. Bind file_token to the new block
 *
 * Cleanup: if steps 5 or 6 fail, the document is left in a valid state
 * (the uploaded file remains in Drive, just not bound to any block).
 */
async function insertImageAtPosition(
  docId: string,
  imagePath: string,
  targetIndex: number,
): Promise<void> {
  console.log(`INFO: Inserting image at index ${targetIndex} in document ${docId}`);

  // Step 1: Get current children count
  const listResult = await larkApi(
    'GET',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
  );
  if (listResult.code !== 0) {
    exit(`Failed to list document blocks: ${listResult.msg}`);
  }
  const totalChildren = (listResult.data?.items ?? []).length;

  if (targetIndex > totalChildren) {
    exit(`Index ${targetIndex} exceeds document length (${totalChildren} blocks). Use -1 to append.`);
  }

  // Step 2: Upload and insert at end via +media-insert
  const insertResult = await mediaInsert(docId, imagePath);
  if (insertResult.code !== 0) {
    exit(`Failed to upload image: ${insertResult.msg}`);
  }

  // Step 3: Extract block_id and file_token
  const insertedBlock = insertResult.data?.children?.[0];
  if (!insertedBlock?.block_id) {
    exit('Failed to get block_id from +media-insert response. lark-cli output format may differ.');
  }

  let fileToken: string | undefined = insertedBlock.image?.token;

  // Fallback: get file_token from block details if not in insert response
  if (!fileToken) {
    console.log('INFO: file_token not in insert response, fetching block details...');
    const blockDetail = await larkApi(
      'GET',
      `/open-apis/docx/v1/documents/${docId}/blocks/${insertedBlock.block_id}`,
    );
    fileToken = blockDetail.data?.block?.image?.token;
  }

  if (!fileToken) {
    // Cleanup: remove the block we just inserted
    await safeBatchDelete(docId, totalChildren, totalChildren + 1);
    exit('Failed to extract file_token from uploaded image block');
  }

  console.log(`INFO: File uploaded (token: ${fileToken.slice(0, 8)}...)`);

  // Step 4: Delete the image block from end (index = totalChildren)
  const deleteResult = await larkApi(
    'DELETE',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
    { start_index: totalChildren, end_index: totalChildren + 1 },
  );
  if (deleteResult.code !== 0) {
    // Non-fatal: the document has an extra image at the end, but we can still proceed
    console.error(`WARN: Failed to delete temporary block from end: ${deleteResult.msg}`);
    console.error('WARN: Document may have a duplicate image at the end.');
  }

  // Step 5: Create empty image block at desired position
  const createResult = await larkApi(
    'POST',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    { children: [{ block_type: 27 }], index: targetIndex },
  );
  if (createResult.code !== 0) {
    exit(`Failed to create image block at index ${targetIndex}: ${createResult.msg}`);
  }

  const newBlockId = createResult.data?.children?.[0]?.block_id;
  if (!newBlockId) {
    exit('Failed to get new block_id from create block response');
  }

  // Step 6: Bind file_token to new block
  const bindResult = await larkApi(
    'PATCH',
    `/open-apis/docx/v1/documents/${docId}/blocks/${newBlockId}`,
    { replace_image: { token: fileToken } },
  );
  if (bindResult.code !== 0) {
    // Cleanup: delete the empty block we just created
    await safeBatchDelete(docId, targetIndex, targetIndex + 1);
    exit(`Failed to bind image to block: ${bindResult.msg}`);
  }

  console.log(`OK: Image inserted at index ${targetIndex} in document ${docId}`);
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.FEISHU_DOC_ID ?? '';
  const imagePath = process.env.FEISHU_IMAGE_PATH ?? '';
  const indexStr = process.env.FEISHU_IMAGE_INDEX ?? '-1';
  const skipLark = process.env.FEISHU_SKIP_LARK === '1';

  // Validate inputs
  const { insertIndex, absolutePath } = validateInputs(docId, imagePath, indexStr);
  await validateImageFile(absolutePath);

  // Check lark-cli availability (skippable for testing)
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('lark-cli not found in PATH. Install: npm install -g @larksuite/cli && lark-cli auth login');
    }

    // Verify lark-cli is authenticated
    try {
      const { stdout } = await execFileAsync('lark-cli', ['auth', 'status', '--format', 'json'], {
        timeout: 10_000,
      });
      const authStatus = parseJsonOutput(stdout);
      if (authStatus.authenticated === false || authStatus.code !== 0) {
        exit('lark-cli is not authenticated. Run: lark-cli auth login --recommend');
      }
    } catch {
      // auth status command might not exist or return non-zero; skip check
    }
  }

  // Dry-run mode
  if (skipLark) {
    console.log(
      `OK: Would insert ${path.basename(absolutePath)} at index ${insertIndex} in doc ${docId} (dry-run)`,
    );
    return;
  }

  // Execute
  if (insertIndex === -1) {
    await appendImage(docId, absolutePath);
  } else {
    await insertImageAtPosition(docId, absolutePath, insertIndex);
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
