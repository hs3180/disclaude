/**
 * File utility functions.
 *
 * Provides file type detection from magic bytes, MIME headers, and file extension utilities.
 *
 * Issue #1637: Add file extension detection for uploaded images.
 * Enhancement: Add headers-based detection, SVG optimization, async path-based API.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * MIME type to file extension mapping.
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'application/json': '.json',
};

/**
 * Known extensions (lowercase, with dot) for extension validation.
 */
const KNOWN_EXTENSIONS = new Set(Object.values(MIME_TO_EXTENSION));

/**
 * Magic bytes signatures for common file types.
 * Each entry maps a detection function to a file extension.
 */
const MAGIC_BYTE_SIGNATURES: Array<{ detect: (buf: Buffer) => boolean; ext: string }> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    detect: (buf) => buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A,
    ext: '.png',
  },
  // JPEG: FF D8 FF
  {
    detect: (buf) => buf.length >= 3 &&
      buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF,
    ext: '.jpg',
  },
  // GIF: 47 49 46 38 (GIF8)
  {
    detect: (buf) => buf.length >= 4 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38,
    ext: '.gif',
  },
  // WebP: 52 49 46 46 .... 57 45 42 50 (RIFF....WEBP)
  {
    detect: (buf) => buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50,
    ext: '.webp',
  },
  // BMP: 42 4D (BM)
  {
    detect: (buf) => buf.length >= 2 &&
      buf[0] === 0x42 && buf[1] === 0x4D,
    ext: '.bmp',
  },
  // PDF: 25 50 44 46 (%PDF)
  {
    detect: (buf) => buf.length >= 4 &&
      buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46,
    ext: '.pdf',
  },
  // ZIP: 50 4B 03 04 (PK..)
  {
    detect: (buf) => buf.length >= 4 &&
      buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04,
    ext: '.zip',
  },
  // TIFF (little-endian): 49 49 2A 00 (II*)
  {
    detect: (buf) => buf.length >= 4 &&
      buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00,
    ext: '.tiff',
  },
  // TIFF (big-endian): 4D 4D 00 2A (MM\0*)
  {
    detect: (buf) => buf.length >= 4 &&
      buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A,
    ext: '.tiff',
  },
  // SVG (text-based): check for XML declaration or <svg tag
  // Optimized: only inspect first 100 bytes instead of 256
  {
    detect: (buf) => {
      const len = Math.min(buf.length, 100);
      const header = buf.subarray(0, len).toString('utf-8').trimStart();
      return header.startsWith('<?xml') || header.startsWith('<svg');
    },
    ext: '.svg',
  },
];

/**
 * Detect file extension from magic bytes (binary file header).
 *
 * This function reads the first bytes of a file to determine its actual type,
 * independent of the filename. It supports common image, document, and archive formats.
 *
 * @param buffer - File content buffer (at least first 12 bytes should be present)
 * @returns The detected file extension (with leading dot, e.g., '.png'), or undefined if unrecognized
 *
 * @example
 * ```typescript
 * const buffer = await fs.readFile('mystery-file');
 * const ext = detectFileExtension(buffer);
 * // ext === '.png' for a PNG file
 * ```
 */
export function detectFileExtension(buffer: Buffer): string | undefined {
  for (const { detect, ext } of MAGIC_BYTE_SIGNATURES) {
    if (detect(buffer)) {
      return ext;
    }
  }
  return undefined;
}

/**
 * Map a MIME type string to a file extension.
 *
 * @param mimeType - MIME type string (e.g., 'image/png')
 * @returns The corresponding file extension (e.g., '.png'), or undefined if unknown
 *
 * @example
 * ```typescript
 * const ext = mimeToExtension('image/jpeg');
 * // ext === '.jpg'
 * ```
 */
export function mimeToExtension(mimeType: string): string | undefined {
  return MIME_TO_EXTENSION[mimeType];
}

/**
 * Extract content-type from HTTP response headers.
 * Handles various header key casing conventions and strips parameters.
 *
 * @param headers - Response headers object (e.g., from Feishu SDK response.headers)
 * @returns Content-type string (lowercase, without parameters) or undefined
 */
export function getContentTypeFromHeaders(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined;

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-type') {
      const value = headers[key];
      if (typeof value === 'string') {
        return value.split(';')[0].trim().toLowerCase();
      }
    }
  }
  return undefined;
}

/**
 * Ensure a file has the correct extension based on its content.
 *
 * If the file already has a known extension, returns the original path.
 * If not, detects the file type from magic bytes and appends the correct extension.
 *
 * @param filePath - Current file path (may or may not have an extension)
 * @param buffer - File content buffer for magic bytes detection
 * @returns The corrected file path (may include a new extension)
 *
 * @example
 * ```typescript
 * const newPath = ensureFileExtension('/tmp/downloads/image_v3_abc123', buffer);
 * // newPath === '/tmp/downloads/image_v3_abc123.png' for a PNG file
 * ```
 */
export function ensureFileExtension(filePath: string, buffer: Buffer): string {
  // If file already has a known extension, return as-is
  const currentExt = path.extname(filePath).toLowerCase();
  if (currentExt && KNOWN_EXTENSIONS.has(currentExt)) {
    return filePath;
  }

  // Detect extension from magic bytes
  const detectedExt = detectFileExtension(buffer);
  if (detectedExt) {
    return `${filePath}${detectedExt}`;
  }

  // Unable to detect, return original path
  return filePath;
}

/**
 * Ensure a file has the correct extension based on its content.
 *
 * Async variant that reads the file directly, eliminating the need for callers
 * to handle file I/O. Uses a two-strategy detection approach:
 *
 * 1. **Headers** (if provided): Extract extension from Content-Type header
 * 2. **Magic bytes** (fallback): Read first 12 bytes and check against known signatures
 *
 * When an extension is determined, the file is renamed and the new path is returned.
 * If the file already has a known extension, or no type can be detected, returns the
 * original path unchanged.
 *
 * @param filePath - Current path of the downloaded file
 * @param headers - Optional response headers for content-type detection
 * @returns The (possibly renamed) file path with correct extension
 *
 * @example
 * ```typescript
 * const newPath = await ensureFileExtensionFromPath('/tmp/downloads/image_v3_abc', headers);
 * // newPath === '/tmp/downloads/image_v3_abc.png'
 * ```
 */
export async function ensureFileExtensionFromPath(
  filePath: string,
  headers?: Record<string, unknown>,
): Promise<string> {
  // If file already has a known extension, return as-is
  const currentExt = path.extname(filePath).toLowerCase();
  if (currentExt && KNOWN_EXTENSIONS.has(currentExt)) {
    return filePath;
  }

  // Strategy 1: Content-type from headers (avoids file I/O entirely)
  const contentType = getContentTypeFromHeaders(headers);
  if (contentType) {
    const extFromMime = MIME_TO_EXTENSION[contentType];
    if (extFromMime) {
      return await renameWithExtension(filePath, extFromMime);
    }
  }

  // Strategy 2: Magic bytes detection (read only first 12 bytes)
  try {
    const fd = await fs.open(filePath, 'r');
    const header = Buffer.alloc(12);
    await fd.read(header, 0, 12, 0);
    await fd.close();

    const detectedExt = detectFileExtension(header);
    if (detectedExt) {
      return await renameWithExtension(filePath, detectedExt);
    }
  } catch {
    // File read failed — return original path
  }

  // No extension could be determined — return as-is
  return filePath;
}

/**
 * Rename a file by appending the given extension.
 * Gracefully degrades on failure (returns original path).
 *
 * @param filePath - Current file path
 * @param ext - Extension to append (with dot, e.g., '.png')
 * @returns New file path after rename, or original path on failure
 */
async function renameWithExtension(filePath: string, ext: string): Promise<string> {
  const newPath = filePath + ext;
  try {
    await fs.rename(filePath, newPath);
    return newPath;
  } catch {
    // Rename may fail (e.g., cross-device link) — try copy + delete
    try {
      await fs.copyFile(filePath, newPath);
      await fs.unlink(filePath);
      return newPath;
    } catch {
      // Last resort: return original path
      return filePath;
    }
  }
}
