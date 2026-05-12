#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 *
 * Upload and insert an image into a Feishu document at a specific position.
 *
 * Uses lark-cli for authentication and API calls:
 *   1. Upload image → get file_token
 *   2. Create image block with file_token at desired index
 *
 * Environment variables:
 *   FEISHU_DOC_ID        Feishu document ID (required)
 *   FEISHU_DOC_IMAGE_PATH Local path to the image file (required)
 *   FEISHU_DOC_IMAGE_INDEX Position to insert at (optional, 0-based; omit to append)
 *   FEISHU_DOC_SKIP_LARK  Set to '1' to skip lark-cli calls (dry-run testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 60_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB (Feishu upload limit)
const BLOCK_TYPE_IMAGE = 27;

/**
 * Permissive regex for Feishu document IDs.
 * Allows alphanumeric, underscores, and hyphens.
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface LarkResponse {
  code: number;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Execute a lark-cli api command and parse the JSON response.
 */
async function larkApi(
  method: string,
  path: string,
  data?: string,
  file?: string,
): Promise<LarkResponse> {
  const args = ['api', method, path];
  if (data) {
    args.push('-d', data);
  }
  if (file) {
    args.push('--file', file);
  }

  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const resp = JSON.parse(stdout) as LarkResponse;
    return resp;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
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
    exit('FEISHU_DOC_ID environment variable is required');
  }
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid FEISHU_DOC_ID '${docId}' — must be alphanumeric (underscores and hyphens allowed)`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('FEISHU_DOC_IMAGE_PATH environment variable is required');
  }
  if (!existsSync(imagePath)) {
    exit(`Image file not found: ${imagePath}`);
  }
  const stats = statSync(imagePath);
  if (!stats.isFile()) {
    exit(`Path is not a file: ${imagePath}`);
  }
  if (stats.size > MAX_IMAGE_SIZE) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    exit(`Image file too large: ${sizeMB} MB (max 20 MB)`);
  }
  if (stats.size === 0) {
    exit('Image file is empty');
  }
}

function validateIndex(indexStr: string | undefined): number | undefined {
  if (indexStr === undefined || indexStr === '') {
    return undefined;
  }
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 0) {
    exit(`Invalid FEISHU_DOC_IMAGE_INDEX '${indexStr}' — must be a non-negative integer`);
  }
  return index;
}

// ---- Core logic ----

/**
 * Step 1: Upload image via lark-cli api.
 * Returns the file_token.
 */
async function uploadImage(imagePath: string): Promise<string> {
  console.log('INFO: Uploading image...');

  const resp = await larkApi(
    'POST',
    '/open-apis/drive/v1/medias/upload_all',
    '{"parent_type":"docx_image"}',
    `file=${imagePath}`,
  );

  if (resp.code !== 0) {
    throw new Error(`Upload failed (code ${resp.code}): ${resp.msg}`);
  }

  const fileToken = (resp.data as Record<string, unknown>)?.file_token as string | undefined;
  if (!fileToken) {
    throw new Error('Upload succeeded but no file_token returned');
  }

  console.log(`INFO: Image uploaded, file_token: ${fileToken}`);
  return fileToken;
}

/**
 * Step 2: Create image block in the document at the specified index.
 * Uses the file_token from the upload step.
 */
async function createImageBlock(
  docId: string,
  fileToken: string,
  index?: number,
): Promise<string> {
  console.log(`INFO: Creating image block in document ${docId}${index !== undefined ? ` at index ${index}` : ' (append)'}`);

  const body: Record<string, unknown> = {
    children: [
      {
        block_type: BLOCK_TYPE_IMAGE,
        image: {
          token: fileToken,
        },
      },
    ],
  };

  if (index !== undefined) {
    body.index = index;
  }

  const resp = await larkApi(
    'POST',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    JSON.stringify(body),
  );

  if (resp.code !== 0) {
    throw new Error(`Create block failed (code ${resp.code}): ${resp.msg}`);
  }

  const children = (resp.data as Record<string, unknown>)?.children as Array<Record<string, unknown>> | undefined;
  const blockId = children?.[0]?.block_id as string | undefined;
  if (!blockId) {
    throw new Error('Create block succeeded but no block_id returned');
  }

  console.log(`INFO: Image block created, block_id: ${blockId}`);
  return blockId;
}

/**
 * Cleanup: delete an empty image block from the document.
 * Used when block creation succeeds but something else fails later.
 */
async function deleteBlock(docId: string, blockId: string): Promise<void> {
  console.log(`INFO: Cleaning up block ${blockId}...`);
  try {
    await larkApi(
      'DELETE',
      `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    );
    console.log('INFO: Cleanup successful');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Cleanup failed for block ${blockId}: ${msg}`);
    console.error('WARN: You may need to manually delete the empty image block from the document');
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.FEISHU_DOC_ID ?? '';
  const imagePath = process.env.FEISHU_DOC_IMAGE_PATH ?? '';
  const indexStr = process.env.FEISHU_DOC_IMAGE_INDEX ?? process.env.FEISHU_DOC_INDEX ?? '';

  // Validate inputs
  validateDocId(docId);
  validateImagePath(imagePath);
  const index = validateIndex(indexStr || undefined);

  const imageSizeMB = (statSync(imagePath).size / (1024 * 1024)).toFixed(2);
  console.log(`INFO: Document: ${docId}`);
  console.log(`INFO: Image: ${imagePath} (${imageSizeMB} MB)`);
  if (index !== undefined) {
    console.log(`INFO: Insert at index: ${index}`);
  }

  // Check lark-cli availability
  if (process.env.FEISHU_DOC_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: lark-cli not found in PATH');
    }

    // Check lark-cli auth status
    try {
      const { stdout } = await execFileAsync('lark-cli', ['auth', 'status'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const authStatus = JSON.parse(stdout) as Record<string, unknown>;
      if (!authStatus.appId && !authStatus.identity) {
        exit('lark-cli is not authenticated. Run `lark-cli auth login` first.');
      }
    } catch {
      exit('lark-cli auth check failed. Ensure lark-cli is installed and authenticated.');
    }
  }

  // Dry-run mode
  if (process.env.FEISHU_DOC_SKIP_LARK === '1') {
    console.log('OK: Image insert completed (dry-run, no actual API calls)');
    return;
  }

  // Step 1: Upload image
  const fileToken = await uploadImage(imagePath);

  // Step 2: Create image block with the uploaded file_token
  let blockId: string;
  try {
    blockId = await createImageBlock(docId, fileToken, index);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Failed to create image block: ${msg}`);
    console.error('INFO: The uploaded image is orphaned but harmless');
    process.exit(1);
  }

  console.log(`OK: Image inserted into document ${docId}, block_id: ${blockId}`);
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
