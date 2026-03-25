/**
 * File Extension Detection Utility.
 *
 * Ensures downloaded files (especially images from Feishu) have the correct
 * file extension based on their actual content type.
 *
 * Issue #1637: Uploaded image files lose their original extension during
 * download because Feishu image messages only provide `image_key`, not the
 * original filename.
 *
 * @module utils/file-extension
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Mapping from MIME type (lowercase) to file extension (with dot).
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/html': '.html',
  'text/css': '.css',
  'text/xml': '.xml',
  'application/xml': '.xml',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

/**
 * Known image extensions (lowercase, with dot) for magic bytes detection.
 */
const KNOWN_EXTENSIONS = new Set(Object.values(MIME_TO_EXT));

/**
 * Magic bytes signatures for common file formats.
 * Each entry maps a detection function to a file extension.
 */
const MAGIC_SIGNATURES: Array<{ detect: (buf: Uint8Array) => boolean; ext: string }> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    detect: (buf) => buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
    ext: '.png',
  },
  // JPEG: FF D8 FF
  {
    detect: (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
    ext: '.jpg',
  },
  // GIF87a or GIF89a
  {
    detect: (buf) => buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38,
    ext: '.gif',
  },
  // WebP: RIFF....WEBP
  {
    detect: (buf) =>
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50,
    ext: '.webp',
  },
  // BMP: BM
  {
    detect: (buf) => buf[0] === 0x42 && buf[1] === 0x4d,
    ext: '.bmp',
  },
  // PDF: %PDF
  {
    detect: (buf) => buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46,
    ext: '.pdf',
  },
  // ZIP (also docx, xlsx, pptx, etc.): PK..
  {
    detect: (buf) => buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04,
    ext: '.zip',
  },
  // RAR: Rar!
  {
    detect: (buf) => buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21,
    ext: '.rar',
  },
];

/**
 * Detect file extension from magic bytes (file header signature).
 *
 * Reads the first 12 bytes of the file and checks against known signatures.
 *
 * @param filePath - Path to the downloaded file
 * @returns File extension (with dot) or undefined if detection fails
 */
export async function detectExtensionFromMagicBytes(filePath: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(12);
    await handle.read(buf, 0, 12, 0);
    await handle.close();

    const uint8 = new Uint8Array(buf);
    for (const sig of MAGIC_SIGNATURES) {
      if (sig.detect(uint8)) {
        return sig.ext;
      }
    }
  } catch {
    // File read failed, return undefined
  }
  return undefined;
}

/**
 * Extract content-type from HTTP response headers.
 * Handles various header key casing conventions.
 *
 * @param headers - Response headers object (e.g., from Feishu SDK response.headers)
 * @returns Content-type string or undefined
 */
export function getContentTypeFromHeaders(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined;

  // Try common casing variations
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-type') {
      const value = headers[key];
      if (typeof value === 'string') {
        // Extract MIME type from potential "type/subtype; charset=..." format
        return value.split(';')[0].trim().toLowerCase();
      }
    }
  }
  return undefined;
}

/**
 * Ensure a downloaded file has the correct extension based on its content type.
 *
 * Resolution strategy:
 * 1. If the file already has a known extension → return path as-is
 * 2. Try to determine extension from response headers (content-type)
 * 3. Fall back to magic bytes detection from the file itself
 * 4. If no extension can be determined → return path as-is
 *
 * When an extension is determined, the file is renamed and the new path is returned.
 *
 * @param filePath - Current path of the downloaded file
 * @param headers - Optional response headers for content-type detection
 * @returns The (possibly renamed) file path with correct extension
 */
export async function ensureFileExtension(
  filePath: string,
  headers?: Record<string, unknown>,
): Promise<string> {
  // Check if file already has a known extension
  const currentExt = path.extname(filePath).toLowerCase();
  if (currentExt && KNOWN_EXTENSIONS.has(currentExt)) {
    return filePath;
  }

  // Strategy 1: Content-type from headers
  const contentType = getContentTypeFromHeaders(headers);
  if (contentType) {
    const extFromMime = MIME_TO_EXT[contentType];
    if (extFromMime) {
      return await renameWithExtension(filePath, extFromMime);
    }
  }

  // Strategy 2: Magic bytes detection
  const extFromMagic = await detectExtensionFromMagicBytes(filePath);
  if (extFromMagic) {
    return await renameWithExtension(filePath, extFromMagic);
  }

  // No extension could be determined — return as-is
  return filePath;
}

/**
 * Rename a file by appending the given extension.
 * If a file with the target name already exists, overwrite it.
 *
 * @param filePath - Current file path
 * @param ext - Extension to append (with dot, e.g., '.png')
 * @returns New file path after rename
 */
async function renameWithExtension(filePath: string, ext: string): Promise<string> {
  const newPath = filePath + ext;
  try {
    await fs.rename(filePath, newPath);
    return newPath;
  } catch (renameError) {
    // If rename fails (e.g., cross-device link), try copy + delete
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
