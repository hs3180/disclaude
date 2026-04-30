#!/usr/bin/env tsx
/**
 * skills/upload-docx-image/upload-docx-image.ts
 *
 * Insert an image into a Feishu document at a specific position.
 *
 * Uses a three-step Lark API process — all calls go through lark-cli
 * so that authentication is handled automatically (no direct credential access):
 *
 *   1. Create an empty image block (block_type: 27) at the desired index
 *   2. Upload the image file via Drive Media Upload API
 *   3. Bind the uploaded file to the block via replace_image
 *
 * If step 2 or 3 fails the empty block is deleted (best-effort rollback).
 *
 * Environment variables:
 *   DOCX_DOC_ID       Feishu document ID
 *   DOCX_IMAGE_PATH   Local path to the image file
 *   DOCX_INDEX        Insert position (-1 = append, 0+ = specific index). Default: -1
 *   DOCX_SKIP_LARK    Set to '1' to skip lark-cli checks (testing / dry-run only)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal API error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 60_000;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB (Feishu Drive limit)
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
/** Relaxed regex: Feishu document IDs may contain letters, digits, underscores and hyphens. */
const DOC_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`INFO: ${msg}`);
}

/**
 * Run a lark-cli raw API call and return the parsed JSON response.
 * Throws on non-zero API code or parse failure.
 */
async function larkApi(
  method: string,
  path: string,
  options?: { data?: Record<string, unknown>; params?: Record<string, string> },
): Promise<any> {
  const args = ['api', method, path];

  if (options?.params) {
    args.push('--params', JSON.stringify(options.params));
  }
  if (options?.data) {
    args.push('-d', JSON.stringify(options.data));
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
  });

  let result: any;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse lark-cli response: ${String(stdout).slice(0, 300)}`);
  }

  if (result.code !== 0) {
    throw new Error(`Lark API error ${result.code}: ${result.msg ?? JSON.stringify(result)}`);
  }
  return result;
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) exit('DOCX_DOC_ID environment variable is required');
  if (!DOC_ID_REGEX.test(docId)) {
    exit(`Invalid DOCX_DOC_ID '${docId}' — expected alphanumeric characters, underscores and hyphens`);
  }
}

function validateImagePath(imagePath: string): void {
  if (!imagePath) exit('DOCX_IMAGE_PATH environment variable is required');
  if (!existsSync(imagePath)) exit(`Image file not found: ${imagePath}`);
  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    exit(`Unsupported image format '${ext}'. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }
  const size = statSync(imagePath).size;
  if (size === 0) exit('Image file is empty');
  if (size > MAX_IMAGE_SIZE) {
    exit(`Image too large: ${(size / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE / 1024 / 1024} MB)`);
  }
}

function parseIndex(raw: string): number {
  const idx = parseInt(raw, 10);
  if (isNaN(idx) || idx < -1) {
    exit('DOCX_INDEX must be -1 (append) or a non-negative integer');
  }
  return idx;
}

// ---- Three-step API process ----

/**
 * Step 1 — Create an empty image block at the specified position.
 * Returns the block_id of the newly created block.
 */
async function createEmptyImageBlock(docId: string, index: number): Promise<string> {
  const body: Record<string, unknown> = {
    children: [{ block_type: 27 }],
  };
  // Omit index entirely for append (-1) — API defaults to end of document
  if (index >= 0) {
    body.index = index;
  }

  const resp = await larkApi(
    'POST',
    `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
    { data: body },
  );

  const blockId: string | undefined = resp?.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new Error(`No block_id in create-block response: ${JSON.stringify(resp?.data ?? resp)}`);
  }
  return blockId;
}

/**
 * Step 2 — Upload the image file to Feishu Drive.
 *
 * Tries multiple lark-cli invocations (API command then shortcut) so that the
 * script works regardless of the lark-cli version installed. All approaches
 * use lark-cli's built-in authentication — no direct credential access.
 *
 * Returns the file_key string needed for step 3.
 */
async function uploadImage(docId: string, imagePath: string): Promise<string> {
  // Strategy 1: lark-cli auto-generated API command (drive.medias.upload_all)
  try {
    const { stdout } = await execFileAsync('lark-cli', [
      'drive', 'medias', 'upload_all',
      '--params', JSON.stringify({ parent_type: 'docx_image', parent_node: docId }),
      '--file', imagePath,
      '--format', 'json',
    ], { timeout: LARK_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 });

    const resp = JSON.parse(stdout);
    if (resp?.data?.file_key) return resp.data.file_key;
  } catch {
    // fall through to next strategy
  }

  // Strategy 2: lark-cli drive +upload shortcut
  try {
    const { stdout } = await execFileAsync('lark-cli', [
      'drive', '+upload',
      '--file', imagePath,
      '--parent-node', docId,
      '--parent-type', 'docx_image',
      '--format', 'json',
    ], { timeout: LARK_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 });

    const resp = JSON.parse(stdout);
    if (resp?.data?.file_key) return resp.data.file_key;
  } catch {
    // fall through to next strategy
  }

  // Strategy 3: raw API call with form data flag (some lark-cli versions support --form)
  try {
    const { stdout } = await execFileAsync('lark-cli', [
      'api', 'POST', '/open-apis/drive/v1/medias/upload_all',
      '--form', `parent_type=docx_image`,
      '--form', `parent_node=${docId}`,
      '--form', `file=@${imagePath}`,
    ], { timeout: LARK_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 });

    const resp = JSON.parse(stdout);
    if (resp?.data?.file_key) return resp.data.file_key;
  } catch {
    // all strategies failed
  }

  throw new Error(
    'Image upload failed — could not upload via lark-cli. ' +
    'Please verify lark-cli version supports drive upload (lark-cli drive --help).',
  );
}

/**
 * Step 3 — Bind the uploaded image to the empty image block.
 */
async function bindImageToBlock(docId: string, blockId: string, fileKey: string): Promise<void> {
  await larkApi(
    'PATCH',
    `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    { data: { replace_image: { token: fileKey } } },
  );
}

/**
 * Rollback — delete the empty image block when step 2 or 3 fails.
 */
async function rollbackBlock(docId: string, blockId: string): Promise<void> {
  try {
    await larkApi(
      'DELETE',
      `/open-apis/docx/v1/documents/${docId}/blocks/${blockId}`,
    );
    log(`Rollback: deleted empty block ${blockId}`);
  } catch (err) {
    console.error(
      `WARN: Rollback failed for block ${blockId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOCX_DOC_ID ?? '';
  const imagePath = process.env.DOCX_IMAGE_PATH ?? '';
  const indexRaw = process.env.DOCX_INDEX ?? '-1';

  // ---- Validate inputs ----
  validateDocId(docId);
  validateImagePath(imagePath);
  const index = parseIndex(indexRaw);

  log(`Document: ${docId}`);
  log(`Image: ${imagePath} (${(statSync(imagePath).size / 1024).toFixed(1)} KB)`);
  log(`Index: ${index === -1 ? 'append (end)' : index}`);

  // ---- Check lark-cli ----
  if (process.env.DOCX_SKIP_LARK !== '1') {
    try {
      await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
    } catch {
      exit('lark-cli not found in PATH. Install with: npm install -g @larksuite/cli');
    }

    // Verify authentication status
    try {
      const { stdout } = await execFileAsync('lark-cli', ['auth', 'status'], {
        timeout: 5_000,
      });
      if (/not\s+logged\s+in|未登录/i.test(stdout)) {
        exit('lark-cli is not authenticated. Run: lark-cli auth login --recommend');
      }
    } catch {
      exit('lark-cli auth check failed. Please authenticate first: lark-cli auth login --recommend');
    }
  }

  // Dry-run mode (skip all API calls)
  if (process.env.DOCX_SKIP_LARK === '1') {
    log('Dry-run: would insert image at index ' + index);
    return;
  }

  // ---- Step 1: Create empty image block ----
  let blockId: string;
  try {
    blockId = await createEmptyImageBlock(docId, index);
    log(`Step 1 OK: created empty image block ${blockId}`);
  } catch (err) {
    exit(`Step 1 failed (create block): ${err instanceof Error ? err.message : err}`);
  }

  // ---- Steps 2 & 3 with rollback on failure ----
  try {
    const fileKey = await uploadImage(docId, imagePath);
    log(`Step 2 OK: uploaded image (file_key=${fileKey})`);

    await bindImageToBlock(docId, blockId, fileKey);
    log('Step 3 OK: bound image to block');
  } catch (stepErr) {
    const msg = stepErr instanceof Error ? stepErr.message : String(stepErr);
    console.error(`ERROR: Step 2/3 failed — ${msg}`);
    console.error('Attempting rollback (delete empty block)...');
    await rollbackBlock(docId, blockId);
    exit(`Image insertion failed (rolled back). Cause: ${msg}`);
  }

  log(`SUCCESS: Image inserted at index ${index} in document ${docId}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
