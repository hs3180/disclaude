/**
 * Tests for file utility functions.
 *
 * Issue #1637: File extension detection for uploaded images.
 * Enhancement: headers-based detection, SVG optimization, async path-based API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  detectFileExtension,
  mimeToExtension,
  getContentTypeFromHeaders,
  ensureFileExtension,
  ensureFileExtensionFromPath,
} from './file-utils.js';

describe('detectFileExtension', () => {
  it('should detect PNG from magic bytes', () => {
    // PNG header: 89 50 4E 47 0D 0A 1A 0A
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.png');
  });

  it('should detect JPEG from magic bytes', () => {
    // JPEG header: FF D8 FF
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    expect(detectFileExtension(buffer)).toBe('.jpg');
  });

  it('should detect GIF from magic bytes (GIF87a)', () => {
    const buffer = Buffer.from('GIF87a', 'ascii');
    expect(detectFileExtension(buffer)).toBe('.gif');
  });

  it('should detect GIF from magic bytes (GIF89a)', () => {
    const buffer = Buffer.from('GIF89a', 'ascii');
    expect(detectFileExtension(buffer)).toBe('.gif');
  });

  it('should detect WebP from magic bytes', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectFileExtension(buffer)).toBe('.webp');
  });

  it('should detect BMP from magic bytes', () => {
    const buffer = Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.bmp');
  });

  it('should detect PDF from magic bytes', () => {
    const buffer = Buffer.from('%PDF-1.4', 'ascii');
    expect(detectFileExtension(buffer)).toBe('.pdf');
  });

  it('should detect ZIP from magic bytes', () => {
    const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.zip');
  });

  it('should detect TIFF (little-endian) from magic bytes', () => {
    const buffer = Buffer.from([0x49, 0x49, 0x2A, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.tiff');
  });

  it('should detect TIFF (big-endian) from magic bytes', () => {
    const buffer = Buffer.from([0x4D, 0x4D, 0x00, 0x2A]);
    expect(detectFileExtension(buffer)).toBe('.tiff');
  });

  it('should detect SVG from XML declaration', () => {
    const buffer = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg">', 'utf-8');
    expect(detectFileExtension(buffer)).toBe('.svg');
  });

  it('should detect SVG from <svg tag', () => {
    const buffer = Buffer.from('<svg width="100" height="100">', 'utf-8');
    expect(detectFileExtension(buffer)).toBe('.svg');
  });

  // Enhancement: SVG detection only uses first 100 bytes
  it('should detect SVG even with long content (100-byte optimization)', () => {
    const content = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">' + 'x'.repeat(200);
    const buffer = Buffer.from(content, 'utf-8');
    expect(detectFileExtension(buffer)).toBe('.svg');
  });

  it('should return undefined for unrecognized format', () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectFileExtension(buffer)).toBeUndefined();
  });

  it('should return undefined for empty buffer', () => {
    const buffer = Buffer.alloc(0);
    expect(detectFileExtension(buffer)).toBeUndefined();
  });

  it('should return undefined for too-short buffer', () => {
    const buffer = Buffer.from([0x89, 0x50]); // Incomplete PNG header
    expect(detectFileExtension(buffer)).toBeUndefined();
  });
});

describe('mimeToExtension', () => {
  it('should map image/png to .png', () => {
    expect(mimeToExtension('image/png')).toBe('.png');
  });

  it('should map image/jpeg to .jpg', () => {
    expect(mimeToExtension('image/jpeg')).toBe('.jpg');
  });

  it('should map image/gif to .gif', () => {
    expect(mimeToExtension('image/gif')).toBe('.gif');
  });

  it('should map image/webp to .webp', () => {
    expect(mimeToExtension('image/webp')).toBe('.webp');
  });

  it('should map image/svg+xml to .svg', () => {
    expect(mimeToExtension('image/svg+xml')).toBe('.svg');
  });

  it('should return undefined for unknown MIME type', () => {
    expect(mimeToExtension('application/unknown')).toBeUndefined();
  });
});

// Enhancement: getContentTypeFromHeaders
describe('getContentTypeFromHeaders', () => {
  it('extracts content-type from lowercase headers', () => {
    expect(getContentTypeFromHeaders({ 'content-type': 'image/png' })).toBe('image/png');
  });

  it('extracts content-type from mixed-case headers', () => {
    expect(getContentTypeFromHeaders({ 'Content-Type': 'image/jpeg; charset=utf-8' })).toBe('image/jpeg');
  });

  it('strips parameters from content-type', () => {
    expect(getContentTypeFromHeaders({ 'content-type': 'image/gif; boundary=something' })).toBe('image/gif');
  });

  it('returns undefined for undefined headers', () => {
    expect(getContentTypeFromHeaders(undefined)).toBeUndefined();
  });

  it('returns undefined for empty headers', () => {
    expect(getContentTypeFromHeaders({})).toBeUndefined();
  });

  it('returns undefined when content-type is not string', () => {
    expect(getContentTypeFromHeaders({ 'content-type': 123 })).toBeUndefined();
  });
});

describe('ensureFileExtension', () => {
  it('should not modify path if known extension already exists', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(ensureFileExtension('/tmp/photo.png', buffer)).toBe('/tmp/photo.png');
  });

  it('should not modify path if unknown extension exists', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    // .dat is not a known extension, but file has an extension → should still detect
    expect(ensureFileExtension('/tmp/photo.dat', buffer)).toBe('/tmp/photo.dat.png');
  });

  it('should append detected extension to extensionless path', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(ensureFileExtension('/tmp/image_v3_abc123', buffer)).toBe('/tmp/image_v3_abc123.png');
  });

  it('should append .jpg for JPEG files without extension', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    expect(ensureFileExtension('/tmp/downloads/image_key', buffer)).toBe('/tmp/downloads/image_key.jpg');
  });

  it('should append .webp for WebP files without extension', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(ensureFileExtension('/tmp/workspace/downloads/img_file', buffer)).toBe('/tmp/workspace/downloads/img_file.webp');
  });

  it('should return original path if extension cannot be detected', () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(ensureFileExtension('/tmp/unknown_file', buffer)).toBe('/tmp/unknown_file');
  });

  it('should handle paths with dots in directory names', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(ensureFileExtension('/tmp/workspace.v2/downloads/image_key', buffer)).toBe('/tmp/workspace.v2/downloads/image_key.png');
  });
});

// Enhancement: ensureFileExtensionFromPath (async, path-based API)
describe('ensureFileExtensionFromPath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-ext-enh-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return original path if file has a known extension', async () => {
    const filePath = path.join(tmpDir, 'photo.png');
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    const result = await ensureFileExtensionFromPath(filePath);
    expect(result).toBe(filePath);
  });

  it('should add extension from content-type header', async () => {
    const filePath = path.join(tmpDir, 'image_no_ext');
    await fs.writeFile(filePath, Buffer.from('fake data'));
    const headers = { 'content-type': 'image/png' };
    const result = await ensureFileExtensionFromPath(filePath, headers);
    expect(result).toBe(filePath + '.png');
    await expect(fs.access(result)).resolves.toBeUndefined();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('should add extension from content-type with charset parameter', async () => {
    const filePath = path.join(tmpDir, 'image_no_ext');
    await fs.writeFile(filePath, Buffer.from('fake data'));
    const headers = { 'Content-Type': 'image/jpeg; charset=binary' };
    const result = await ensureFileExtensionFromPath(filePath, headers);
    expect(result).toBe(filePath + '.jpg');
  });

  it('should fall back to magic bytes when headers are missing', async () => {
    const filePath = path.join(tmpDir, 'image_no_ext');
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    await fs.writeFile(filePath, Buffer.concat([pngHeader, Buffer.alloc(100, 0x00)]));
    const result = await ensureFileExtensionFromPath(filePath);
    expect(result).toBe(filePath + '.png');
  });

  it('should prefer headers over magic bytes', async () => {
    const filePath = path.join(tmpDir, 'image_no_ext');
    // JPEG content with PNG content-type
    const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    await fs.writeFile(filePath, Buffer.concat([jpegHeader, Buffer.alloc(100, 0x00)]));
    const headers = { 'content-type': 'image/png' };
    const result = await ensureFileExtensionFromPath(filePath, headers);
    expect(result).toBe(filePath + '.png');
  });

  it('should fall back to magic bytes when content-type is unknown', async () => {
    const filePath = path.join(tmpDir, 'image_no_ext');
    const gifHeader = Buffer.from('GIF87a');
    await fs.writeFile(filePath, Buffer.concat([gifHeader, Buffer.alloc(100, 0x00)]));
    const headers = { 'content-type': 'application/unknown' };
    const result = await ensureFileExtensionFromPath(filePath, headers);
    expect(result).toBe(filePath + '.gif');
  });

  it('should return original path when extension cannot be determined', async () => {
    const filePath = path.join(tmpDir, 'unknown_file');
    await fs.writeFile(filePath, Buffer.from('plain text content'));
    const result = await ensureFileExtensionFromPath(filePath);
    expect(result).toBe(filePath);
  });

  it('should return original path for non-existent file', async () => {
    const filePath = path.join(tmpDir, 'nonexistent');
    const result = await ensureFileExtensionFromPath(filePath);
    expect(result).toBe(filePath);
  });

  it('should handle the real Feishu scenario', async () => {
    const filePath = path.join(tmpDir, 'image_img_v3_02104_b73cd122-662d-4ea5-a184-82f1dabc3e2g');
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    await fs.writeFile(filePath, Buffer.concat([pngHeader, Buffer.alloc(100, 0x00)]));
    const result = await ensureFileExtensionFromPath(filePath);
    expect(result).toBe(filePath + '.png');
    await expect(fs.access(result)).resolves.toBeUndefined();
  });
});
