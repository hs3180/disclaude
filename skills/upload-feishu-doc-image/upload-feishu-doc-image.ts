#!/usr/bin/env tsx
/**
 * skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
 *
 * Upload and insert an image into a Feishu document at a specific position.
 *
 * Uses lark-cli for all Feishu API calls (authentication handled by lark-cli).
 * Three-step process:
 *   1. Create empty image block (block_type 27) at target position
 *   2. Upload image file via Drive Media Upload API
 *   3. Bind uploaded file to image block via replace_image
 *
 * Environment variables:
 *   DOC_ID            Feishu document ID
 *   IMAGE_PATH        Absolute path to the image file
 *   INDEX             Insert position (0-based, -1 = append, default: -1)
 *   UPLOAD_SKIP_LARK  Set to '1' for dry-run testing
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

const LARK_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB Feishu API limit

/** Supported image extensions (lowercase) */
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

/**
 * Regex for Feishu document IDs.
 * Real document IDs can contain alphanumeric, underscores, and hyphens.
 * Examples: "doccnXXXXXX", "doxcnXXXXXX", etc.
 */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

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
    exit(`Invalid DOC_ID '${docId}' — must contain only alphanumeric, underscore, or hyphen characters`);
  }
}

function validateImagePath(imagePath: string): { resolvedPath: string; fileName: string } {
  if (!imagePath) {
    exit('IMAGE_PATH environment variable is required');
  }

  if (!existsSync(imagePath)) {
    exit(`Image file not found: ${imagePath}`);
  }

  const fileStat = statSync(imagePath);
  if (!fileStat.isFile()) {
    exit(`IMAGE_PATH is not a regular file: ${imagePath}`);
  }

  if (fileStat.size === 0) {
    exit(`Image file is empty: ${imagePath}`);
  }

  if (fileStat.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1);
    exit(`Image file too large: ${sizeMB}MB (max 20MB)`);
  }

  const ext = extname(imagePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    exit(
      `Unsupported image format '${ext}'. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    );
  }

  // Sanitize filename for multipart header (remove quotes, newlines)
  const rawName = basename(imagePath);
  const fileName = rawName.replace(/["\r\n]/g, '_');

  return { resolvedPath: imagePath, fileName };
}

function validateIndex(indexStr: string | undefined): number {
  if (indexStr === undefined || indexStr === '') {
    return -1; // append
  }

  const index = Number(indexStr);
  if (!Number.isInteger(index)) {
    exit(`Invalid INDEX '${indexStr}' — must be an integer`);
  }
  if (index < -1) {
    exit(`Invalid INDEX '${index}' — must be >= -1 (-1 means append)`);
  }

  return index;
}

// ---- lark-cli helpers ----

interface LarkResponse {
  code: number;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Parse lark-cli JSON output.
 * lark-cli wraps API responses; the actual data is in the `data` field.
 */
function parseLarkResponse(stdout: string): LarkResponse {
  try {
    return JSON.parse(stdout) as LarkResponse;
  } catch {
    // lark-cli might output non-JSON on error
    throw new Error(`Failed to parse lark-cli output: ${stdout.slice(0, 200)}`);
  }
}

/**
 * Execute a lark-cli raw API call and return parsed JSON response.
 */
async function larkApiCall(
  method: string,
  endpoint: string,
  data?: Record<string, unknown>,
): Promise<LarkResponse> {
  const args = ['api', method, endpoint, '--format', 'json'];
  if (data) {
    args.push('--data', JSON.stringify(data));
  }

  try {
    const { stdout } = await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseLarkResponse(stdout);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const output = (execErr.stdout || execErr.stderr || execErr.message || 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(`lark-cli api ${method} ${endpoint} failed: ${output}`);
  }
}

/**
 * Upload an image file via lark-cli Drive Media API.
 * Tries API command first, then falls back to raw API.
 */
async function uploadImage(
  docId: string,
  imagePath: string,
): Promise<{ fileToken: string }> {
  // Strategy 1: Try lark-cli drive API command
  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      [
        'drive',
        'medias',
        'upload_all',
        '--params',
        JSON.stringify({ parent_type: 'docx_image', parent_node: docId }),
        '--file',
        imagePath,
        '--format',
        'json',
      ],
      { timeout: UPLOAD_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );

    const resp = parseLarkResponse(stdout);
    if (resp.code !== 0) {
      throw new Error(`Upload API error: code=${resp.code}, msg=${resp.msg}`);
    }

    const fileToken = (resp.data as Record<string, unknown>)?.file_token as string;
    if (!fileToken) {
      throw new Error('Upload succeeded but no file_token in response');
    }
    return { fileToken };
  } catch (primaryErr: unknown) {
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.error(`WARN: drive medias upload_all failed: ${primaryMsg}`);
    console.error('INFO: Falling back to raw API upload...');

    // Strategy 2: Try lark-cli raw API with form upload
    try {
      const { stdout } = await execFileAsync(
        'lark-cli',
        [
          'api',
          'POST',
          `/open-apis/drive/v1/medias/upload_all`,
          '--params',
          JSON.stringify({ parent_type: 'docx_image', parent_node: docId }),
          '--file',
          imagePath,
          '--format',
          'json',
        ],
        { timeout: UPLOAD_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );

      const resp = parseLarkResponse(stdout);
      if (resp.code !== 0) {
        throw new Error(`Raw API upload error: code=${resp.code}, msg=${resp.msg}`);
      }

      const fileToken = (resp.data as Record<string, unknown>)?.file_token as string;
      if (!fileToken) {
        throw new Error('Raw API upload succeeded but no file_token in response');
      }
      return { fileToken };
    } catch (fallbackErr: unknown) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `Image upload failed (both strategies):\n  Primary: ${primaryMsg}\n  Fallback: ${fallbackMsg}`,
      );
    }
  }
}

// ---- Core three-step process ----

/**
 * Step 1: Create an empty image block at the target position.
 * Returns the block_id of the newly created image block.
 */
async function createEmptyImageBlock(
  docId: string,
  index: number,
): Promise<string> {
  const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`;
  const body: Record<string, unknown> = {
    children: [{ block_type: 27, image: {} }],
  };

  // Only include index if not appending
  if (index >= 0) {
    body.index = index;
  }

  const resp = await larkApiCall('POST', endpoint, body);

  if (resp.code !== 0) {
    throw new Error(`Create image block failed: code=${resp.code}, msg=${resp.msg}`);
  }

  const data = resp.data as Record<string, unknown> | undefined;
  const children = data?.children as Array<Record<string, unknown>> | undefined;
  const blockId = children?.[0]?.block_id as string | undefined;

  if (!blockId) {
    throw new Error('Create image block succeeded but no block_id in response');
  }

  return blockId;
}

/**
 * Step 3: Bind the uploaded file to the image block via replace_image.
 */
async function bindImageToBlock(
  docId: string,
  imageBlockId: string,
  fileToken: string,
): Promise<void> {
  const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${imageBlockId}`;
  const body = {
    replace_image: {
      token: fileToken,
    },
  };

  const resp = await larkApiCall('PATCH', endpoint, body);

  if (resp.code !== 0) {
    throw new Error(`Bind image failed: code=${resp.code}, msg=${resp.msg}`);
  }
}

/**
 * Rollback: Delete an empty image block if subsequent steps fail.
 */
async function deleteEmptyBlock(docId: string, blockId: string): Promise<void> {
  try {
    const endpoint = `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`;
    await larkApiCall('DELETE', endpoint);
    console.log(`INFO: Rollback — deleted empty block ${blockId}`);
  } catch (rollbackErr: unknown) {
    const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    console.error(`WARN: Rollback failed for block ${blockId}: ${msg}`);
    console.error('WARN: Document may contain an empty image block that needs manual cleanup.');
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_ID ?? '';
  const imagePath = process.env.IMAGE_PATH ?? '';
  const indexStr = process.env.INDEX ?? process.env.UPLOAD_INDEX; // support both names
  const skipLark = process.env.UPLOAD_SKIP_LARK === '1';

  // Validate inputs
  validateDocId(docId);
  const { resolvedPath, fileName } = validateImagePath(imagePath);
  const index = validateIndex(indexStr);

  console.log(`INFO: Inserting image '${fileName}' into document ${docId} at index ${index}`);

  // Check lark-cli availability
  if (!skipLark) {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
    } catch {
      exit(
        'Missing required dependency: lark-cli not found in PATH.\n' +
          'Install: npm install -g @larksuite/cli\n' +
          'Configure: lark-cli config init && lark-cli auth login --recommend',
      );
    }
  }

  // Dry-run mode
  if (skipLark) {
    console.log(`OK: Image '${fileName}' would be inserted at index ${index} (dry-run)`);
    return;
  }

  // Step 1: Create empty image block
  let imageBlockId: string;
  try {
    imageBlockId = await createEmptyImageBlock(docId, index);
    console.log(`INFO: Created empty image block ${imageBlockId} at index ${index}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    exit(`Step 1 (create block) failed: ${msg}`);
  }

  // Step 2: Upload image file
  let fileToken: string;
  try {
    const result = await uploadImage(docId, resolvedPath);
    fileToken = result.fileToken;
    console.log(`INFO: Uploaded image, file_token=${fileToken}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Step 2 (upload) failed: ${msg}`);
    // Rollback: delete the empty block
    await deleteEmptyBlock(docId, imageBlockId);
    exit(`Image upload failed, empty block rolled back. Original error: ${msg}`);
  }

  // Step 3: Bind image to block
  try {
    await bindImageToBlock(docId, imageBlockId, fileToken);
    console.log(`INFO: Bound image (token=${fileToken}) to block ${imageBlockId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Step 3 (bind) failed: ${msg}`);
    // Rollback: delete the empty block (uploaded file is orphaned but harmless)
    await deleteEmptyBlock(docId, imageBlockId);
    exit(`Image bind failed, empty block rolled back. Original error: ${msg}`);
  }

  console.log(
    `OK: Image inserted successfully — block_id=${imageBlockId}, file_token=${fileToken}`,
  );
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
