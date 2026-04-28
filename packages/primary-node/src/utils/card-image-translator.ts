/**
 * Card Image Path Translator — auto-translate local image paths in card JSON
 * to Feishu image_key before sending.
 *
 * Issue #2951: When an Agent includes local file paths (e.g. `/tmp/chart.png`)
 * in card `img` elements' `img_key` field, this module automatically uploads
 * the images to Feishu and replaces the paths with the returned `image_key`.
 *
 * The translation is transparent to the Agent — no manual upload step needed.
 *
 * @module utils/card-image-translator
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';

const logger = createLogger('CardImageTranslator');

/**
 * Image file extensions that can be uploaded to Feishu.
 */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
]);

/**
 * Maximum image file size (10 MB, matching Feishu's limit).
 */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Check if a string looks like a local file path to an image.
 *
 * A value is considered a local image path if:
 * - It starts with `/`, `./`, or `../`
 * - It ends with a known image extension
 * - The file exists on the local filesystem
 *
 * Values that already look like Feishu image_keys (e.g. `img_v3_xxx`)
 * or are clearly not file paths are skipped.
 *
 * @param value - The string value to check
 * @returns true if the value looks like a local image path
 */
export function isLocalImagePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  // Skip values that are clearly already Feishu image_keys
  // Feishu image_keys look like: img_v3_02ab_xxxx, img_v2_xxx, etc.
  if (value.startsWith('img_')) {
    return false;
  }

  // Must start with path-like prefix
  if (!value.startsWith('/') && !value.startsWith('./') && !value.startsWith('../')) {
    return false;
  }

  // Must have an image extension
  const ext = path.extname(value).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return false;
  }

  // File must exist
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

/**
 * Upload a local image file to Feishu and return the image_key.
 *
 * @param client - Feishu API client
 * @param filePath - Local path to the image file
 * @returns The Feishu image_key, or undefined if upload failed
 */
async function uploadImage(
  client: lark.Client,
  filePath: string,
): Promise<string | undefined> {
  try {
    // Check file size
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      logger.warn(
        { filePath, sizeBytes: stat.size, maxBytes: MAX_IMAGE_SIZE },
        'Image file too large, skipping upload',
      );
      return undefined;
    }

    const uploadResp = await client.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(filePath),
      },
    });

    const imageKey = (uploadResp as unknown as { image_key?: string })?.image_key;
    if (!imageKey) {
      logger.warn({ filePath }, 'Image upload returned no image_key');
      return undefined;
    }

    logger.info({ filePath, imageKey }, 'Local image uploaded successfully');
    return imageKey;
  } catch (error) {
    logger.error(
      { err: error, filePath },
      'Failed to upload local image',
    );
    return undefined;
  }
}

/**
 * Result of card image translation.
 */
export interface CardImageTranslationResult {
  /** The translated card (may be the same object if no changes were needed) */
  card: Record<string, unknown>;
  /** Number of images that were successfully translated */
  translated: number;
  /** Number of images that failed to translate */
  failed: number;
  /** Details of failed translations for error reporting */
  failures: Array<{ path: string; reason: string }>;
}

/**
 * Walk through a card JSON structure and collect all local image paths
 * found in `img_key` fields of `img` elements.
 *
 * Also handles `img_key` in nested structures like column_set → column → elements.
 *
 * @param obj - The card JSON (or sub-tree) to scan
 * @returns Array of { parent, key, localPath } tuples pointing to locations to replace
 */
function findLocalImagePaths(
  obj: unknown,
): Array<{ parent: Record<string, unknown>; key: string; localPath: string }> {
  const results: Array<{ parent: Record<string, unknown>; key: string; localPath: string }> = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return results;
  }

  const record = obj as Record<string, unknown>;

  // Check if this is an img element with a local path in img_key
  if (record.tag === 'img' && typeof record.img_key === 'string' && isLocalImagePath(record.img_key)) {
    results.push({ parent: record, key: 'img_key', localPath: record.img_key });
  }

  // Recurse into all values
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const item of value) {
          results.push(...findLocalImagePaths(item));
        }
      } else {
        results.push(...findLocalImagePaths(value));
      }
    }
  }

  return results;
}

/**
 * Walk through card JSON and find markdown elements containing local image
 * references in the format `![](local_path)`.
 *
 * @param obj - The card JSON to scan
 * @returns Array of { parent, localPath, fullMatch } for each found reference
 */
function findMarkdownImagePaths(
  obj: unknown,
): Array<{ parent: Record<string, unknown>; contentKey: string; localPath: string; original: string }> {
  const results: Array<{ parent: Record<string, unknown>; contentKey: string; localPath: string; original: string }> = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return results;
  }

  const record = obj as Record<string, unknown>;

  // Check if this is a markdown element with content containing local image refs
  if (record.tag === 'markdown' && typeof record.content === 'string') {
    // Match ![alt](local_path) patterns where local_path is a local file path
    const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = mdImageRegex.exec(record.content)) !== null) {
      const [, , imagePath] = match;
      if (isLocalImagePath(imagePath)) {
        results.push({
          parent: record,
          contentKey: 'content',
          localPath: imagePath,
          original: match[0],
        });
      }
    }
  }

  // Recurse into all values
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const item of value) {
          results.push(...findMarkdownImagePaths(item));
        }
      } else {
        results.push(...findMarkdownImagePaths(value));
      }
    }
  }

  return results;
}

/**
 * Translate local image paths in a Feishu card JSON to Feishu image_keys.
 *
 * Scans the card for:
 * 1. `img` elements with local paths in `img_key` field
 * 2. Markdown elements with local image references `![](path)`
 *
 * Each detected local path is uploaded to Feishu, and the path is replaced
 * with the returned `image_key`.
 *
 * The card object is deep-cloned before modification (immutable approach).
 * If no local paths are found, the original card reference is returned as-is.
 *
 * @param card - The Feishu card JSON structure
 * @param client - Feishu API client for image upload
 * @returns Translation result with the (possibly modified) card and stats
 */
export async function translateCardImagePaths(
  card: Record<string, unknown>,
  client: lark.Client,
): Promise<CardImageTranslationResult> {
  // Quick check: if no local paths found, return early without cloning
  const imgPaths = findLocalImagePaths(card);
  const mdPaths = findMarkdownImagePaths(card);

  if (imgPaths.length === 0 && mdPaths.length === 0) {
    return { card, translated: 0, failed: 0, failures: [] };
  }

  logger.info(
    { imgCount: imgPaths.length, mdCount: mdPaths.length },
    'Found local image paths in card, starting translation',
  );

  // Deep clone the card to avoid mutating the original
  const clonedCard = structuredClone(card);

  let translated = 0;
  let failed = 0;
  const failures: Array<{ path: string; reason: string }> = [];

  // Upload unique images (deduplicate by path)
  const uniquePaths = new Set<string>();
  for (const { localPath } of imgPaths) {
    uniquePaths.add(localPath);
  }
  for (const { localPath } of mdPaths) {
    uniquePaths.add(localPath);
  }

  const uploadedKeys = new Map<string, string>();
  for (const localPath of uniquePaths) {
    const imageKey = await uploadImage(client, localPath);
    if (imageKey) {
      uploadedKeys.set(localPath, imageKey);
      translated++;
    } else {
      failed++;
      failures.push({ path: localPath, reason: 'Upload failed or file not found' });
    }
  }

  // Replace img_key fields in cloned card
  if (imgPaths.length > 0) {
    const clonedImgPaths = findLocalImagePaths(clonedCard);
    for (const { parent, key, localPath } of clonedImgPaths) {
      const imageKey = uploadedKeys.get(localPath);
      if (imageKey) {
        parent[key] = imageKey;
      }
    }
  }

  // Replace markdown image references in cloned card
  if (mdPaths.length > 0) {
    const clonedMdPaths = findMarkdownImagePaths(clonedCard);
    for (const { parent, contentKey, localPath, original } of clonedMdPaths) {
      const imageKey = uploadedKeys.get(localPath);
      if (imageKey) {
        // Replace the markdown image with an img element reference
        // Since Feishu markdown doesn't support inline images via image_key,
        // we replace the reference with just the image_key text
        // Note: Feishu markdown doesn't support inline images in the standard way,
        // so the best we can do is remove the broken local path reference
        const content = parent[contentKey] as string;
        parent[contentKey] = content.replace(original, `![image](${imageKey})`);
      }
    }
  }

  return { card: clonedCard, translated, failed, failures };
}
