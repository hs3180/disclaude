#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 * 上传飞书文档图片 — Insert an image into a Feishu document at a specific position.
 *
 * Uses lark-cli for ALL authentication and API calls:
 *   1. `lark-cli docs +media-insert` to upload the image (appends to end)
 *   2. `lark-cli api GET` to retrieve file_token from the uploaded block
 *   3. `lark-cli api POST` to create an empty image block at the desired position
 *   4. `lark-cli api PATCH` to bind the file_token to the empty block
 *   5. `lark-cli api DELETE` to remove the temporary block at the end
 *
 * Environment variables:
 *   DOC_ID                (required) Feishu document ID
 *   IMAGE_PATH            (required) Absolute path to image file (PNG/JPG/JPEG)
 *   INSERT_INDEX          (required) 0-based position (-1 to append to end)
 *   UPLOAD_SKIP_LARK      (optional) Set to '1' for dry-run (validate only)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Feishu document IDs are typically alphanumeric, but may also contain
 * underscores and hyphens. Relaxed from the original strict `^[a-zA-Z0-9]+$`.
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Validation helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function validateDocId(docId: string): void {
  if (!docId) {
    exit('DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must be alphanumeric (may include _ and -)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('IMAGE_PATH environment variable is required');
  }
  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    exit(
      `Invalid IMAGE_PATH extension '${ext}' — must be one of: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    );
  }
}

function validateIndex(indexStr: string): number {
  if (!indexStr && indexStr !== '0') {
    exit('INSERT_INDEX environment variable is required');
  }
  const index = parseInt(indexStr, 10);
  if (!Number.isFinite(index)) {
    exit(`Invalid INSERT_INDEX '${indexStr}' — must be an integer`);
  }
  if (index < -1) {
    exit(`Invalid INSERT_INDEX '${indexStr}' — must be >= -1 (-1 means append)`);
  }
  return index;
}

// ---- lark-cli helpers ----

/**
 * Execute a lark-cli api command and return parsed JSON response.
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
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`lark-cli api ${method} ${path} failed: ${errorMsg}`);
  }
}

/**
 * Get all top-level blocks in a document.
 * Uses `lark-cli api GET /open-apis/docx/v1/documents/{docId}/blocks`.
 */
async function getDocumentBlocks(
  docId: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await larkApi(
    'GET',
    `/open-apis/docx/v1/documents/${docId}/blocks`,
  );

  const code = response.code as number;
  if (code !== 0) {
    throw new Error(`Get blocks API error: code=${code}, msg=${response.msg}`);
  }

  const data = response.data as Record<string, unknown> | undefined;
  const items = (data?.items ?? []) as Array<Record<string, unknown>>;
  return items;
}

/**
 * Step 1: Create an empty image block (block_type: 27) at the specified index.
 * Returns the block_id of the newly created block.
 */
async function createEmptyImageBlock(
  docId: string,
  index: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    children: [
      {
        block_type: 27, // Image block type (NOT 4, which is Heading2)
      },
    ],
  };

  // Only include index if not -1 (append)
  if (index >= 0) {
    body.index = index;
  }

  const response = await larkApi(
    'POST',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    body,
  );

  const code = response.code as number;
  if (code !== 0) {
    throw new Error(`Create block API error: code=${code}, msg=${response.msg}`);
  }

  const data = response.data as Record<string, unknown> | undefined;
  const children = (data?.children ?? []) as Array<Record<string, unknown>>;
  if (children.length === 0 || !children[0].block_id) {
    throw new Error('Create block returned no block_id');
  }

  return children[0].block_id as string;
}

/**
 * Bind an uploaded file_token to an image block using replace_image.
 */
async function bindImageToBlock(
  docId: string,
  blockId: string,
  fileToken: string,
): Promise<void> {
  const response = await larkApi(
    'PATCH',
    `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    {
      replace_image: {
        token: fileToken,
      },
    },
  );

  const code = response.code as number;
  if (code !== 0) {
    throw new Error(`Replace image API error: code=${code}, msg=${response.msg}`);
  }
}

/**
 * Delete blocks at the specified index range.
 * Uses `lark-cli api DELETE .../blocks/{docId}/children` with start_index/end_index.
 */
async function deleteBlockRange(
  docId: string,
  startIndex: number,
  endIndex: number,
): Promise<void> {
  const response = await larkApi(
    'DELETE',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    { start_index: startIndex, end_index: endIndex },
  );

  const code = response.code as number;
  if (code !== 0) {
    throw new Error(`Delete block API error: code=${code}, msg=${response.msg}`);
  }
}

/**
 * Upload an image to the document end using `lark-cli docs +media-insert`.
 * This creates a complete image block (with file_token bound) at the end.
 * Returns the file_token extracted from the newly created block.
 */
async function uploadImageViaMediaInsert(
  docId: string,
  imagePath: string,
  existingBlockCount: number,
): Promise<{ fileToken: string; insertedBlockIndex: number }> {
  // Upload via lark-cli docs +media-insert (appends to end)
  try {
    await execFileAsync(
      'lark-cli',
      ['docs', '+media-insert', '--doc-id', docId, '--image', imagePath],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`lark-cli docs +media-insert failed: ${errorMsg}`);
  }

  // Get the updated block list to find the file_token
  const blocks = await getDocumentBlocks(docId);

  // The new block should be at the end (index = existingBlockCount)
  const insertedIndex = existingBlockCount;
  if (insertedIndex >= blocks.length) {
    throw new Error(
      `After +media-insert, expected at least ${insertedIndex + 1} blocks but found ${blocks.length}`,
    );
  }

  const newBlock = blocks[insertedIndex];
  const blockType = newBlock.block_type as number;

  if (blockType !== 27) {
    throw new Error(
      `Expected image block (type 27) at index ${insertedIndex}, got type ${blockType}`,
    );
  }

  const imageProp = newBlock.image as Record<string, unknown> | undefined;
  if (!imageProp?.token) {
    throw new Error(`Image block at index ${insertedIndex} has no file token`);
  }

  return {
    fileToken: imageProp.token as string,
    insertedBlockIndex: insertedIndex,
  };
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX ?? '';
  const skipLark = process.env.UPLOAD_SKIP_LARK === '1';

  // ---- Validate inputs ----
  validateDocId(docId);
  validateImagePath(imagePath);
  const insertIndex = validateIndex(indexStr);

  // Resolve absolute path and check file
  const absoluteImagePath = resolve(imagePath);
  let fileSize: number;
  try {
    const fileStat = await stat(absoluteImagePath);
    fileSize = fileStat.size;
  } catch {
    exit(`Image file not found: ${absoluteImagePath}`);
  }
  if (fileSize === 0) {
    exit('Image file is empty');
  }
  if (fileSize > MAX_IMAGE_SIZE) {
    exit(`Image file too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max: 20 MB)`);
  }

  const fileName = basename(absoluteImagePath);
  const position = insertIndex === -1 ? 'end (append)' : `index ${insertIndex}`;
  console.log(
    `INFO: Inserting image '${fileName}' (${(fileSize / 1024).toFixed(1)} KB) into doc ${docId} at ${position}`,
  );

  // ---- Dry-run mode ----
  if (skipLark) {
    console.log(`OK: Image insertion prepared (dry-run — skipped API calls)`);
    console.log(`  doc_id: ${docId}`);
    console.log(`  image: ${fileName}`);
    console.log(`  index: ${insertIndex}`);
    return;
  }

  // ---- Check lark-cli availability ----
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit(
      'Missing required dependency: lark-cli not found in PATH. Please install lark-cli and authenticate first.',
    );
  }

  // ---- Get current block count (before any modifications) ----
  let blockCountBefore: number;
  try {
    const blocks = await getDocumentBlocks(docId);
    blockCountBefore = blocks.length;
    console.log(`INFO: Document has ${blockCountBefore} blocks before insertion`);
  } catch (err: unknown) {
    exit(`Failed to get document blocks: ${err instanceof Error ? err.message : err}`);
  }

  // ---- Handle append case (-1 index) ----
  if (insertIndex === -1) {
    // Simple case: just use +media-insert directly (it appends to end)
    try {
      await uploadImageViaMediaInsert(docId, absoluteImagePath, blockCountBefore);
      console.log(`OK: Image appended to end of document`);
      return;
    } catch (err: unknown) {
      exit(`Failed to append image: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---- Positional insert (index >= 0) ----
  // Strategy:
  //   1. Upload image via +media-insert (creates block at end with file_token)
  //   2. Extract file_token from the new block
  //   3. Create empty block at desired position
  //   4. Bind file_token to the empty block
  //   5. Delete the temporary block at the end (cleanup)

  let fileToken: string;
  let mediaInsertBlockIndex: number;
  try {
    const result = await uploadImageViaMediaInsert(
      docId,
      absoluteImagePath,
      blockCountBefore,
    );
    fileToken = result.fileToken;
    mediaInsertBlockIndex = result.insertedBlockIndex;
    console.log(`INFO: Uploaded image via +media-insert, file_token: ${fileToken}`);
  } catch (err: unknown) {
    exit(`Step 1 failed (upload via +media-insert): ${err instanceof Error ? err.message : err}`);
  }

  let emptyBlockId: string;
  try {
    emptyBlockId = await createEmptyImageBlock(docId, insertIndex);
    console.log(`INFO: Created empty image block ${emptyBlockId} at ${position}`);
  } catch (err: unknown) {
    // Cleanup: try to delete the +media-insert block
    console.error(
      `WARN: Step 2 failed (create block): ${err instanceof Error ? err.message : err}`,
    );
    console.error('WARN: Attempting to clean up +media-insert block...');
    try {
      await deleteBlockRange(docId, mediaInsertBlockIndex, mediaInsertBlockIndex + 1);
      console.log('INFO: Cleanup successful — removed temporary image block');
    } catch {
      console.error('ERROR: Cleanup failed — document may have an extra image block at the end');
    }
    process.exit(1);
  }

  try {
    await bindImageToBlock(docId, emptyBlockId, fileToken);
    console.log(`INFO: Bound image to block ${emptyBlockId}`);
  } catch (err: unknown) {
    // Cleanup: try to delete the empty block AND the +media-insert block
    console.error(
      `WARN: Step 3 failed (bind image): ${err instanceof Error ? err.message : err}`,
    );
    console.error('WARN: Attempting to clean up...');
    // The empty block was inserted at insertIndex, shifting the +media-insert block
    const cleanupMediaIndex = mediaInsertBlockIndex + 1;
    try {
      await deleteBlockRange(docId, insertIndex, insertIndex + 1);
      console.log('INFO: Removed empty block');
    } catch {
      console.error('ERROR: Failed to remove empty block');
    }
    try {
      await deleteBlockRange(docId, cleanupMediaIndex, cleanupMediaIndex + 1);
      console.log('INFO: Removed +media-insert block');
    } catch {
      console.error('ERROR: Failed to remove +media-insert block');
    }
    process.exit(1);
  }

  // Step 4: Delete the temporary +media-insert block (now at mediaInsertBlockIndex + 1
  // because creating the empty block shifted it by 1)
  const cleanupIndex = mediaInsertBlockIndex + 1;
  try {
    await deleteBlockRange(docId, cleanupIndex, cleanupIndex + 1);
    console.log('INFO: Cleaned up temporary image block');
  } catch (err: unknown) {
    // Non-fatal: the image is correctly placed, but there's an extra block at the end
    console.error(
      `WARN: Failed to clean up temporary block (image is correctly placed): ${err instanceof Error ? err.message : err}`,
    );
  }

  console.log(`OK: Image inserted successfully at ${position}`);
  console.log(`  block_id: ${emptyBlockId}`);
  console.log(`  file_token: ${fileToken}`);
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
