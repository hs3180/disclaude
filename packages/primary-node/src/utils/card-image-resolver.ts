/**
 * Card Image Resolver - Automatically uploads local image paths in card JSON to Feishu.
 *
 * When sending card messages, this module scans the card JSON for local file paths
 * in `img_key` fields (img elements) and markdown image references, uploads them
 * to Feishu, and replaces the paths with the returned image_keys.
 *
 * Issue #2951: feat(channel): auto-translate local image paths to Feishu image_key
 *
 * @module primary-node/utils/card-image-resolver
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';

const logger = createLogger('CardImageResolver');

/** Image file extensions recognized for local path detection. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico', '.svg',
]);

/** Maximum image file size in bytes (10 MB). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Check if a string looks like a local file path that could be an image.
 *
 * A local image path:
 * - Starts with `/` (absolute path) or `./` or `../` (relative path) or `~/` (home dir)
 * - Ends with a recognized image extension
 *
 * Excludes:
 * - Feishu image_keys (e.g., `img_v3_02ab_xxxx`) — no leading `/`
 * - URLs (http://, https://)
 * - Data URIs (data:)
 */
export function isLocalImagePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  // Skip URLs and data URIs
  if (/^(https?:\/\/|data:)/.test(value)) {
    return false;
  }

  // Must start with / or ./ or ~/ (absolute, relative, or home)
  if (!/^(\/|\.\/|~\/|\.\.\/)/.test(value)) {
    return false;
  }

  // Must end with a recognized image extension
  const ext = path.extname(value).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Recursively scan a card JSON object for local image paths.
 *
 * Scans for:
 * 1. `img_key` fields in elements (standard Feishu img element)
 * 2. Markdown image syntax `![alt](path)` in markdown content elements
 *
 * @returns Set of unique local image paths found
 */
export function findLocalImagePaths(card: unknown): Set<string> {
  const paths = new Set<string>();

  function walk(obj: unknown): void {
    if (obj === null || obj === undefined) {
      return;
    }

    if (typeof obj === 'string') {
      // Check for markdown image syntax: ![alt](/path/to/image.png)
      const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = mdImageRegex.exec(obj)) !== null) {
        const imagePath = match[2];
        if (isLocalImagePath(imagePath)) {
          paths.add(imagePath);
        }
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        walk(item);
      }
      return;
    }

    if (typeof obj === 'object') {
      const record = obj as Record<string, unknown>;

      // Check img_key field directly (Feishu img element pattern)
      if ('tag' in record && record.tag === 'img' && 'img_key' in record) {
        const imgKey = record.img_key;
        if (typeof imgKey === 'string' && isLocalImagePath(imgKey)) {
          paths.add(imgKey);
        }
      }

      // Recurse into all values
      for (const value of Object.values(record)) {
        walk(value);
      }
    }
  }

  walk(card);
  return paths;
}

/**
 * Upload a local image file to Feishu and return the image_key.
 *
 * @param client - Lark client instance
 * @param filePath - Local file path to upload
 * @returns Feishu image_key, or undefined if upload failed
 */
async function uploadImage(
  client: lark.Client,
  filePath: string,
): Promise<string | undefined> {
  try {
    // Check file exists and size
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

    const imageKey = uploadResp?.image_key;
    if (!imageKey) {
      logger.warn({ filePath }, 'Upload returned no image_key');
      return undefined;
    }

    logger.info({ filePath, imageKey }, 'Local image uploaded to Feishu');
    return imageKey;
  } catch (error) {
    logger.warn(
      { err: error, filePath },
      'Failed to upload local image, leaving path unchanged',
    );
    return undefined;
  }
}

/**
 * Deep-clone and replace local image paths with Feishu image_keys in a card JSON.
 *
 * Creates a new card object with local paths replaced. The original card is not modified.
 *
 * Handles two patterns:
 * 1. `img_key` field in `img` elements: `{"tag": "img", "img_key": "/tmp/chart.png"}`
 * 2. Markdown image syntax: `![alt](/tmp/chart.png)` in markdown content
 *
 * @param card - Card JSON structure (will be deep-cloned)
 * @param pathToKey - Mapping from local file path to Feishu image_key
 * @returns New card object with paths replaced
 */
export function replaceLocalImagePaths(
  card: unknown,
  pathToKey: Map<string, string>,
): unknown {
  if (pathToKey.size === 0) {
    return card;
  }

  function transform(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'string') {
      // Replace markdown image syntax: ![alt](/path) → ![alt](img_key)
      return obj.replace(/(!\[[^\]]*\]\()([^)]+)\)/g, (fullMatch, prefix, imagePath) => {
        const replacement = pathToKey.get(imagePath);
        if (replacement) {
          return `${prefix}${replacement})`;
        }
        return fullMatch;
      });
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => transform(item));
    }

    if (typeof obj === 'object') {
      const record = obj as Record<string, unknown>;
      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(record)) {
        // Replace img_key field in img elements
        if (key === 'img_key' && typeof value === 'string' && pathToKey.has(value)) {
          result[key] = pathToKey.get(value)!;
        } else {
          result[key] = transform(value);
        }
      }

      return result;
    }

    return obj;
  }

  return transform(card);
}

/**
 * Resolve local image paths in a card JSON by uploading them to Feishu.
 *
 * This is the main entry point. It:
 * 1. Scans the card for local image paths
 * 2. Uploads each unique path to Feishu
 * 3. Returns a new card with paths replaced by image_keys
 *
 * If no local paths are found, returns the original card unchanged.
 * If individual uploads fail, those paths are left unchanged (graceful degradation).
 *
 * @param client - Lark client instance for image upload
 * @param card - Card JSON structure
 * @returns Card with local image paths replaced by Feishu image_keys
 */
export async function resolveCardImages(
  client: lark.Client,
  card: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const localPaths = findLocalImagePaths(card);

  if (localPaths.size === 0) {
    return card;
  }

  logger.info(
    { pathCount: localPaths.size, paths: [...localPaths] },
    'Found local image paths in card, uploading to Feishu',
  );

  // Upload all images in parallel for efficiency
  const uploadResults = await Promise.all(
    [...localPaths].map(async (filePath) => {
      const imageKey = await uploadImage(client, filePath);
      return { filePath, imageKey };
    }),
  );

  // Build mapping from path to image_key (skip failed uploads)
  const pathToKey = new Map<string, string>();
  for (const { filePath, imageKey } of uploadResults) {
    if (imageKey) {
      pathToKey.set(filePath, imageKey);
    }
  }

  if (pathToKey.size === 0) {
    logger.warn('All image uploads failed, sending card unchanged');
    return card;
  }

  // Replace paths in card
  const resolved = replaceLocalImagePaths(card, pathToKey);
  return resolved as Record<string, unknown>;
}
