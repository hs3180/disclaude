#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 * — Insert an image into a Feishu document at a specific position.
 *
 * Uses lark-cli api for ALL API calls (including multipart upload via --file),
 * so authentication is handled entirely by lark-cli's built-in credentials.
 * No FEISHU_APP_ID / FEISHU_APP_SECRET required.
 *
 * 3-step process:
 *   1. Create empty image block (block_type: 27) at desired index
 *   2. Upload image file via Drive Media Upload API (multipart/form-data)
 *   3. Bind uploaded file to image block via replace_image
 *
 * Environment variables:
 *   DOC_ID           (required) Feishu document ID
 *   IMAGE_PATH       (required) Absolute path to image file (PNG/JPG/JPEG)
 *   INSERT_INDEX     (optional) 0-based position, -1 or omit to append (default: -1)
 *   UPLOAD_SKIP_LARK (optional) Set to '1' to skip lark-cli and API calls (dry-run)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Feishu document IDs are alphanumeric and may contain hyphens/underscores.
 * More lenient than the original `^[a-zA-Z0-9]+$` to cover actual doc ID formats.
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) {
    exit('DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOC_ID '${docId}' — must be alphanumeric (hyphens/underscores allowed)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('IMAGE_PATH environment variable is required');
  }
  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    exit(
      `Invalid IMAGE_PATH extension '${ext}' — must be one of: ${[...ALLOWED_EXTENSIONS].join(', ')}`
    );
  }
}

function validateIndex(indexStr: string): number {
  if (!indexStr) return -1; // default: append
  const index = parseInt(indexStr, 10);
  if (!Number.isFinite(index)) {
    exit(`Invalid INSERT_INDEX '${indexStr}' — must be an integer`);
  }
  if (index < -1) {
    exit(`Invalid INSERT_INDEX '${indexStr}' — must be >= -1 (-1 means append)`);
  }
  return index;
}

// ---- lark-cli API wrapper ----

interface LarkCliResponse {
  code: number;
  msg: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * Call lark-cli api with automatic auth.
 * Returns parsed JSON response.
 */
async function larkCliApi(
  method: string,
  path: string,
  options?: { data?: unknown; file?: string }
): Promise<LarkCliResponse> {
  const args = ['api', method, path];

  if (options?.data !== undefined) {
    args.push('-d', JSON.stringify(options.data));
  }
  if (options?.file) {
    args.push('--file', options.file);
  }

  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    // lark-cli may output non-JSON lines before the JSON response
    const lines = stdout.split('\n');
    let jsonStr = stdout.trim();

    // Find the last line that starts with '{' — that's likely the JSON response
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('{')) {
        jsonStr = lines.slice(i).join('\n').trim();
        break;
      }
    }

    return JSON.parse(jsonStr) as LarkCliResponse;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`lark-cli api ${method} ${path} failed: ${errorMsg}`);
  }
}

// ---- Step functions ----

/**
 * Step 1: Create an empty image block at the specified index.
 * Returns the block_id of the created image block.
 */
async function createImageBlock(docId: string, index: number): Promise<string> {
  const body: Record<string, unknown> = {
    children: [
      {
        block_type: 27, // Image block type
      },
    ],
  };

  // Only include index if >= 0 (not append)
  if (index >= 0) {
    body.index = index;
  }

  const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;
  const result = await larkCliApi('POST', endpoint, { data: body });

  if (result.code !== 0) {
    throw new Error(`Create block API error: code=${result.code}, msg=${result.msg}`);
  }

  const children = (result.data as { children?: Array<{ block_id: string }> })?.children;
  if (!children || children.length === 0 || !children[0].block_id) {
    throw new Error('Create block returned no block_id');
  }

  return children[0].block_id;
}

/**
 * Step 2: Upload image file via multipart/form-data using lark-cli api --file.
 * Returns the file_token of the uploaded file.
 */
async function uploadImage(docId: string, imagePath: string): Promise<string> {
  const endpoint = '/open-apis/drive/v1/medias/upload_all';
  const result = await larkCliApi('POST', endpoint, {
    data: {
      parent_type: 'docx_image',
      parent_node: docId,
    },
    file: `file=${imagePath}`,
  });

  if (result.code !== 0) {
    throw new Error(`Upload API error: code=${result.code}, msg=${result.msg}`);
  }

  const data = result.data as { file_token?: string };
  if (!data?.file_token) {
    throw new Error('Upload returned no file_token');
  }

  return data.file_token;
}

/**
 * Step 3: Bind the uploaded file to the image block via replace_image.
 */
async function replaceImageBlock(docId: string, blockId: string, fileToken: string): Promise<void> {
  const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`;
  const result = await larkCliApi('PATCH', endpoint, {
    data: {
      replace_image: {
        token: fileToken,
      },
    },
  });

  if (result.code !== 0) {
    throw new Error(`Replace image API error: code=${result.code}, msg=${result.msg}`);
  }
}

/**
 * Rollback: Delete the created empty block on failure to prevent document corruption.
 */
async function deleteBlock(docId: string, blockId: string): Promise<void> {
  try {
    const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`;
    await larkCliApi('DELETE', endpoint, {
      data: {
        start_index: -1,
        delete_block_ids: [blockId],
      },
    });
    console.log(`INFO: Rolled back — deleted empty block ${blockId}`);
  } catch (err: unknown) {
    console.error(
      `WARN: Failed to rollback block ${blockId}: ${err instanceof Error ? err.message : err}`
    );
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INSERT_INDEX ?? '';
  const skipApi = process.env.UPLOAD_SKIP_LARK === '1';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  const index = validateIndex(indexStr);

  // Resolve absolute path
  const absoluteImagePath = resolve(imagePath);

  // Check file exists and size
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
    exit(`Image too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max: 20 MB)`);
  }

  const fileName = basename(absoluteImagePath);
  const position = index === -1 ? 'end (append)' : `index ${index}`;
  console.log(
    `INFO: Inserting '${fileName}' (${(fileSize / 1024).toFixed(1)} KB) into doc ${docId} at ${position}`
  );

  // Dry-run mode
  if (skipApi) {
    console.log(`OK: Prepared (dry-run) doc=${docId} image=${fileName} index=${index}`);
    return;
  }

  // Check lark-cli availability
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
  } catch {
    exit('Missing required dependency: lark-cli not found in PATH');
  }

  // ---- Step 1: Create empty image block ----
  let blockId: string;
  try {
    blockId = await createImageBlock(docId, index);
    console.log(`INFO: Created image block ${blockId} at ${position}`);
  } catch (err: unknown) {
    exit(`Step 1 failed (create block): ${err instanceof Error ? err.message : err}`);
  }

  // ---- Step 2: Upload image file ----
  let fileToken: string;
  try {
    fileToken = await uploadImage(docId, absoluteImagePath);
    console.log(`INFO: Uploaded image, file_token: ${fileToken}`);
  } catch (err: unknown) {
    console.error(
      `ERROR: Step 2 failed (upload image): ${err instanceof Error ? err.message : err}`
    );
    await deleteBlock(docId, blockId);
    process.exit(1);
  }

  // ---- Step 3: Bind image to block ----
  try {
    await replaceImageBlock(docId, blockId, fileToken);
    console.log(`INFO: Bound image to block ${blockId}`);
  } catch (err: unknown) {
    console.error(`ERROR: Step 3 failed (bind image): ${err instanceof Error ? err.message : err}`);
    await deleteBlock(docId, blockId);
    process.exit(1);
  }

  console.log(`OK: Image inserted successfully`);
  console.log(`  block_id: ${blockId}`);
  console.log(`  file_token: ${fileToken}`);
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
