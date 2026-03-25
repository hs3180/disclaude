/**
 * Unit tests for file-extension.ts
 *
 * Issue #1637: Verify file extension detection and correction logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  detectExtensionFromMagicBytes,
  getContentTypeFromHeaders,
  ensureFileExtension,
} from './file-extension.js';

describe('file-extension', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-ext-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getContentTypeFromHeaders', () => {
    it('extracts content-type from lowercase headers', () => {
      const headers = { 'content-type': 'image/png' };
      expect(getContentTypeFromHeaders(headers)).toBe('image/png');
    });

    it('extracts content-type from mixed-case headers', () => {
      const headers = { 'Content-Type': 'image/jpeg; charset=utf-8' };
      expect(getContentTypeFromHeaders(headers)).toBe('image/jpeg');
    });

    it('extracts content-type from uppercase headers', () => {
      const headers = { 'CONTENT-TYPE': 'image/webp' };
      expect(getContentTypeFromHeaders(headers)).toBe('image/webp');
    });

    it('strips parameters from content-type', () => {
      const headers = { 'content-type': 'image/gif; boundary=something' };
      expect(getContentTypeFromHeaders(headers)).toBe('image/gif');
    });

    it('returns undefined for undefined headers', () => {
      expect(getContentTypeFromHeaders(undefined)).toBeUndefined();
    });

    it('returns undefined for empty headers', () => {
      expect(getContentTypeFromHeaders({})).toBeUndefined();
    });

    it('returns undefined when content-type is not string', () => {
      const headers = { 'content-type': 123 };
      expect(getContentTypeFromHeaders(headers)).toBeUndefined();
    });
  });

  describe('detectExtensionFromMagicBytes', () => {
    it('detects PNG files', async () => {
      const filePath = path.join(tmpDir, 'test_file');
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.writeFile(filePath, Buffer.concat([pngHeader, Buffer.from('fake data')]));
      expect(await detectExtensionFromMagicBytes(filePath)).toBe('.png');
    });

    it('detects JPEG files', async () => {
      const filePath = path.join(tmpDir, 'test_file');
      // JPEG magic bytes: FF D8 FF
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      await fs.writeFile(filePath, Buffer.concat([jpegHeader, Buffer.from('fake data')]));
      expect(await detectExtensionFromMagicBytes(filePath)).toBe('.jpg');
    });

    it('detects GIF files', async () => {
      const filePath = path.join(tmpDir, 'test_file');
      // GIF89a magic bytes
      const gifHeader = Buffer.from('GIF89a');
      await fs.writeFile(filePath, Buffer.concat([gifHeader, Buffer.from('fake data')]));
      expect(await detectExtensionFromMagicBytes(filePath)).toBe('.gif');
    });

    it('detects WebP files', async () => {
      const filePath = path.join(tmpDir, 'test_file');
      // RIFF....WEBP
      const webpHeader = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
      await fs.writeFile(filePath, Buffer.concat([webpHeader, Buffer.from('fake data')]));
      expect(await detectExtensionFromMagicBytes(filePath)).toBe('.webp');
    });

    it('detects PDF files', async () => {
      const filePath = path.join(tmpDir, 'test_file');
      // PDF: %PDF
      const pdfHeader = Buffer.from('%PDF-1.4');
      await fs.writeFile(filePath, Buffer.concat([pdfHeader, Buffer.from('fake data')]));
      expect(await detectExtensionFromMagicBytes(filePath)).toBe('.pdf');
    });

    it('detects ZIP files', async () => {
      const filePath = path.join(tmpDir, 'test_file');
      // ZIP: PK\x03\x04
      const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      await fs.writeFile(filePath, Buffer.concat([zipHeader, Buffer.from('fake data')]));
      expect(await detectExtensionFromMagicBytes(filePath)).toBe('.zip');
    });

    it('returns undefined for unrecognized formats', async () => {
      const filePath = path.join(tmpDir, 'test_file');
      await fs.writeFile(filePath, Buffer.from('this is just plain text data'));
      expect(await detectExtensionFromMagicBytes(filePath)).toBeUndefined();
    });

    it('returns undefined for non-existent files', async () => {
      const filePath = path.join(tmpDir, 'nonexistent');
      expect(await detectExtensionFromMagicBytes(filePath)).toBeUndefined();
    });
  });

  describe('ensureFileExtension', () => {
    it('returns original path if file already has a known extension', async () => {
      const filePath = path.join(tmpDir, 'photo.png');
      await fs.writeFile(filePath, Buffer.from('fake png data'));
      const result = await ensureFileExtension(filePath);
      expect(result).toBe(filePath);
    });

    it('returns original path if file has .jpg extension', async () => {
      const filePath = path.join(tmpDir, 'photo.jpg');
      await fs.writeFile(filePath, Buffer.from('fake jpeg data'));
      const result = await ensureFileExtension(filePath);
      expect(result).toBe(filePath);
    });

    it('adds extension from content-type header', async () => {
      const filePath = path.join(tmpDir, 'image_img_v3_02104');
      await fs.writeFile(filePath, Buffer.from('fake data'));
      const headers = { 'content-type': 'image/png' };
      const result = await ensureFileExtension(filePath, headers);
      expect(result).toBe(filePath + '.png');
      // Verify the file was renamed
      await expect(fs.access(result)).resolves.toBeUndefined();
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('falls back to magic bytes when headers are missing', async () => {
      const filePath = path.join(tmpDir, 'image_img_v3_02104');
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.writeFile(filePath, Buffer.concat([pngHeader, Buffer.from('fake data')]));
      const result = await ensureFileExtension(filePath);
      expect(result).toBe(filePath + '.png');
    });

    it('prefers headers over magic bytes', async () => {
      const filePath = path.join(tmpDir, 'image_img_v3_02104');
      // JPEG content with PNG content-type (unlikely in practice but tests priority)
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      await fs.writeFile(filePath, Buffer.concat([jpegHeader, Buffer.from('fake data')]));
      const headers = { 'content-type': 'image/png' };
      const result = await ensureFileExtension(filePath, headers);
      // Headers take priority
      expect(result).toBe(filePath + '.png');
    });

    it('falls back to magic bytes when content-type is unknown', async () => {
      const filePath = path.join(tmpDir, 'image_img_v3_02104');
      const gifHeader = Buffer.from('GIF87a');
      await fs.writeFile(filePath, Buffer.concat([gifHeader, Buffer.from('fake data')]));
      const headers = { 'content-type': 'application/unknown' };
      const result = await ensureFileExtension(filePath, headers);
      expect(result).toBe(filePath + '.gif');
    });

    it('returns original path when extension cannot be determined', async () => {
      const filePath = path.join(tmpDir, 'unknown_file');
      await fs.writeFile(filePath, Buffer.from('plain text content'));
      const result = await ensureFileExtension(filePath);
      expect(result).toBe(filePath);
    });

    it('handles the real Feishu scenario: image without extension', async () => {
      const filePath = path.join(tmpDir, 'image_img_v3_02104_b73cd122-662d-4ea5-a184-82f1dabc3e2g');
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.writeFile(filePath, Buffer.concat([pngHeader, Buffer.alloc(100, 0x00)]));
      const result = await ensureFileExtension(filePath);
      expect(result).toBe(filePath + '.png');
      // Verify renamed file exists
      await expect(fs.access(result)).resolves.toBeUndefined();
    });

    it('handles JPEG with content-type containing charset', async () => {
      const filePath = path.join(tmpDir, 'image_no_ext');
      await fs.writeFile(filePath, Buffer.from('fake data'));
      const headers = { 'Content-Type': 'image/jpeg; charset=binary' };
      const result = await ensureFileExtension(filePath, headers);
      expect(result).toBe(filePath + '.jpg');
    });
  });
});
