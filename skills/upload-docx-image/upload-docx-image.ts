#!/usr/bin/env tsx
/**
 * skills/upload-docx-image/upload-docx-image.ts
 * Insert an image into a Feishu document at a specified position via lark-cli.
 *
 * Uses lark-cli for ALL Feishu API calls — authentication is handled internally
 * by lark-cli, not through FEISHU_APP_ID/FEISHU_APP_SECRET environment variables.
 *
 * Approach:
 *   - Append mode (index = -1): Directly use `lark-cli docs +media-insert`
 *   - Positional mode (index >= 0):
 *     1. Upload image via `lark-cli docs +media-insert` (appended at end)
 *     2. Read document blocks to extract file_token from the uploaded image
 *     3. Create empty image block (block_type: 27) at target index
 *     4. Bind file_token to empty block via replace_image
 *     5. Delete the extra image block at end (cleanup)
 *
 * Environment variables:
 *   DOCX_DOC_ID       Feishu document ID
 *   DOCX_IMAGE_PATH   Local path to image file
 *   DOCX_IMAGE_INDEX  Insert position (0-based, -1 for append)
 *   DOCX_SKIP_LARK    Set to '1' to skip lark-cli check (testing only)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

/**
 * Regex for Feishu document IDs.
 * Feishu doc IDs may be:
 *   - `doxcnXXXXXX` (new format)
 *   - `docxXXXXXX` (prefix format)
 *   - Plain alphanumeric (legacy)
 * Also allows hyphens and underscores which appear in some ID formats.
 */
const DOC_ID_REGEX = /^doxcn[A-Za-z0-9_-]+$|^[A-Za-z0-9]{10,30}$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function warn(msg: string): void {
  console.error(`WARN: ${msg}`);
}

/**
 * Execute a lark-cli API call and return parsed JSON response.
 */
async function larkApi(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const args = ['api', method, path];
  if (body) {
    args.push('-d', JSON.stringify(body));
  }

  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // lark-cli api may output non-JSON on some responses
      return { raw: stdout };
    }
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string; stdout?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`lark-cli api ${method} ${path} failed: ${errorMsg}`);
  }
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) {
    exit('DOCX_DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(
      `Invalid DOCX_DOC_ID '${docId}' — must be a valid Feishu document ID (e.g. doxcnXXXXXX or alphanumeric 10-30 chars)`,
    );
  }
}

function validateImagePath(imagePath: string): string {
  if (!imagePath) {
    exit('DOCX_IMAGE_PATH environment variable is required');
  }

  const resolvedPath = resolve(imagePath);
  const ext = extname(resolvedPath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    exit(
      `Unsupported image format '${ext}' — supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    );
  }

  return resolvedPath;
}

function validateIndex(indexStr: string): number {
  if (indexStr === undefined || indexStr === '') {
    exit('DOCX_IMAGE_INDEX environment variable is required');
  }

  const index = parseInt(indexStr, 10);
  if (!Number.isFinite(index)) {
    exit(`Invalid DOCX_IMAGE_INDEX '${indexStr}' — must be an integer`);
  }
  if (index < -1) {
    exit(`Invalid DOCX_IMAGE_INDEX '${index}' — must be >= -1 (-1 for append)`);
  }

  return index;
}

async function validateImageFile(resolvedPath: string): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    exit(`Image file not found: ${resolvedPath}`);
  }

  if (!fileStat.isFile()) {
    exit(`Path is not a regular file: ${resolvedPath}`);
  }

  if (fileStat.size === 0) {
    exit(`Image file is empty: ${resolvedPath}`);
  }

  if (fileStat.size > MAX_IMAGE_SIZE) {
    const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);
    exit(`Image file too large: ${sizeMB} MB (max: 20 MB)`);
  }
}

// ---- Core Logic ----

/**
 * Check lark-cli availability and authentication.
 */
async function checkLarkCli(): Promise<void> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH. Install: npm i -g @larksuiteoapi/lark-cli');
  }
}

/**
 * Upload image to Feishu document using lark-cli docs +media-insert.
 * This appends the image at the end of the document.
 * Returns the raw stdout from the command for parsing.
 */
async function uploadImageAppend(
  docId: string,
  imagePath: string,
): Promise<{ stdout: string }> {
  const fileName = basename(imagePath);
  console.log(`INFO: Uploading image '${fileName}' to document ${docId} (append mode)`);

  try {
    const result = await execFileAsync(
      'lark-cli',
      ['docs', '+media-insert', '--doc', docId, '--file', imagePath],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return result;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`lark-cli docs +media-insert failed: ${errorMsg}`);
  }
}

/**
 * Get document block children list.
 * Returns the items array from the response.
 */
async function getDocumentBlocks(
  docId: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await larkApi(
    'GET',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children?page_size=500`,
  );

  const data = response.data as Record<string, unknown> | undefined;
  if (!data) {
    throw new Error('No data in document blocks response');
  }

  const items = data.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items)) {
    throw new Error('Invalid document blocks response: items is not an array');
  }

  return items;
}

/**
 * Extract file_token from an image block.
 */
function extractFileToken(block: Record<string, unknown>): string | null {
  const image = block.image as Record<string, unknown> | undefined;
  if (!image) return null;
  return (image.token as string) ?? null;
}

/**
 * Create an empty image block at a specified index.
 * Returns the block_id of the created block.
 */
async function createEmptyImageBlock(
  docId: string,
  index: number,
): Promise<string> {
  const response = await larkApi(
    'POST',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    {
      children: [{ block_type: 27 }],
      index,
    },
  );

  const data = response.data as Record<string, unknown> | undefined;
  if (!data) {
    throw new Error('No data in create block response');
  }

  const children = data.children as Array<Record<string, unknown>> | undefined;
  if (!children || children.length === 0) {
    throw new Error('No children in create block response');
  }

  const blockId = children[0].block_id as string;
  if (!blockId) {
    throw new Error('No block_id in created block');
  }

  return blockId;
}

/**
 * Bind an uploaded image file_token to an empty image block using replace_image.
 */
async function bindImageToBlock(
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  await larkApi(
    'PATCH',
    `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    {
      replace_image: { token: fileToken },
    },
  );
}

/**
 * Delete a block from the document by index using batch_delete.
 */
async function deleteBlockByIndex(
  docId: string,
  index: number,
): Promise<void> {
  await larkApi(
    'DELETE',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
    {
      start_index: index,
      end_index: index + 1,
    },
  );
}

/**
 * Delete a block from the document by block_id.
 * Falls back to finding the block index and using batch_delete.
 */
async function deleteBlockById(
  docId: string,
  blockId: string,
): Promise<void> {
  // Try batch_delete with block_ids if supported
  try {
    await larkApi(
      'DELETE',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
      {
        block_ids: [blockId],
      },
    );
    return;
  } catch {
    // Fallback: find index and delete by index
    warn('block_ids delete failed, falling back to index-based delete');
  }

  const blocks = await getDocumentBlocks(docId);
  const blockIndex = blocks.findIndex((b) => b.block_id === blockId);
  if (blockIndex === -1) {
    warn(`Block ${blockId} not found for deletion, skipping cleanup`);
    return;
  }

  await deleteBlockByIndex(docId, blockIndex);
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOCX_DOC_ID ?? '';
  const imagePath = process.env.DOCX_IMAGE_PATH ?? '';
  const indexStr = process.env.DOCX_IMAGE_INDEX ?? '';

  // Step 1: Validate inputs
  validateDocId(docId);
  const resolvedPath = validateImagePath(imagePath);
  await validateImageFile(resolvedPath);
  const index = validateIndex(indexStr);

  console.log(
    `INFO: Target: document=${docId}, image=${basename(resolvedPath)}, index=${index === -1 ? 'append' : index}`,
  );

  // Step 2: Check lark-cli availability (skippable for testing)
  if (process.env.DOCX_SKIP_LARK !== '1') {
    await checkLarkCli();
  }

  // Step 3: Skip actual API calls in dry-run mode
  if (process.env.DOCX_SKIP_LARK === '1') {
    console.log(
      `OK: Would upload '${basename(resolvedPath)}' to document ${docId} at index ${index === -1 ? 'end' : index} (dry-run)`,
    );
    return;
  }

  // ---- Append mode (simple path) ----
  if (index === -1) {
    await uploadImageAppend(docId, resolvedPath);
    console.log(`OK: Image appended to document ${docId}`);
    return;
  }

  // ---- Positional mode (complex path with block manipulation) ----

  // Step 4: Upload image at end
  let uploadedBlockId: string | null = null;
  try {
    await uploadImageAppend(docId, resolvedPath);
  } catch (err) {
    // Upload itself failed — nothing to clean up
    throw err;
  }

  // Step 5: Find the uploaded image block and extract file_token
  let fileToken: string | null = null;
  let cleanupNeeded = true;

  try {
    const blocks = await getDocumentBlocks(docId);
    // The uploaded image should be the last block
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) {
      throw new Error('No blocks found in document after upload');
    }

    uploadedBlockId = lastBlock.block_id as string;
    fileToken = extractFileToken(lastBlock);

    if (!fileToken) {
      throw new Error(`Could not extract file_token from uploaded block ${uploadedBlockId}`);
    }

    console.log(`INFO: Uploaded image file_token: ${fileToken}, block_id: ${uploadedBlockId}`);
  } catch (err) {
    // Failed to get file_token — try to clean up the uploaded block
    warn(`Failed to extract file_token: ${err instanceof Error ? err.message : err}`);
    warn('Image was uploaded but could not be repositioned. It remains at the end of the document.');
    console.log(
      `PARTIAL: Image uploaded to document ${docId} but could not be repositioned (at end)`,
    );
    return;
  }

  // Step 6: Create empty image block at target index
  let emptyBlockId: string | null = null;
  try {
    emptyBlockId = await createEmptyImageBlock(docId, index);
    console.log(`INFO: Created empty image block ${emptyBlockId} at index ${index}`);
  } catch (err) {
    // Failed to create empty block — the uploaded image is still at the end
    warn(`Failed to create empty block: ${err instanceof Error ? err.message : err}`);
    warn('Uploaded image remains at the end of the document.');
    console.log(
      `PARTIAL: Image uploaded to document ${docId} but could not be repositioned (at end)`,
    );
    return;
  }

  // Step 7: Bind file_token to empty block
  try {
    await bindImageToBlock(docId, emptyBlockId, fileToken);
    console.log(`INFO: Bound file_token to block ${emptyBlockId}`);
  } catch (err) {
    // Binding failed — clean up empty block
    warn(`Failed to bind image: ${err instanceof Error ? err.message : err}`);
    try {
      if (emptyBlockId) {
        await deleteBlockById(docId, emptyBlockId);
        console.log('INFO: Cleaned up empty block after bind failure');
      }
    } catch (cleanupErr) {
      warn(`Failed to clean up empty block: ${cleanupErr}`);
    }
    warn('Uploaded image remains at the end of the document.');
    console.log(
      `PARTIAL: Image uploaded to document ${docId} but could not be repositioned (at end)`,
    );
    return;
  }

  // Step 8: Delete the extra image block at the end (cleanup)
  try {
    if (uploadedBlockId) {
      // Re-fetch blocks to get the correct index (may have shifted after creating new block)
      const currentBlocks = await getDocumentBlocks(docId);
      const extraBlockIndex = currentBlocks.findIndex(
        (b) => b.block_id === uploadedBlockId,
      );
      if (extraBlockIndex !== -1) {
        await deleteBlockByIndex(docId, extraBlockIndex);
        console.log(`INFO: Deleted extra image block at index ${extraBlockIndex}`);
      } else {
        warn(`Could not find uploaded block ${uploadedBlockId} for cleanup`);
      }
    }
  } catch (err) {
    // Cleanup failure is non-critical — the extra block at the end is harmless
    warn(
      `Failed to delete extra image block: ${err instanceof Error ? err.message : err}. ` +
        'The image is correctly positioned, but an extra block remains at the end of the document.',
    );
  }

  console.log(
    `OK: Image '${basename(resolvedPath)}' inserted at index ${index} in document ${docId}`,
  );
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
