/**
 * Tests for WeChat Media Handler.
 *
 * Tests the media upload pipeline including file validation,
 * upload orchestration, and type detection.
 * Uses mocked API client and fetch to avoid real network dependency.
 *
 * @see Issue #1475 - WeChat Channel: Media Handling
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Mock Logger ───

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// ─── Mock Fetch (for CDN upload) ───

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ───

/** Create a mock API client with controllable getUploadUrl. */
function createMockApiClient(uploadUrlResponse?: any) {
  return {
    getUploadUrl: vi.fn().mockResolvedValue(
      uploadUrlResponse ?? {
        upload_param: 'mock-upload-param',
        thumb_upload_param: undefined,
      },
    ),
  };
}

/** Create a temporary file with given content. Returns the file path. */
function createTempFile(content: Buffer | string, ext = '.txt'): string {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `test-media-${Date.now()}${ext}`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ═══════════════════════════════════════════════════════
// WeChatMediaHandler
// ═══════════════════════════════════════════════════════

describe('WeChatMediaHandler', () => {
  let handler: any;
  let mockClient: ReturnType<typeof createMockApiClient>;
  const cdnBaseUrl = 'https://cdn.example.com/c2c';

  beforeEach(async () => {
    mockClient = createMockApiClient();
    // Set up fetch mock for CDN upload success
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Map([['x-encrypted-param', 'mock-download-param']]),
    });
    // Dynamic import to get fresh module with mocks applied
    const { WeChatMediaHandler } = await import('./media-handler.js');
    handler = new WeChatMediaHandler(mockClient as any, cdnBaseUrl);
  });

  afterEach(() => {
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  // ─── File existence check ───

  describe('uploadFile', () => {
    it('should throw error for non-existent file', async () => {
      await expect(
        handler.uploadFile('/nonexistent/file.txt', 'user123'),
      ).rejects.toThrow('File not found');
    });

    it('should throw error for oversized image (>10MB)', async () => {
      const bigImage = createTempFile(Buffer.alloc(10 * 1024 * 1024 + 1), '.png');
      try {
        await expect(
          handler.uploadFile(bigImage, 'user123'),
        ).rejects.toThrow('Image file too large');
      } finally {
        fs.unlinkSync(bigImage);
      }
    });

    it('should throw error for oversized file (>30MB)', async () => {
      const bigFile = createTempFile(Buffer.alloc(30 * 1024 * 1024 + 1), '.pdf');
      try {
        await expect(
          handler.uploadFile(bigFile, 'user123'),
        ).rejects.toThrow('File too large');
      } finally {
        fs.unlinkSync(bigFile);
      }
    });

    it('should accept image within size limit', async () => {
      const image = createTempFile(Buffer.alloc(1024), '.jpg');
      try {
        const result = await handler.uploadFile(image, 'user123');
        expect(result).toBeDefined();
        expect(result.filekey).toBeDefined();
        expect(result.fileSize).toBe(1024);
      } finally {
        fs.unlinkSync(image);
      }
    });

    it('should accept file within size limit', async () => {
      const file = createTempFile(Buffer.alloc(1024), '.pdf');
      try {
        const result = await handler.uploadFile(file, 'user123');
        expect(result).toBeDefined();
        expect(result.fileSize).toBe(1024);
      } finally {
        fs.unlinkSync(file);
      }
    });
  });

  // ─── Upload pipeline ───

  describe('uploadBuffer', () => {
    it('should call getUploadUrl with correct parameters', async () => {
      const buf = Buffer.from('test content');
      await handler.uploadBuffer(buf, 'user123', 1); // IMAGE type

      expect(mockClient.getUploadUrl).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.getUploadUrl.mock.calls[0][0];
      expect(callArgs.media_type).toBe(1);
      expect(callArgs.to_user_id).toBe('user123');
      expect(callArgs.rawsize).toBe(buf.length);
      expect(callArgs.no_need_thumb).toBe(true);
      expect(callArgs.aeskey).toBeDefined();
      expect(callArgs.filekey).toBeDefined();
      expect(callArgs.rawfilemd5).toBeDefined();
    });

    it('should call fetch (CDN upload) with correct parameters', async () => {
      const buf = Buffer.from('test content');
      await handler.uploadBuffer(buf, 'user123', 3); // FILE type

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].method).toBe('POST');
      expect(callArgs[1].headers['Content-Type']).toBe('application/octet-stream');
    });

    it('should return correct upload info', async () => {
      const buf = Buffer.from('test content');
      const result = await handler.uploadBuffer(buf, 'user123', 1);

      expect(result.filekey).toBeDefined();
      expect(result.downloadEncryptedQueryParam).toBe('mock-download-param');
      expect(result.aeskey).toBeDefined();
      expect(result.fileSize).toBe(buf.length);
      expect(result.fileSizeCiphertext).toBeGreaterThan(buf.length); // padded
    });

    it('should compute correct MD5 hash', async () => {
      const buf = Buffer.from('hello');
      await handler.uploadBuffer(buf, 'user123', 1);

      const callArgs = mockClient.getUploadUrl.mock.calls[0][0];
      // MD5 of 'hello' is '5d41402abc4b2a76b9719d911017c592'
      expect(callArgs.rawfilemd5).toBe('5d41402abc4b2a76b9719d911017c592');
    });

    it('should compute correct padded size', async () => {
      const buf = Buffer.from('a'); // 1 byte → padded to 16
      const result = await handler.uploadBuffer(buf, 'user123', 1);

      expect(result.fileSizeCiphertext).toBe(16);
    });
  });

  // ─── Type detection ───

  describe('isImageFile', () => {
    it('should identify common image extensions', () => {
      expect(handler.isImageFile('.jpg')).toBe(true);
      expect(handler.isImageFile('.jpeg')).toBe(true);
      expect(handler.isImageFile('.png')).toBe(true);
      expect(handler.isImageFile('.gif')).toBe(true);
      expect(handler.isImageFile('.webp')).toBe(true);
      expect(handler.isImageFile('.bmp')).toBe(true);
    });

    it('should reject non-image extensions', () => {
      expect(handler.isImageFile('.pdf')).toBe(false);
      expect(handler.isImageFile('.doc')).toBe(false);
      expect(handler.isImageFile('.zip')).toBe(false);
      expect(handler.isImageFile('.txt')).toBe(false);
      expect(handler.isImageFile('.mp4')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(handler.isImageFile('.PNG')).toBe(true);
      expect(handler.isImageFile('.Jpg')).toBe(true);
      expect(handler.isImageFile('.GIF')).toBe(true);
    });
  });

  describe('getMimeType', () => {
    it('should return correct MIME types', () => {
      expect(handler.getMimeType('.jpg')).toBe('image/jpeg');
      expect(handler.getMimeType('.png')).toBe('image/png');
      expect(handler.getMimeType('.pdf')).toBe('application/pdf');
      expect(handler.getMimeType('.json')).toBe('application/json');
      expect(handler.getMimeType('.mp4')).toBe('video/mp4');
    });

    it('should return application/octet-stream for unknown types', () => {
      expect(handler.getMimeType('.xyz')).toBe('application/octet-stream');
    });
  });
});
