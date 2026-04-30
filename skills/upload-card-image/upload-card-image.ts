#!/usr/bin/env tsx
/**
 * skills/upload-card-image/upload-card-image.ts
 *
 * Upload a local image to Feishu and return image_key for card embedding.
 *
 * Uses lark-cli for authentication and API calls — no direct credential access.
 * Follows the same pattern as skills/rename-group/rename-group.ts and
 * skills/upload-docx-image/upload-docx-image.ts.
 *
 * Environment variables:
 *   UPLOAD_IMAGE_PATH  Local path to the image file (required)
 *   UPLOAD_SKIP_LARK   Set to '1' to skip lark-cli checks (testing / dry-run)
 *
 * Exit codes:
 *   0 — success (outputs "OK: image_key=<value>")
 *   1 — validation error or fatal API error
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 60_000;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB (Feishu IM image limit)
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.ico'];

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`INFO: ${msg}`);
}

/**
 * Run a lark-cli raw API call and return stdout as string.
 */
async function larkCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Parse a JSON response from lark-cli and check for API errors.
 */
function parseLarkResponse(raw: string): any {
  let result: any;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse lark-cli response: ${raw.slice(0, 300)}`);
  }

  if (result.code !== 0) {
    throw new Error(`Lark API error ${result.code}: ${result.msg ?? JSON.stringify(result)}`);
  }
  return result;
}

// ---- Validation ----

function validateImagePath(imagePath: string): void {
  if (!imagePath) {
    exit('UPLOAD_IMAGE_PATH environment variable is required');
  }
  if (!existsSync(imagePath)) {
    exit(`Image file not found: ${imagePath}`);
  }
  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    exit(`Unsupported image format '${ext}'. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }
  const size = statSync(imagePath).size;
  if (size === 0) {
    exit('Image file is empty');
  }
  if (size > MAX_IMAGE_SIZE) {
    exit(`Image too large: ${(size / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE / 1024 / 1024} MB)`);
  }
}

// ---- Upload strategies ----

/**
 * Strategy 1: Use lark-cli high-level image upload command.
 * Newer versions of lark-cli may support: lark-cli im image create
 */
async function strategyHighLevel(imagePath: string): Promise<string> {
  try {
    const stdout = await larkCli([
      'im', 'image', 'create',
      '--image', imagePath,
      '--image_type', 'message',
    ]);
    const resp = parseLarkResponse(stdout);
    const imageKey: string | undefined = resp?.data?.image_key;
    if (imageKey) return imageKey;
    throw new Error(`No image_key in response: ${JSON.stringify(resp?.data ?? resp)}`);
  } catch {
    // Fall through to next strategy
    return '';
  }
}

/**
 * Strategy 2: Use lark-cli raw API with --form for multipart upload.
 * lark-cli api POST /open-apis/im/v1/images --form image_type=message --form image=@/path
 */
async function strategyFormApi(imagePath: string): Promise<string> {
  try {
    const stdout = await larkCli([
      'api', 'POST', '/open-apis/im/v1/images',
      '--form', 'image_type=message',
      '--form', `image=@${imagePath}`,
    ]);
    const resp = parseLarkResponse(stdout);
    const imageKey: string | undefined = resp?.data?.image_key;
    if (imageKey) return imageKey;
    throw new Error(`No image_key in response: ${JSON.stringify(resp?.data ?? resp)}`);
  } catch {
    // Fall through to next strategy
    return '';
  }
}

/**
 * Strategy 3: Use lark-cli raw API with -f flag (curl-style multipart).
 * Some lark-cli versions use -f instead of --form.
 */
async function strategyShortFormApi(imagePath: string): Promise<string> {
  try {
    const stdout = await larkCli([
      'api', 'POST', '/open-apis/im/v1/images',
      '-f', 'image_type=message',
      '-f', `image=@${imagePath}`,
    ]);
    const resp = parseLarkResponse(stdout);
    const imageKey: string | undefined = resp?.data?.image_key;
    if (imageKey) return imageKey;
    throw new Error(`No image_key in response: ${JSON.stringify(resp?.data ?? resp)}`);
  } catch {
    // All strategies failed
    return '';
  }
}

/**
 * Upload image using multiple lark-cli strategies.
 * Tries each approach in order and returns the first successful image_key.
 */
async function uploadImage(imagePath: string): Promise<string> {
  const fileName = basename(imagePath);
  log(`Uploading image: ${fileName}`);

  // Try each strategy in order of preference
  const strategies = [
    { name: 'high-level (im image create)', fn: strategyHighLevel },
    { name: 'raw API (--form)', fn: strategyFormApi },
    { name: 'raw API (-f)', fn: strategyShortFormApi },
  ];

  for (const strategy of strategies) {
    log(`Trying strategy: ${strategy.name}`);
    try {
      const imageKey = await strategy.fn(imagePath);
      if (imageKey) {
        log(`Upload succeeded via ${strategy.name}`);
        return imageKey;
      }
    } catch (err) {
      log(`Strategy ${strategy.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    'Image upload failed — all lark-cli strategies exhausted. ' +
    'Please verify:\n' +
    '  1. lark-cli is installed and authenticated (lark-cli auth status)\n' +
    '  2. The app has im:image scope\n' +
    '  3. The image file is valid and not corrupted\n' +
    '  4. lark-cli version supports file upload (lark-cli --version)',
  );
}

// ---- Main ----

async function main(): Promise<void> {
  const imagePath = process.env.UPLOAD_IMAGE_PATH ?? '';

  // ---- Validate input ----
  validateImagePath(imagePath);

  const fileName = basename(imagePath);
  const fileSize = statSync(imagePath).size;
  log(`Image: ${fileName} (${(fileSize / 1024).toFixed(1)} KB)`);

  // ---- Check lark-cli ----
  if (process.env.UPLOAD_SKIP_LARK !== '1') {
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
  if (process.env.UPLOAD_SKIP_LARK === '1') {
    log('Dry-run: would upload image');
    console.log('OK: image_key=dry_run_image_key_placeholder');
    return;
  }

  // ---- Upload image ----
  const imageKey = await uploadImage(imagePath);

  // ---- Output result ----
  console.log(`OK: image_key=${imageKey}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
