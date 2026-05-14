#!/usr/bin/env tsx
/**
 * skills/upload-doc-image/upload-doc-image.ts
 * Insert an image into a Feishu document at a specific position via lark-cli.
 *
 * Uses lark-cli's built-in auth for all API operations.
 * For position insertion: uploads via +media-insert (append), then rearranges blocks.
 *
 * Environment variables:
 *   DOC_ID                      Feishu document ID
 *   IMAGE_PATH                  Absolute path to the image file (PNG/JPG/JPEG)
 *   INSERT_INDEX                0-based position (-1 to append to end)
 *   UPLOAD_DOC_IMAGE_SKIP_LARK  Set to '1' for dry-run (testing only)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, extname, basename } from 'node:path';
import { stat } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const VALID_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Run a lark-cli command and return stdout. */
async function larkCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/** Run a lark-cli api command and parse JSON response. */
async function larkApi(method: string, path: string, body?: unknown): Promise<any> {
  const args = ['api', method, path];
  if (body !== undefined) {
    args.push('-d', JSON.stringify(body));
  }
  const stdout = await larkCli(args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`lark-cli api returned non-JSON: ${stdout.substring(0, 200)}`);
  }
}

/** Extract error message from lark-cli API response. */
function apiErrorMsg(data: any): string {
  if (data?.msg) return `code=${data.code} ${data.msg}`;
  return JSON.stringify(data).substring(0, 200);
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) exit('DOC_ID environment variable is required');
  // Feishu document IDs are alphanumeric, may contain underscores/hyphens
  if (!/^[\w-]+$/.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must be alphanumeric (underscores/hyphens allowed)`);
  }
}

function validateImagePath(imagePath: string): string {
  if (!imagePath) exit('IMAGE_PATH environment variable is required');
  const resolved = resolve(imagePath);
  const ext = extname(resolved).toLowerCase();
  if (!VALID_EXTENSIONS.has(ext)) {
    exit(`Invalid IMAGE_PATH extension '${ext}' — supported: ${[...VALID_EXTENSIONS].join(', ')}`);
  }
  return resolved;
}

function validateIndex(raw: string): number {
  if (raw === undefined || raw === '') exit('INSERT_INDEX environment variable is required');
  const n = Number(raw);
  if (!Number.isInteger(n)) exit(`Invalid INSERT_INDEX '${raw}' — must be an integer`);
  if (n < -1) exit(`Invalid INSERT_INDEX '${n}' — must be >= -1`);
  return n;
}

async function validateImageFile(resolvedPath: string): Promise<void> {
  let fileInfo;
  try {
    fileInfo = await stat(resolvedPath);
  } catch {
    exit(`Image file not found: ${resolvedPath}`);
  }
  if (!fileInfo.isFile()) exit(`Not a file: ${resolvedPath}`);
  if (fileInfo.size > MAX_IMAGE_SIZE) {
    exit(`Image file too large: ${fileInfo.size} bytes (max ${MAX_IMAGE_SIZE})`);
  }
  if (fileInfo.size === 0) exit('Image file is empty (0 bytes)');
}

// ---- Core logic ----

/**
 * Step A: Upload image by appending to end via lark-cli docs +media-insert.
 * Returns the block_id of the inserted image block.
 */
async function appendImage(docId: string, imagePath: string): Promise<string> {
  console.log(`INFO: Uploading image via lark-cli docs +media-insert (append to end)`);
  try {
    const stdout = await larkCli([
      'docs', '+media-insert',
      '--doc', docId,
      '--file', imagePath,
    ]);
    // Parse response to get block_id
    // lark-cli docs +media-insert returns JSON with the created block info
    let data: any;
    try {
      data = JSON.parse(stdout);
    } catch {
      // If not JSON, the command might have succeeded with text output
      // Try to extract block_id from the output
      console.log(`INFO: +media-insert output: ${stdout.substring(0, 300)}`);
      throw new Error('Could not parse +media-insert response');
    }

    // Extract block_id from response
    const blockId =
      data?.data?.block_id ??
      data?.data?.children?.[0]?.block_id ??
      data?.block_id;

    if (!blockId) {
      // Check for API error
      if (data?.code !== undefined && data.code !== 0) {
        throw new Error(`+media-insert API error: ${apiErrorMsg(data)}`);
      }
      throw new Error(`Could not extract block_id from +media-insert response: ${JSON.stringify(data).substring(0, 300)}`);
    }

    console.log(`INFO: Image appended, block_id=${blockId}`);
    return blockId;
  } catch (err: any) {
    // Check if lark-cli command itself failed
    if (err.stderr || err.code) {
      const errMsg = (err.stderr ?? err.message ?? 'unknown error').replace(/\n/g, ' ').trim();
      throw new Error(`lark-cli docs +media-insert failed: ${errMsg}`);
    }
    throw err;
  }
}

/**
 * Read an image block to extract the file_token.
 */
async function getImageFileToken(docId: string, blockId: string): Promise<string> {
  console.log(`INFO: Reading block ${blockId} to extract file_token`);
  const data = await larkApi('GET', `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`);

  if (data?.code !== undefined && data.code !== 0) {
    throw new Error(`Get block API error: ${apiErrorMsg(data)}`);
  }

  // Navigate the response structure to find the image token
  const block = data?.data?.block ?? data?.data;
  const fileToken =
    block?.image?.token ??
    block?.text?.elements?.find((e: any) => e?.image?.token)?.image?.token;

  if (!fileToken) {
    throw new Error(`Could not extract file_token from block: ${JSON.stringify(block).substring(0, 300)}`);
  }

  console.log(`INFO: Extracted file_token=${fileToken}`);
  return fileToken;
}

/**
 * Delete a block from the document.
 */
async function deleteBlock(docId: string, blockId: string): Promise<void> {
  console.log(`INFO: Deleting block ${blockId}`);
  const data = await larkApi(
    'DELETE',
    `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}/batch_delete`,
    { start_index: -1, end_index: -1 },
  );

  // Try batch_delete first; if it fails, try the simpler delete endpoint
  if (data?.code !== undefined && data.code !== 0) {
    // Fallback: try the blocks children delete endpoint
    console.log(`INFO: batch_delete failed (${data.msg}), trying DELETE children endpoint`);
    const data2 = await larkApi(
      'DELETE',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
      { start_index: -1, end_index: -1, block_ids: [blockId] },
    );
    if (data2?.code !== undefined && data2.code !== 0) {
      throw new Error(`Delete block API error: ${apiErrorMsg(data2)}`);
    }
  }

  console.log(`INFO: Block ${blockId} deleted`);
}

/**
 * Create an empty image block at the specified index.
 * Returns the new block_id.
 */
async function createImageBlock(docId: string, index: number): Promise<string> {
  console.log(`INFO: Creating empty image block at index ${index}`);
  const body: any = {
    children: [{ block_type: 27 }],
  };
  if (index >= 0) {
    body.index = index;
  }

  const data = await larkApi(
    'POST',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    body,
  );

  if (data?.code !== undefined && data.code !== 0) {
    throw new Error(`Create block API error: ${apiErrorMsg(data)}`);
  }

  const blockId =
    data?.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error(`No block_id in create response: ${JSON.stringify(data).substring(0, 300)}`);
  }

  console.log(`INFO: Created empty image block ${blockId} at index ${index}`);
  return blockId;
}

/**
 * Bind a file_token to an image block using replace_image.
 */
async function bindImage(docId: string, blockId: string, fileToken: string): Promise<void> {
  console.log(`INFO: Binding file_token=${fileToken} to block ${blockId}`);
  const data = await larkApi(
    'PATCH',
    `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    { replace_image: { token: fileToken } },
  );

  if (data?.code !== undefined && data.code !== 0) {
    throw new Error(`Bind image API error: ${apiErrorMsg(data)}`);
  }

  console.log(`INFO: Image bound to block ${blockId}`);
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const rawIndex = process.env.INSERT_INDEX ?? '';
  const skipLark = process.env.UPLOAD_DOC_IMAGE_SKIP_LARK === '1';

  // 1. Validate inputs
  validateDocId(docId);
  const resolvedPath = validateImagePath(imagePath);
  const index = validateIndex(rawIndex);
  await validateImageFile(resolvedPath);

  console.log(`INFO: DOC_ID=${docId}, IMAGE=${basename(resolvedPath)}, INDEX=${index}`);

  // 2. Check lark-cli availability
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH. Please install lark-cli first.');
    }

    // Verify lark-cli is authenticated
    try {
      const authStatus = await larkCli(['auth', 'status', '--format', 'json']);
      // If we get here, lark-cli is authenticated
    } catch {
      exit('lark-cli is not authenticated. Please run `lark-cli auth login` first.');
    }
  }

  // Dry-run mode
  if (skipLark) {
    console.log(`OK: Inputs validated (dry-run) — DOC_ID=${docId}, IMAGE=${basename(resolvedPath)}, INDEX=${index}`);
    return;
  }

  // 3. Append mode (index == -1)
  if (index === -1) {
    const blockId = await appendImage(docId, resolvedPath);
    console.log(`OK: Image appended to document ${docId}, block_id=${blockId}`);
    return;
  }

  // 4. Position mode (index >= 0)
  // Upload by appending first, then rearrange
  let appendedBlockId: string | undefined;
  let newBlockId: string | undefined;

  try {
    // Step 4a: Upload and append
    appendedBlockId = await appendImage(docId, resolvedPath);

    // Step 4b: Extract file_token from the appended block
    const fileToken = await getImageFileToken(docId, appendedBlockId);

    // Step 4c: Delete the appended block
    await deleteBlock(docId, appendedBlockId);
    appendedBlockId = undefined; // Successfully deleted, no need to clean up

    // Step 4d: Create empty image block at desired position
    newBlockId = await createImageBlock(docId, index);

    // Step 4e: Bind file_token to new block
    await bindImage(docId, newBlockId, fileToken);

    console.log(`OK: Image inserted at index ${index} in document ${docId}, block_id=${newBlockId}`);
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Rollback: clean up any orphaned blocks
    if (newBlockId) {
      console.error(`WARN: Attempting to clean up orphaned block ${newBlockId}`);
      try {
        await deleteBlock(docId, newBlockId);
      } catch {
        console.error(`WARN: Failed to clean up block ${newBlockId}`);
      }
    }
    // Note: appendedBlockId is already deleted in the happy path.
    // If it exists here, it means deletion failed — the block at the end is still there.
    // We leave it as-is because it's a valid image block (just at the wrong position).

    console.error(`ERROR: ${errMsg}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
