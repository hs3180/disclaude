#!/usr/bin/env tsx
/**
 * skills/insert-doc-image/insert-doc-image.ts
 * — Insert a local image into a Feishu document at a specific position.
 *
 * Uses lark-cli for all operations:
 *   1. docs +media-insert for image upload (handles multipart + auth)
 *   2. lark-cli api for block manipulation (delete appended + create at index)
 *
 * Environment variables:
 *   DOC_IMAGE_DOC_ID      Feishu document ID (doxcnXXX format)
 *   DOC_IMAGE_FILE_PATH   Local path to the image file
 *   DOC_IMAGE_INDEX       Target position (0-based, -1 = append)
 *   DOC_IMAGE_ALIGN       left / center / right (default: center)
 *   DOC_IMAGE_CAPTION     Optional image caption
 *   DOC_IMAGE_SKIP_LARK   Set to '1' to skip lark-cli calls (testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error or fatal error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 60_000;
const DOC_ID_REGEX = /^doxcn[a-zA-Z0-9]+$/;
const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const VALID_ALIGNS = ['left', 'center', 'right'];

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  // lark-cli may output non-JSON lines before the JSON; find the first '{'
  const idx = stdout.indexOf('{');
  if (idx === -1) throw new Error(`No JSON in output: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(idx));
}

// ---- Validation ----

function validateDocId(docId: string): void {
  if (!docId) exit('DOC_IMAGE_DOC_ID is required');
  if (!DOC_ID_REGEX.test(docId))
    exit(`Invalid DOC_IMAGE_DOC_ID '${docId}' — must match doxcnXXX format`);
}

function validateFilePath(filePath: string): string {
  if (!filePath) exit('DOC_IMAGE_FILE_PATH is required');
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) exit(`Image file not found: ${absPath}`);
  const ext = extname(absPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext))
    exit(`Unsupported image format '${ext}' — supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  const size = statSync(absPath).size;
  if (size > MAX_FILE_SIZE)
    exit(`Image file too large (${(size / 1024 / 1024).toFixed(1)} MB) — max 20 MB`);
  return absPath;
}

function validateIndex(raw: string): number {
  const idx = parseInt(raw, 10);
  if (isNaN(idx)) exit(`Invalid DOC_IMAGE_INDEX '${raw}' — must be a number`);
  if (idx < -1) exit(`Invalid DOC_IMAGE_INDEX '${raw}' — must be >= -1`);
  return idx;
}

// ---- lark-cli wrappers ----

async function checkLarkCli(): Promise<void> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
  } catch {
    exit('lark-cli not found in PATH. Install and authenticate first (lark-cli auth login).');
  }
}

interface MediaInsertResult {
  document_id: string;
  block_id: string;
  file_token: string;
  file_name: string;
  type: string;
}

async function mediaInsert(
  docId: string,
  filePath: string,
  align: string,
  caption?: string,
): Promise<MediaInsertResult> {
  const args = [
    'docs', '+media-insert',
    '--doc', docId,
    '--file', filePath,
    '--align', align,
  ];
  if (caption) args.push('--caption', caption);

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  const result = parseJsonOutput(stdout);
  if (!result.file_token) {
    throw new Error(`+media-insert did not return file_token. Output: ${stdout.slice(0, 300)}`);
  }
  return result as unknown as MediaInsertResult;
}

async function getBlockCount(docId: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'lark-cli',
    ['api', 'GET', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`, '--page-size', '1'],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const result = parseJsonOutput(stdout);
  const data = (result as Record<string, unknown>).data as Record<string, unknown> | undefined;
  if (!data) return 0;
  const page = data.page as Record<string, unknown> | undefined;
  if (page && typeof page.total === 'number') return page.total;
  const items = data.items as Array<unknown> | undefined;
  return items?.length ?? 0;
}

async function deleteBlockAtIndex(docId: string, index: number): Promise<void> {
  await execFileAsync(
    'lark-cli',
    [
      'api', 'DELETE',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`,
      '-d', JSON.stringify({ start_index: index, end_index: index }),
    ],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
}

async function createImageBlock(
  docId: string,
  fileToken: string,
  index: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'lark-cli',
    [
      'api', 'POST',
      `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      '-d', JSON.stringify({
        children: [{ block_type: 27, image: { token: fileToken } }],
        index,
      }),
    ],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const result = parseJsonOutput(stdout);
  const data = (result as Record<string, unknown>).data as Record<string, unknown> | undefined;
  const children = data?.children as Array<Record<string, unknown>> | undefined;
  return (children?.[0]?.block_id as string) ?? '';
}

// ---- Main ----

async function main(): Promise<void> {
  const docId = process.env.DOC_IMAGE_DOC_ID ?? '';
  const filePath = process.env.DOC_IMAGE_FILE_PATH ?? '';
  const indexRaw = process.env.DOC_IMAGE_INDEX ?? '-1';
  const align = process.env.DOC_IMAGE_ALIGN ?? 'center';
  const caption = process.env.DOC_IMAGE_CAPTION ?? '';
  const skipLark = process.env.DOC_IMAGE_SKIP_LARK === '1';

  // Validate
  validateDocId(docId);
  const absImagePath = validateFilePath(filePath);
  const targetIndex = validateIndex(indexRaw);
  if (!VALID_ALIGNS.includes(align))
    exit(`Invalid DOC_IMAGE_ALIGN '${align}' — must be left/center/right`);

  console.log(`INFO: Inserting image into doc ${docId}`);
  console.log(`INFO: Image: ${absImagePath}`);
  console.log(`INFO: Target index: ${targetIndex === -1 ? 'append (end)' : targetIndex}`);

  if (skipLark) {
    console.log('OK: Dry-run mode, skipping lark-cli calls');
    return;
  }

  // Check lark-cli
  await checkLarkCli();

  // --- Append mode ---
  if (targetIndex === -1) {
    const result = await mediaInsert(docId, absImagePath, align, caption || undefined);
    console.log(`OK: Image appended to document`);
    console.log(`  block_id: ${result.block_id}`);
    console.log(`  file_token: ${result.file_token}`);
    return;
  }

  // --- Positional insert ---
  const blockCount = await getBlockCount(docId);
  console.log(`INFO: Current block count: ${blockCount}`);

  // If target is at or beyond end, just append
  if (targetIndex >= blockCount) {
    console.log(`INFO: Target index ${targetIndex} >= block count ${blockCount}, appending`);
    const result = await mediaInsert(docId, absImagePath, align, caption || undefined);
    console.log(`OK: Image appended to document`);
    console.log(`  block_id: ${result.block_id}`);
    console.log(`  file_token: ${result.file_token}`);
    return;
  }

  // Step 1: Upload via +media-insert (appends to end, at index blockCount)
  const upload = await mediaInsert(docId, absImagePath, align);
  console.log(`INFO: Image uploaded, file_token: ${upload.file_token}`);

  // Step 2: Delete the appended block at index blockCount
  try {
    await deleteBlockAtIndex(docId, blockCount);
    console.log(`INFO: Removed appended block at index ${blockCount}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to remove appended block: ${msg}`);
    console.error(`WARN: Image remains at end of document (index ${blockCount})`);
    console.log(`OK: Image inserted (at end, target position failed)`);
    console.log(`  block_id: ${upload.block_id}`);
    console.log(`  file_token: ${upload.file_token}`);
    process.exit(1);
  }

  // Step 3: Create image block at target index
  try {
    const newBlockId = await createImageBlock(docId, upload.file_token, targetIndex);
    console.log(`OK: Image inserted at index ${targetIndex}`);
    console.log(`  block_id: ${newBlockId}`);
    console.log(`  file_token: ${upload.file_token}`);
  } catch (err) {
    // Rollback: re-insert at end
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to insert at index ${targetIndex}: ${msg}`);
    console.error(`WARN: Attempting fallback — re-insert at end...`);
    try {
      const fallbackId = await createImageBlock(docId, upload.file_token, blockCount);
      console.error(`WARN: Image re-inserted at end (fallback)`);
      console.log(`OK: Image inserted (at end, target position failed)`);
      console.log(`  block_id: ${fallbackId}`);
      console.log(`  file_token: ${upload.file_token}`);
    } catch {
      console.error(`ERROR: Complete failure. File token: ${upload.file_token}`);
      console.error(`ERROR: Manual recovery needed — image uploaded but not in document.`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
