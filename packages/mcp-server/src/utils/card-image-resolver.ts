/**
 * Card Image Resolver — auto-translate local image paths in card JSON to Feishu image_keys.
 *
 * Issue #2951: When Agent sends a card with local image paths (e.g., /tmp/chart.png),
 * this utility detects them, uploads via IPC, and replaces paths with Feishu image_keys.
 *
 * Design decisions:
 * - Operates on the MCP tool layer (not channel adapter layer)
 * - Graceful degradation: failed uploads become text placeholders, never block card sending
 * - Supports both `img` elements and markdown `![](path)` syntax
 * - Uses async file existence checks
 *
 * @module mcp-server/utils/card-image-resolver
 */

import { promises as fsp } from 'fs';
import { resolve, extname } from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';

const logger = createLogger('CardImageResolver');

/** Image file extensions that Feishu supports for card embedding */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico',
]);

/**
 * Check if a string looks like a local file path (not a URL or Feishu image_key).
 *
 * Matches:
 * - Absolute paths: /tmp/chart.png
 * - Relative paths: ./chart.png, ../chart.png
 * - Bare filenames: chart.png
 *
 * Excludes:
 * - HTTP(S) URLs
 * - Feishu image_keys: img_v3_xxx, img_v2_xxx
 * - Data URIs: data:image/...
 */
export function isLocalImagePath(value: string): boolean {
  if (!value || typeof value !== 'string') {return false;}

  const trimmed = value.trim();

  // Exclude Feishu image_keys (img_v2_, img_v3_, etc.)
  if (/^img_v\d+_/.test(trimmed)) {return false;}

  // Exclude HTTP(S) URLs
  if (/^https?:\/\//i.test(trimmed)) {return false;}

  // Exclude data URIs
  if (/^data:/i.test(trimmed)) {return false;}

  // Must have an image extension
  const ext = extname(trimmed).toLowerCase();
  if (!ext || !IMAGE_EXTENSIONS.has(ext)) {return false;}

  // Matches: absolute paths (/...), relative paths (./..., ../...), bare filenames
  if (/^(\/|\.\/|\.\.\/)/.test(trimmed)) {return true;}

  // Bare filename with image extension (no path separator)
  if (!trimmed.includes('/') && !trimmed.includes('\\')) {return true;}

  return false;
}

/**
 * Result of resolving card image paths.
 */
export interface ResolveCardImagesResult {
  /** The card JSON with local paths replaced by Feishu image_keys */
  card: Record<string, unknown>;
  /** Number of images successfully uploaded and replaced */
  uploadedCount: number;
  /** Number of images that failed to upload (gracefully degraded) */
  failedCount: number;
}

/**
 * Upload a local image file via IPC and return the Feishu image_key.
 *
 * @returns The image_key, or undefined if upload failed
 */
async function uploadAndGetImageKey(filePath: string): Promise<string | undefined> {
  try {
    // Resolve to absolute path
    const absolutePath = resolve(filePath);

    // Check file exists
    try {
      await fsp.access(absolutePath);
    } catch {
      logger.debug({ filePath: absolutePath }, 'Image file not found, skipping');
      return undefined;
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(absolutePath);

    if (result.success && result.imageKey) {
      logger.debug({ filePath: absolutePath, imageKey: result.imageKey }, 'Image uploaded successfully');
      return result.imageKey;
    }

    logger.warn({ filePath: absolutePath, error: result.error }, 'Image upload failed');
    return undefined;
  } catch (error) {
    logger.warn({ err: error, filePath }, 'Image upload error');
    return undefined;
  }
}

/**
 * Recursively walk a JSON object and replace local image paths with Feishu image_keys.
 *
 * Handles:
 * 1. `img` elements: `{ "tag": "img", "img_key": "/tmp/chart.png" }`
 *    → `{ "tag": "img", "img_key": "img_v3_xxx" }`
 *
 * 2. Markdown image references in `markdown` elements:
 *    `![alt](/tmp/chart.png)` → `![alt](img_v3_xxx)`
 *
 * Graceful degradation: If upload fails, replaces with text placeholder.
 */
export async function resolveCardImages(
  card: Record<string, unknown>,
): Promise<ResolveCardImagesResult> {
  let uploadedCount = 0;
  let failedCount = 0;

  // Clone card to avoid mutating input
  const result = JSON.parse(JSON.stringify(card)) as Record<string, unknown>;

  // Collect all local image paths that need uploading
  const pathToKey = new Map<string, string>();

  /**
   * Walk the JSON tree and collect local image paths.
   */
  function collectImagePaths(obj: unknown): void {
    if (!obj || typeof obj !== 'object') {return;}

    if (Array.isArray(obj)) {
      for (const item of obj) {
        collectImagePaths(item);
      }
      return;
    }

    const record = obj as Record<string, unknown>;

    // Detect img elements: { tag: "img", img_key: "/path/to/image.png" }
    if (record.tag === 'img' && typeof record.img_key === 'string') {
      if (isLocalImagePath(record.img_key)) {
        pathToKey.set(record.img_key, '');
      }
    }

    // Also check `img_key` in other contexts (e.g., standard image sections)
    if (typeof record.img_key === 'string' && isLocalImagePath(record.img_key) && record.tag !== 'img') {
      pathToKey.set(record.img_key, '');
    }

    // Detect markdown image references: ![alt](path)
    if (record.tag === 'markdown' && typeof record.content === 'string') {
      const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = mdImageRegex.exec(record.content)) !== null) {
        const [, , imagePath] = match;
        if (isLocalImagePath(imagePath)) {
          pathToKey.set(imagePath, '');
        }
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        collectImagePaths(value);
      }
    }
  }

  collectImagePaths(result);

  // Upload all unique local paths
  if (pathToKey.size > 0) {
    logger.info({ count: pathToKey.size }, 'Uploading card images');

    const uploadPromises = Array.from(pathToKey.keys()).map(async (filePath) => {
      const imageKey = await uploadAndGetImageKey(filePath);
      if (imageKey) {
        pathToKey.set(filePath, imageKey);
        uploadedCount++;
      } else {
        failedCount++;
      }
    });

    await Promise.all(uploadPromises);
  }

  /**
   * Walk the JSON tree and replace local paths with uploaded image_keys.
   */
  function replaceImagePaths(obj: unknown): void {
    if (!obj || typeof obj !== 'object') {return;}

    if (Array.isArray(obj)) {
      for (const item of obj) {
        replaceImagePaths(item);
      }
      return;
    }

    const record = obj as Record<string, unknown>;

    // Replace img_key in img elements and other contexts
    if (typeof record.img_key === 'string' && pathToKey.has(record.img_key)) {
      const imageKey = pathToKey.get(record.img_key);
      if (imageKey) {
        record.img_key = imageKey;
      } else {
        // Graceful degradation: replace with a placeholder
        record.img_key = 'img_v3_placeholder_upload_failed';
      }
    }

    // Replace markdown image references
    if (record.tag === 'markdown' && typeof record.content === 'string') {
      record.content = record.content.replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (match: string, alt: string, imagePath: string) => {
          if (pathToKey.has(imagePath)) {
            const imageKey = pathToKey.get(imagePath);
            if (imageKey) {
              return `![${alt}](${imageKey})`;
            }
            // Graceful degradation: keep as text
            return `[${alt}: image upload failed]`;
          }
          return match;
        },
      );
    }

    // Recurse into nested objects
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        replaceImagePaths(value);
      }
    }
  }

  replaceImagePaths(result);

  if (uploadedCount > 0 || failedCount > 0) {
    logger.info({ uploadedCount, failedCount }, 'Card image resolution complete');
  }

  return { card: result, uploadedCount, failedCount };
}
