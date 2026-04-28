/**
 * Card Image Resolver — automatically translates local image paths in card JSON
 * to Feishu image_keys by uploading images before sending.
 *
 * When Agent generates a card with `img` elements whose `img_key` points to a
 * local file (e.g. `/tmp/chart.png`), this module:
 *   1. Scans the card JSON recursively for local file paths
 *   2. Uploads each image to Feishu via `im.image.create`
 *   3. Replaces the local path with the returned `image_key`
 *
 * This makes the process transparent to the Agent — it can write local paths
 * directly in card JSON without needing a separate upload step.
 *
 * Issue #2951: Phase 2 of #1919 — channel layer auto-translation.
 *
 * @module primary-node/utils/card-image-resolver
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';

const logger = createLogger('CardImageResolver');

/** Supported image file extensions (matching Feishu im.image.create constraints). */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
]);

/** Maximum image file size in bytes (10 MB, Feishu limit). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Check whether a string looks like a local file path that should be uploaded.
 *
 * A value is considered a local path if:
 * - It starts with `/` or `./` or `~/`
 * - The file extension (if any) matches a supported image format
 * - The file actually exists on disk
 *
 * We deliberately avoid treating values like `img_v3_02ab_xxxx` (real Feishu
 * image_keys) or URLs (http/https) as local paths.
 */
export function isLocalImagePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  // Must start with a path-like prefix
  if (!value.startsWith('/') && !value.startsWith('./') && !value.startsWith('~/')) {
    return false;
  }

  // Must have a recognized image extension
  const ext = path.extname(value).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return false;
  }

  // File must exist on disk
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

/**
 * Detect local image paths inside markdown content.
 *
 * Feishu markdown supports `![alt](url)` syntax. If the URL is a local file
 * path, it needs to be uploaded and replaced.
 *
 * @returns Array of local paths found in markdown image references
 */
export function extractMarkdownImagePaths(content: string): string[] {
  const paths: string[] = [];
  // Match ![alt](path) — the path must start with / or ./ or ~/
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const [, , imgPath] = match;
    if (isLocalImagePath(imgPath)) {
      paths.push(imgPath);
    }
  }
  return paths;
}

/**
 * Recursively scan a card JSON object and collect all local image paths.
 *
 * Scans:
 * - `img` elements: checks `img_key` field
 * - `markdown` elements: checks `content` for `![...](local_path)` patterns
 * - Nested structures: `elements`, `columns`, `background`, etc.
 *
 * @returns Array of unique local file paths found in the card
 */
export function collectLocalImagePaths(card: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  walkCard(card, paths);
  return Array.from(paths);
}

/**
 * Recursively walk a card (or any nested structure) and collect local paths.
 */
function walkCard(obj: unknown, paths: Set<string>): void {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      walkCard(item, paths);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Check for img element with img_key
  if (record.tag === 'img' && typeof record.img_key === 'string') {
    if (isLocalImagePath(record.img_key as string)) {
      paths.add(record.img_key as string);
    }
  }

  // Check for markdown element with local image references
  if (record.tag === 'markdown' && typeof record.content === 'string') {
    const mdPaths = extractMarkdownImagePaths(record.content as string);
    for (const p of mdPaths) {
      paths.add(p);
    }
  }

  // Recurse into common nested fields
  for (const key of ['elements', 'columns', 'text', 'content', 'background']) {
    if (record[key] !== undefined && record[key] !== null) {
      walkCard(record[key], paths);
    }
  }
}

/**
 * Upload a single image to Feishu and return its image_key.
 *
 * @param filePath - Local path to the image file
 * @param client - Feishu lark client for API calls
 * @returns The Feishu image_key, or undefined if upload failed
 */
async function uploadImage(
  filePath: string,
  client: lark.Client,
): Promise<string | undefined> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      logger.warn({ filePath, size: stat.size, maxSize: MAX_IMAGE_SIZE }, 'Image exceeds 10MB limit, skipping');
      return undefined;
    }

    const uploadResp = await client.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(filePath),
      },
    });

    const imageKey = uploadResp?.image_key;
    if (!imageKey) {
      logger.warn({ filePath }, 'Upload succeeded but no image_key returned');
      return undefined;
    }

    logger.info({ filePath, imageKey }, 'Image uploaded for card embedding');
    return imageKey;
  } catch (error) {
    logger.error({ err: error, filePath }, 'Failed to upload image for card');
    return undefined;
  }
}

/**
 * Upload all local images and build a path → image_key mapping.
 *
 * Uploads are performed sequentially to avoid overwhelming the Feishu API.
 * Failed uploads are silently skipped — the original local path remains in the
 * card (which will likely cause a Feishu API error, surfacing the problem).
 *
 * @param localPaths - Array of local file paths to upload
 * @param client - Feishu lark client
 * @returns Map from local path to Feishu image_key (only successful uploads)
 */
export async function uploadImages(
  localPaths: string[],
  client: lark.Client,
): Promise<Map<string, string>> {
  const pathToKey = new Map<string, string>();

  for (const filePath of localPaths) {
    const imageKey = await uploadImage(filePath, client);
    if (imageKey) {
      pathToKey.set(filePath, imageKey);
    }
  }

  return pathToKey;
}

/**
 * Replace local image paths in a card JSON with Feishu image_keys.
 *
 * Handles:
 * - `img` elements: replaces `img_key` field value
 * - `markdown` elements: replaces `![alt](local_path)` with `![alt](image_key)`
 *
 * **Mutates the input card in place** for efficiency (deep-cloning large cards
 * is wasteful since the card is sent once and discarded).
 *
 * @param card - The card JSON object to modify
 * @param pathToKey - Mapping from local paths to Feishu image_keys
 */
export function replacePaths(
  card: Record<string, unknown>,
  pathToKey: Map<string, string>,
): void {
  replacePathsRecursive(card, pathToKey);
}

function replacePathsRecursive(
  obj: unknown,
  pathToKey: Map<string, string>,
): void {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      replacePathsRecursive(item, pathToKey);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Replace img_key in img elements
  if (record.tag === 'img' && typeof record.img_key === 'string') {
    const replacement = pathToKey.get(record.img_key as string);
    if (replacement) {
      record.img_key = replacement;
    }
  }

  // Replace markdown image references
  if (record.tag === 'markdown' && typeof record.content === 'string') {
    record.content = replaceMarkdownPaths(record.content as string, pathToKey);
  }

  // Recurse into nested fields
  for (const key of ['elements', 'columns', 'text', 'content', 'background']) {
    if (record[key] !== undefined && record[key] !== null) {
      replacePathsRecursive(record[key], pathToKey);
    }
  }
}

/**
 * Replace local paths in markdown image syntax with Feishu image_keys.
 *
 * e.g. `![chart](/tmp/chart.png)` → `![chart](img_v3_02ab_xxxx)`
 */
function replaceMarkdownPaths(
  content: string,
  pathToKey: Map<string, string>,
): string {
  return content.replace(
    /(!\[[^\]]*\]\()([^)]+)(\))/g,
    (fullMatch, prefix: string, imgPath: string, closing: string) => {
      const replacement = pathToKey.get(imgPath);
      if (replacement) {
        return `${prefix}${replacement}${closing}`;
      }
      return fullMatch;
    },
  );
}

/**
 * Main entry point: resolve all local image paths in a card by uploading them.
 *
 * This is the "auto-translate" function called from FeishuChannel before
 * sending a card message. It:
 *   1. Scans the card for local image paths
 *   2. Uploads each image to Feishu
 *   3. Replaces the paths with image_keys in the card JSON
 *
 * The card object is mutated in place.
 *
 * @param card - The card JSON object
 * @param client - Feishu lark client for image upload
 * @returns Number of images successfully resolved
 */
export async function resolveCardImagePaths(
  card: Record<string, unknown>,
  client: lark.Client,
): Promise<number> {
  const localPaths = collectLocalImagePaths(card);

  if (localPaths.length === 0) {
    return 0;
  }

  logger.info({ count: localPaths.length, paths: localPaths }, 'Found local image paths in card, uploading');

  const pathToKey = await uploadImages(localPaths, client);

  if (pathToKey.size > 0) {
    replacePaths(card, pathToKey);
    logger.info({ resolved: pathToKey.size, total: localPaths.length }, 'Card image paths resolved');
  }

  return pathToKey.size;
}
