/**
 * File utility functions.
 *
 * Provides file type detection from magic bytes and file extension utilities.
 *
 * Issue #1637: Add file extension detection for uploaded images.
 */

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
  {
    detect: (buf) => {
      const header = buf.subarray(0, Math.min(buf.length, 256)).toString('utf-8').trim();
      return header.startsWith('<?xml') || header.toLowerCase().startsWith('<svg');
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
 * Ensure a file has the correct extension based on its content.
 *
 * If the file already has an extension, returns the original path.
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
  // If file already has an extension, return as-is
  // Use path.extname to correctly handle dots in directory names
  if (path.extname(filePath)) {
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
