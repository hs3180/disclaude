/**
 * Tests for file utility functions.
 *
 * Issue #1637: File extension detection for uploaded images.
 */

import { describe, it, expect } from 'vitest';
import { detectFileExtension, mimeToExtension, ensureFileExtension } from './file-utils.js';

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
    // GIF87a header
    const buffer = Buffer.from('GIF87a', 'ascii');
    expect(detectFileExtension(buffer)).toBe('.gif');
  });

  it('should detect GIF from magic bytes (GIF89a)', () => {
    // GIF89a header
    const buffer = Buffer.from('GIF89a', 'ascii');
    expect(detectFileExtension(buffer)).toBe('.gif');
  });

  it('should detect WebP from magic bytes', () => {
    // WebP header: RIFF....WEBP
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // file size
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectFileExtension(buffer)).toBe('.webp');
  });

  it('should detect BMP from magic bytes', () => {
    // BMP header: BM
    const buffer = Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.bmp');
  });

  it('should detect PDF from magic bytes', () => {
    // PDF header: %PDF
    const buffer = Buffer.from('%PDF-1.4', 'ascii');
    expect(detectFileExtension(buffer)).toBe('.pdf');
  });

  it('should detect ZIP from magic bytes', () => {
    // ZIP header: PK..
    const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.zip');
  });

  it('should detect TIFF (little-endian) from magic bytes', () => {
    // TIFF LE header: II*
    const buffer = Buffer.from([0x49, 0x49, 0x2A, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.tiff');
  });

  it('should detect TIFF (big-endian) from magic bytes', () => {
    // TIFF BE header: MM\0*
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

describe('ensureFileExtension', () => {
  it('should not modify path if extension already exists', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const result = ensureFileExtension('/tmp/photo.png', buffer);
    expect(result).toBe('/tmp/photo.png');
  });

  it('should append detected extension to extensionless path', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const result = ensureFileExtension('/tmp/image_v3_abc123', buffer);
    expect(result).toBe('/tmp/image_v3_abc123.png');
  });

  it('should append .jpg for JPEG files without extension', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const result = ensureFileExtension('/tmp/downloads/image_key', buffer);
    expect(result).toBe('/tmp/downloads/image_key.jpg');
  });

  it('should append .webp for WebP files without extension', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const result = ensureFileExtension('/tmp/workspace/downloads/img_file', buffer);
    expect(result).toBe('/tmp/workspace/downloads/img_file.webp');
  });

  it('should return original path if extension cannot be detected', () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = ensureFileExtension('/tmp/unknown_file', buffer);
    expect(result).toBe('/tmp/unknown_file');
  });

  it('should handle paths with dots in directory names', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const result = ensureFileExtension('/tmp/workspace.v2/downloads/image_key', buffer);
    expect(result).toBe('/tmp/workspace.v2/downloads/image_key.png');
  });
});
