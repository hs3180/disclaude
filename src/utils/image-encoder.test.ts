/**
 * Tests for Image Encoder.
 *
 * Issue #656: 增强多模态图片支持
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  encodeImageToBase64,
  encodeImages,
  isSupportedImageFormat,
  isImageFile,
  SUPPORTED_IMAGE_FORMATS,
  DEFAULT_MAX_IMAGE_SIZE,
} from './image-encoder.js';

describe('ImageEncoder', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-encoder-test-'));
  });

  afterAll(async () => {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('isSupportedImageFormat', () => {
    it('should return true for supported formats', () => {
      expect(isSupportedImageFormat('image/png')).toBe(true);
      expect(isSupportedImageFormat('image/jpeg')).toBe(true);
      expect(isSupportedImageFormat('image/gif')).toBe(true);
      expect(isSupportedImageFormat('image/webp')).toBe(true);
    });

    it('should return false for unsupported formats', () => {
      expect(isSupportedImageFormat('image/bmp')).toBe(false);
      expect(isSupportedImageFormat('image/tiff')).toBe(false);
      expect(isSupportedImageFormat('application/pdf')).toBe(false);
      expect(isSupportedImageFormat(undefined)).toBe(false);
    });
  });

  describe('isImageFile', () => {
    it('should detect image files by extension', () => {
      expect(isImageFile('/path/to/image.png')).toBe(true);
      expect(isImageFile('/path/to/photo.jpg')).toBe(true);
      expect(isImageFile('/path/to/animation.gif')).toBe(true);
      expect(isImageFile('/path/to/modern.webp')).toBe(true);
    });

    it('should detect image files by MIME type', () => {
      expect(isImageFile('/path/to/file', 'image/png')).toBe(true);
      expect(isImageFile('/path/to/file', 'image/jpeg')).toBe(true);
    });

    it('should return false for non-image files', () => {
      expect(isImageFile('/path/to/document.pdf')).toBe(false);
      expect(isImageFile('/path/to/data.json')).toBe(false);
      expect(isImageFile('/path/to/file.txt')).toBe(false);
    });
  });

  describe('encodeImageToBase64', () => {
    it('should encode a valid PNG image', async () => {
      // Create a minimal valid PNG file (1x1 pixel)
      // PNG magic number + minimal IHDR + IDAT + IEND
      const minimalPng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, // IHDR length
        0x49, 0x48, 0x44, 0x52, // IHDR type
        0x00, 0x00, 0x00, 0x01, // width: 1
        0x00, 0x00, 0x00, 0x01, // height: 1
        0x08, 0x02, // bit depth: 8, color type: RGB
        0x00, 0x00, 0x00, // compression, filter, interlace
        0x90, 0x77, 0x53, 0xDE, // CRC
        0x00, 0x00, 0x00, 0x0C, // IDAT length
        0x49, 0x44, 0x41, 0x54, // IDAT type
        0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F, 0x00, // compressed data
        0x05, 0xFE, 0x02, 0xFE, // CRC
        0x00, 0x00, 0x00, 0x00, // IEND length
        0x49, 0x45, 0x4E, 0x44, // IEND type
        0xAE, 0x42, 0x60, 0x82, // CRC
      ]);

      const testFile = path.join(tempDir, 'test.png');
      await fs.writeFile(testFile, minimalPng);

      const result = await encodeImageToBase64(testFile);

      expect(result.mimeType).toBe('image/png');
      expect(result.data).toBeDefined();
      expect(result.originalSize).toBe(minimalPng.length);
      expect(result.encodedSize).toBe(result.data.length);
      expect(result.data).toBe(minimalPng.toString('base64'));
    });

    it('should encode a valid JPEG image', async () => {
      // Create a minimal valid JPEG file
      const minimalJpeg = Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0, // SOI + APP0 marker
        0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, // JFIF identifier
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xFF, 0xDB, 0x00, 0x43, 0x00, // DQT
        // Minimal quantization table (simplified)
        ...Array(64).fill(0x10),
        0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, // SOF0
        0x01, 0x01, 0x11, 0x00,
        0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01, // DHT
        ...Array(16).fill(0x00),
        0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, // SOS
        0x00, // Scan data (empty)
        0xFF, 0xD9, // EOI
      ]);

      const testFile = path.join(tempDir, 'test.jpg');
      await fs.writeFile(testFile, minimalJpeg);

      const result = await encodeImageToBase64(testFile);

      expect(result.mimeType).toBe('image/jpeg');
      expect(result.data).toBeDefined();
    });

    it('should throw error for non-existent file', async () => {
      await expect(
        encodeImageToBase64('/nonexistent/path/image.png')
      ).rejects.toThrow();
    });

    it('should throw error for unsupported format', async () => {
      const testFile = path.join(tempDir, 'test.bmp');
      await fs.writeFile(testFile, Buffer.from('fake bmp content'));

      await expect(
        encodeImageToBase64(testFile)
      ).rejects.toThrow('Unsupported image format');
    });

    it('should throw error for files exceeding size limit', async () => {
      const testFile = path.join(tempDir, 'large.png');
      // Create a file larger than the limit
      const largeContent = Buffer.alloc(1000); // 1000 bytes
      await fs.writeFile(testFile, largeContent);

      await expect(
        encodeImageToBase64(testFile, { maxSizeBytes: 100 })
      ).rejects.toThrow('too large');
    });

    it('should respect verbose option', async () => {
      const minimalPng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
        0x08, 0x02,
        0x00, 0x00, 0x00,
        0x90, 0x77, 0x53, 0xDE,
        0x00, 0x00, 0x00, 0x0C,
        0x49, 0x44, 0x41, 0x54,
        0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F, 0x00,
        0x05, 0xFE, 0x02, 0xFE,
        0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4E, 0x44,
        0xAE, 0x42, 0x60, 0x82,
      ]);

      const testFile = path.join(tempDir, 'verbose.png');
      await fs.writeFile(testFile, minimalPng);

      // Should not throw with verbose mode
      const result = await encodeImageToBase64(testFile, { verbose: true });
      expect(result).toBeDefined();
    });
  });

  describe('encodeImages', () => {
    it('should encode multiple images', async () => {
      const minimalPng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
        0x08, 0x02,
        0x00, 0x00, 0x00,
        0x90, 0x77, 0x53, 0xDE,
        0x00, 0x00, 0x00, 0x0C,
        0x49, 0x44, 0x41, 0x54,
        0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F, 0x00,
        0x05, 0xFE, 0x02, 0xFE,
        0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4E, 0x44,
        0xAE, 0x42, 0x60, 0x82,
      ]);

      const file1 = path.join(tempDir, 'multi1.png');
      const file2 = path.join(tempDir, 'multi2.png');
      await fs.writeFile(file1, minimalPng);
      await fs.writeFile(file2, minimalPng);

      const results = await encodeImages([file1, file2]);

      expect(results).toHaveLength(2);
      expect(results[0].mimeType).toBe('image/png');
      expect(results[1].mimeType).toBe('image/png');
    });

    it('should skip files that fail to encode', async () => {
      const minimalPng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
        0x08, 0x02,
        0x00, 0x00, 0x00,
        0x90, 0x77, 0x53, 0xDE,
        0x00, 0x00, 0x00, 0x0C,
        0x49, 0x44, 0x41, 0x54,
        0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F, 0x00,
        0x05, 0xFE, 0x02, 0xFE,
        0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4E, 0x44,
        0xAE, 0x42, 0x60, 0x82,
      ]);

      const validFile = path.join(tempDir, 'valid.png');
      const invalidFile = path.join(tempDir, 'invalid.bmp');
      const nonExistentFile = path.join(tempDir, 'nonexistent.png');

      await fs.writeFile(validFile, minimalPng);
      await fs.writeFile(invalidFile, Buffer.from('not an image'));

      const results = await encodeImages([validFile, invalidFile, nonExistentFile]);

      // Only the valid PNG should be encoded
      expect(results).toHaveLength(1);
      expect(results[0].mimeType).toBe('image/png');
    });
  });

  describe('Constants', () => {
    it('should have correct supported formats', () => {
      expect(SUPPORTED_IMAGE_FORMATS).toContain('image/png');
      expect(SUPPORTED_IMAGE_FORMATS).toContain('image/jpeg');
      expect(SUPPORTED_IMAGE_FORMATS).toContain('image/gif');
      expect(SUPPORTED_IMAGE_FORMATS).toContain('image/webp');
    });

    it('should have reasonable default max size', () => {
      expect(DEFAULT_MAX_IMAGE_SIZE).toBe(10 * 1024 * 1024); // 10MB
    });
  });
});
