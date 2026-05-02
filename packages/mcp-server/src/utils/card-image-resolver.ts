/**
 * Card image path resolver for auto-uploading local images.
 *
 * Scans Feishu card JSON for local image paths (in `img` elements and
 * markdown image syntax), uploads them via IPC, and replaces the paths
 * with Feishu image_keys.
 *
 * Issue #2951: send_card auto-uploads local image paths.
 *
 * @module mcp-server/utils/card-image-resolver
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, getIpcClient } from '@disclaude/core';

const logger = createLogger('CardImageResolver');

/**
 * Image file extensions supported by Feishu im.image.create API.
 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico']);

/**
 * Check if a string looks like a local file path that could be an image.
 *
 * Detects:
 * - Absolute paths: `/tmp/chart.png`, `/home/user/image.jpg`
 * - Relative paths: `./chart.png`, `../images/chart.png`
 * - Bare filenames with image extensions: `chart.png`
 *
 * Returns false for:
 * - Feishu image_keys (start with `img_v`)
 * - URLs (start with `http://` or `https://`)
 * - Non-image file extensions
 * - Empty strings
 */
export function isLocalImagePath(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  // Skip Feishu image_keys (e.g., "img_v3_0ca5_b123...")
  if (trimmed.startsWith('img_v')) {
    return false;
  }

  // Skip URLs
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return false;
  }

  // Skip data URIs
  if (trimmed.startsWith('data:')) {
    return false;
  }

  // Check for image extension
  const ext = path.extname(trimmed).toLowerCase();
  if (!ext || !IMAGE_EXTENSIONS.has(ext)) {
    return false;
  }

  // Must look like a path (starts with /, ./, ../ or is a bare filename with extension)
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    (/^[^/:\n]+$/.test(trimmed) && ext)
  ) {
    return true;
  }

  return false;
}

/**
 * Find all local image paths in a card JSON structure by recursively walking the object.
 *
 * Returns an array of references that can be used to replace the paths in-place.
 * Each reference has a `container`, `key`, and `filePath` property.
 *
 * Handles:
 * - `img` elements with `img_key` field
 * - `img` elements with `img` field (alternative key)
 *
 * Note: Markdown image syntax `![alt](path)` is handled separately by
 * `resolveMarkdownImagePaths`.
 */
export function findLocalImagePaths(
  obj: unknown,
  _container?: Record<string, unknown>,
  _key?: string
): Array<{ container: Record<string, unknown>; key: string; filePath: string }> {
  const results: Array<{ container: Record<string, unknown>; key: string; filePath: string }> = [];

  if (!obj || typeof obj !== 'object') {
    return results;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...findLocalImagePaths(obj[i], obj as unknown as Record<string, unknown>, String(i)));
    }
    return results;
  }

  const record = obj as Record<string, unknown>;

  // Check if this is an img element with a local path
  if (record.tag === 'img') {
    // Check img_key field
    const imgKey = record.img_key;
    if (typeof imgKey === 'string' && isLocalImagePath(imgKey)) {
      results.push({ container: record, key: 'img_key', filePath: imgKey });
    }
    // Check img field (alternative key used in some card formats)
    const {img} = record;
    if (typeof img === 'string' && isLocalImagePath(img)) {
      results.push({ container: record, key: 'img', filePath: img });
    }
  }

  // Recurse into all properties
  for (const [k, v] of Object.entries(record)) {
    if (v && typeof v === 'object') {
      results.push(...findLocalImagePaths(v, record, k));
    }
  }

  return results;
}

/**
 * Markdown image pattern: ![alt](path)
 * Captures the full match and the path group.
 */
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Find and resolve markdown image paths in card elements.
 *
 * Scans `markdown` tagged elements for `![alt](local/path.png)` syntax,
 * uploads the images, and replaces the paths with Feishu image syntax
 * using `img_key` references.
 *
 * Since Feishu markdown doesn't support inline images via markdown syntax,
 * we replace `![alt](/path/to/image.png)` with an `img` element placeholder.
 * However, inside markdown elements we can only modify the content string,
 * so we replace with `![alt](image_key)` format and let the caller handle
 * the conversion if needed.
 *
 * @returns Array of paths that were successfully resolved
 */
export async function resolveMarkdownImagePaths(
  card: Record<string, unknown>,
  uploadFn: (filePath: string) => Promise<string | undefined>
): Promise<Array<{ element: Record<string, unknown>; originalContent: string; resolvedContent: string }>> {
  const results: Array<{ element: Record<string, unknown>; originalContent: string; resolvedContent: string }> = [];

  if (!card || typeof card !== 'object') {
    return results;
  }

  const {elements} = card;
  if (!Array.isArray(elements)) {
    return results;
  }

  for (const element of elements) {
    if (!element || typeof element !== 'object') {
      continue;
    }

    const el = element as Record<string, unknown>;
    if (el.tag !== 'markdown' || typeof el.content !== 'string') {
      continue;
    }

    const content = el.content as string;
    let modified = content;
    let hasChanges = false;

    // Reset regex state for each element
    MARKDOWN_IMAGE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = MARKDOWN_IMAGE_REGEX.exec(content)) !== null) {
      const [, , imagePath] = match;
      if (!isLocalImagePath(imagePath)) {
        continue;
      }

      const imageKey = await uploadFn(imagePath);
      if (imageKey) {
        // Replace the local path with the Feishu image_key
        modified = modified.replace(match[0], `![${match[1]}](${imageKey})`);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      results.push({
        element: el,
        originalContent: content,
        resolvedContent: modified,
      });
      el.content = modified;
    }
  }

  return results;
}

/**
 * Result of resolving card image paths.
 */
export interface CardImageResolveResult {
  /** Number of local image paths found in the card */
  pathsFound: number;
  /** Number of images successfully uploaded and replaced */
  uploaded: number;
  /** Number of images that failed to upload (graceful degradation) */
  failed: number;
  /** The modified card with image_keys replacing local paths */
  card: Record<string, unknown>;
}

/**
 * Upload a single image via IPC and return the image_key.
 * Returns undefined if upload fails (graceful degradation).
 */
async function uploadImageViaIpc(filePath: string): Promise<string | undefined> {
  try {
    // Check if file exists before attempting upload
    if (!fs.existsSync(filePath)) {
      logger.debug({ filePath }, 'Image file does not exist, skipping');
      return undefined;
    }

    const ipcClient = getIpcClient();
    const result = await ipcClient.uploadImage(filePath);

    if (!result.success || !result.imageKey) {
      logger.warn({ filePath, error: result.error }, 'Image upload failed, keeping original path');
      return undefined;
    }

    logger.debug({ filePath, imageKey: result.imageKey }, 'Image uploaded successfully');
    return result.imageKey;
  } catch (error) {
    logger.warn({ err: error, filePath }, 'Image upload error, keeping original path');
    return undefined;
  }
}

/**
 * Resolve all local image paths in a card JSON structure.
 *
 * Scans for:
 * 1. `img` elements with local file paths in `img_key` field
 * 2. Markdown image syntax `![alt](/path/to/image.png)`
 *
 * For each local path found:
 * - Uploads the image via IPC to get a Feishu image_key
 * - Replaces the local path with the image_key
 * - On upload failure, keeps the original path (graceful degradation)
 *
 * Issue #2951: send_card auto-uploads local image paths.
 *
 * @param card - The Feishu card JSON structure
 * @returns Result with counts and the modified card
 */
export async function resolveCardImagePaths(card: Record<string, unknown>): Promise<CardImageResolveResult> {
  const result: CardImageResolveResult = {
    pathsFound: 0,
    uploaded: 0,
    failed: 0,
    card,
  };

  // 1. Resolve img element paths
  const imgRefs = findLocalImagePaths(card);
  result.pathsFound += imgRefs.length;

  for (const ref of imgRefs) {
    const imageKey = await uploadImageViaIpc(ref.filePath);
    if (imageKey) {
      ref.container[ref.key] = imageKey;
      result.uploaded++;
    } else {
      result.failed++;
    }
  }

  // 2. Resolve markdown image paths
  const mdResults = await resolveMarkdownImagePaths(card, uploadImageViaIpc);
  for (const md of mdResults) {
    // Count the number of local image references found in original content
    const originalMatches = md.originalContent.match(MARKDOWN_IMAGE_REGEX);
    const origCount = originalMatches?.length ?? 0;
    result.pathsFound += origCount;
    // Count remaining unresolved local paths (those that didn't get an img_v key)
    const remainingLocal = md.resolvedContent.match(/!\[[^\]]*\]\((?!img_v)[^)]+\)/g)?.length ?? 0;
    const changedCount = origCount - remainingLocal;
    result.uploaded += changedCount;
    result.failed += remainingLocal;
  }

  return result;
}
