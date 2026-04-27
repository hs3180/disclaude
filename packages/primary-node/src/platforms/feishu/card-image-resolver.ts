/**
 * Card Image Path Resolver — auto-translate local image paths to Feishu image_keys.
 *
 * When sending card messages (send_card), scans the card JSON for `img` elements
 * whose `img_key` field contains a local file path. Uploads those files to Feishu
 * and replaces the path with the returned `image_key`.
 *
 * Issue #2951: Channel-layer auto-translation — transparent to the Agent.
 *
 * @module platforms/feishu/card-image-resolver
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';

const logger = createLogger('CardImageResolver');

/**
 * Supported image file extensions.
 */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico',
]);

/**
 * Maximum image file size (10 MB, same as Feishu API limit).
 */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Check if a string looks like a local file path that should be uploaded.
 *
 * A value is considered a local path if:
 * - It starts with `/` (absolute path) OR starts with `./` (relative path)
 * - AND has a recognized image file extension
 * - AND the file exists on disk
 *
 * Values that are already Feishu image_keys (e.g., `img_v3_xxx`) or HTTP URLs
 * are NOT considered local paths and are left untouched.
 */
export function isLocalImagePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  // Skip Feishu image keys (img_v2_, img_v3_, etc.) and HTTP URLs
  if (value.startsWith('img_v') || value.startsWith('http://') || value.startsWith('https://')) {
    return false;
  }

  // Must look like a file path
  if (!value.startsWith('/') && !value.startsWith('./')) {
    return false;
  }

  // Must have an image extension
  const ext = path.extname(value).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return false;
  }

  return true;
}

/**
 * Recursively walk a card JSON structure and collect all img elements
 * that have local file paths in their `img_key` field.
 *
 * Returns an array of { container, key } refs that allow in-place mutation.
 */
export function findLocalImagePaths(card: unknown): Array<{ container: Record<string, unknown>; key: string; filePath: string }> {
  const results: Array<{ container: Record<string, unknown>; key: string; filePath: string }> = [];

  function walk(obj: unknown): void {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        walk(item);
      }
    } else if (obj && typeof obj === 'object') {
      const record = obj as Record<string, unknown>;

      // Check if this is an img element with a local path in img_key
      if (record.tag === 'img' && typeof record.img_key === 'string') {
        const imgKey = record.img_key as string;
        if (isLocalImagePath(imgKey)) {
          results.push({ container: record, key: 'img_key', filePath: imgKey });
        }
      }

      // Recurse into all values
      for (const value of Object.values(record)) {
        walk(value);
      }
    }
  }

  walk(card);
  return results;
}

/**
 * Upload a local image file to Feishu and return the image_key.
 *
 * Uses Feishu's `im.image.create` API with `image_type: 'message'`.
 *
 * @param client - Feishu Lark client
 * @param filePath - Local file path to upload
 * @returns Feishu image_key string, or undefined on failure
 */
export async function uploadImageToFeishu(
  client: lark.Client,
  filePath: string,
): Promise<string | undefined> {
  try {
    // Check file exists and size
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      logger.warn({ filePath, size: stat.size, max: MAX_IMAGE_SIZE }, 'Image file too large, skipping');
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
      logger.warn({ filePath }, 'Feishu image upload returned no image_key');
      return undefined;
    }

    logger.info({ filePath, imageKey }, 'Image uploaded to Feishu');
    return imageKey;
  } catch (error) {
    logger.error({ err: error, filePath }, 'Failed to upload image to Feishu');
    return undefined;
  }
}

/**
 * Resolve all local image paths in a card JSON by uploading them to Feishu
 * and replacing the paths with image_keys.
 *
 * This function mutates the card object in-place. If an upload fails for
 * a particular image, the original path is left unchanged (the card will
 * show a broken image in Feishu, but the message will still be sent).
 *
 * @param card - Card JSON structure (mutated in-place)
 * @param client - Feishu Lark client for image upload
 * @returns Number of images successfully resolved
 */
export async function resolveCardImagePaths(
  card: Record<string, unknown>,
  client: lark.Client,
): Promise<number> {
  const refs = findLocalImagePaths(card);

  if (refs.length === 0) {
    return 0;
  }

  logger.info({ count: refs.length }, 'Found local image paths in card, uploading...');

  let resolved = 0;
  for (const ref of refs) {
    // Verify file exists before attempting upload
    if (!fs.existsSync(ref.filePath)) {
      logger.warn({ filePath: ref.filePath }, 'Local image file not found, skipping');
      continue;
    }

    const imageKey = await uploadImageToFeishu(client, ref.filePath);
    if (imageKey) {
      ref.container[ref.key] = imageKey;
      resolved++;
    }
  }

  logger.info({ total: refs.length, resolved }, 'Card image resolution complete');
  return resolved;
}
