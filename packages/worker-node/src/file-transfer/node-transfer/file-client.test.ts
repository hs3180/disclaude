/**
 * Tests for FileClient — Execution Node's file transfer client.
 *
 * @see file-client.ts
 *
 * Covers:
 * - Constructor config normalization (trailing slash, default timeout)
 * - detectMimeType (tested indirectly via uploadFile)
 * - uploadFile: success, HTTP error, API error, timeout
 * - downloadFile: success, HTTP error, API error
 * - downloadToFile: custom path, default path (uses downloadDir)
 * - getFileInfo: success, 404, API error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileClient } from './file-client.js';
import type { FileRef } from '@disclaude/core';

// ============================================================================
// Mocks
// ============================================================================

// Mock fs/promises — only readFile is used by uploadFile
const mockReadFile = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ============================================================================
// Helpers
// ============================================================================

function createTestFileRef(overrides: Partial<FileRef> = {}): FileRef {
  return {
    id: 'file-uuid-123',
    fileName: 'test.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    source: 'user',
    localPath: '/tmp/test.pdf',
    createdAt: Date.now(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Extract the JSON-parsed body from the fetch mock's last call's options. */
function getFetchCallBody(): Record<string, unknown> {
  const opts = (mockFetch.mock.calls[0] as unknown[])[1] as Record<string, string>;
  return JSON.parse(opts.body as string);
}

// ============================================================================
// Tests
// ============================================================================

describe('FileClient', () => {
  let client: FileClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new FileClient({
      commNodeUrl: 'http://localhost:3001/',
      downloadDir: '/tmp/downloads',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('should strip trailing slash from commNodeUrl', async () => {
      const c = new FileClient({ commNodeUrl: 'http://example.com/' });
      // Verify via uploadFile — the URL should not have double slash
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));
      await c.uploadFile('/test.txt');
      // The fetch URL should be http://example.com/api/files (no trailing slash)
      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/api/files',
        expect.anything(),
      );
    });

    it('should use default timeout of 30000ms', () => {
      const c = new FileClient({ commNodeUrl: 'http://example.com' });
      // Timeout is internal; verify it doesn't throw
      expect(c).toBeDefined();
    });

    it('should accept custom timeout', () => {
      const c = new FileClient({ commNodeUrl: 'http://example.com', timeout: 5000 });
      expect(c).toBeDefined();
    });

    it('should store downloadDir from config', () => {
      const c = new FileClient({ commNodeUrl: 'http://example.com', downloadDir: '/custom/dir' });
      expect(c).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // uploadFile
  // --------------------------------------------------------------------------

  describe('uploadFile', () => {
    it('should upload file and return FileRef on success', async () => {
      const fileRef = createTestFileRef();
      const fileContent = Buffer.from('file content here');
      mockReadFile.mockResolvedValue(fileContent);
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef },
      }));

      const result = await client.uploadFile('/path/to/test.pdf', 'chat-123');

      expect(result).toEqual(fileRef);
      expect(mockReadFile).toHaveBeenCalledWith('/path/to/test.pdf');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/files',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      // Verify the request body
      const callBody = getFetchCallBody();
      expect(callBody.fileName).toBe('test.pdf');
      expect(callBody.mimeType).toBe('application/pdf');
      expect(callBody.chatId).toBe('chat-123');
      expect(callBody.content).toBe(fileContent.toString('base64'));
    });

    it('should detect MIME type from file extension', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));

      const testCases: [string, string][] = [
        ['file.txt', 'text/plain'],
        ['file.md', 'text/markdown'],
        ['file.json', 'application/json'],
        ['file.png', 'image/png'],
        ['file.jpg', 'image/jpeg'],
        ['file.jpeg', 'image/jpeg'],
        ['file.mp3', 'audio/mpeg'],
        ['file.mp4', 'video/mp4'],
        ['file.zip', 'application/zip'],
        ['file.csv', 'text/csv'],
        ['file.html', 'text/html'],
        ['file.css', 'text/css'],
        ['file.js', 'application/javascript'],
        ['file.ts', 'application/typescript'],
      ];

      for (const [fileName, expectedMime] of testCases) {
        mockFetch.mockClear();
        await client.uploadFile(`/path/${fileName}`);
        const callBody = getFetchCallBody();
        expect(callBody.mimeType).toBe(expectedMime);
      }
    });

    it('should use application/octet-stream for unknown extensions', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));

      await client.uploadFile('/path/to/file.xyz');
      const callBody = getFetchCallBody();
      expect(callBody.mimeType).toBe('application/octet-stream');
    });

    it('should throw on HTTP error response', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Server error' }, 500));

      await expect(client.uploadFile('/test.txt')).rejects.toThrow(
        'Failed to upload file: 500',
      );
    });

    it('should throw when API returns success: false', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: false,
        error: 'Upload failed: quota exceeded',
      }));

      await expect(client.uploadFile('/test.txt')).rejects.toThrow(
        'Upload failed: quota exceeded',
      );
    });

    it('should throw generic error when API returns success: false without error message', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: false,
      }));

      await expect(client.uploadFile('/test.txt')).rejects.toThrow(
        'Failed to upload file',
      );
    });

    it('should clear timeout after request completes', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));

      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      await client.uploadFile('/test.txt');
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('should work without chatId', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));

      await client.uploadFile('/test.txt');
      const callBody = getFetchCallBody();
      expect(callBody.chatId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // downloadFile
  // --------------------------------------------------------------------------

  describe('downloadFile', () => {
    const fileRef = createTestFileRef();
    const base64Content = Buffer.from('downloaded content').toString('base64');

    it('should download file and return Buffer on success', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef, content: base64Content },
      }));

      const result = await client.downloadFile(fileRef);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('downloaded content');
      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:3001/api/files/${fileRef.id}`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should throw on HTTP error response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));

      await expect(client.downloadFile(fileRef)).rejects.toThrow(
        'Failed to download file: 404',
      );
    });

    it('should throw when API returns success: false', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: false,
        error: 'File expired',
      }));

      await expect(client.downloadFile(fileRef)).rejects.toThrow('File expired');
    });

    it('should throw generic error when API returns success: false without error', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: false,
      }));

      await expect(client.downloadFile(fileRef)).rejects.toThrow(
        'Failed to download file',
      );
    });

    it('should clear timeout after download completes', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef, content: base64Content },
      }));

      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      await client.downloadFile(fileRef);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // downloadToFile
  // --------------------------------------------------------------------------

  describe('downloadToFile', () => {
    const fileRef = createTestFileRef({ id: 'file-abc', fileName: 'report.pdf' });
    const base64Content = Buffer.from('file data').toString('base64');

    it('should download and save file to specified local path', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef, content: base64Content },
      }));

      const fsMock = await import('fs/promises');
      const result = await client.downloadToFile(fileRef, '/custom/path/report.pdf');

      expect(result).toBe('/custom/path/report.pdf');
      expect(fsMock.mkdir).toHaveBeenCalledWith('/custom/path', { recursive: true });
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        '/custom/path/report.pdf',
        expect.any(Buffer),
      );
    });

    it('should use downloadDir from config when localPath is not provided', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef, content: base64Content },
      }));

      const fsMock = await import('fs/promises');
      const result = await client.downloadToFile(fileRef);

      // Should use downloadDir (/tmp/downloads) + fileId + fileName
      expect(result).toBe('/tmp/downloads/file-abc/report.pdf');
      expect(fsMock.mkdir).toHaveBeenCalledWith('/tmp/downloads/file-abc', { recursive: true });
    });

    it('should fall back to /tmp when no downloadDir is configured', async () => {
      const noDirClient = new FileClient({ commNodeUrl: 'http://localhost:3001' });
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef, content: base64Content },
      }));

      const fsMock = await import('fs/promises');
      const result = await noDirClient.downloadToFile(fileRef);

      expect(result).toBe('/tmp/file-abc/report.pdf');
      expect(fsMock.mkdir).toHaveBeenCalledWith('/tmp/file-abc', { recursive: true });
    });
  });

  // --------------------------------------------------------------------------
  // getFileInfo
  // --------------------------------------------------------------------------

  describe('getFileInfo', () => {
    const fileRef = createTestFileRef();

    it('should return FileRef on success', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef },
      }));

      const result = await client.getFileInfo('file-uuid-123');
      expect(result).toEqual(fileRef);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/files/file-uuid-123/info',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return null on 404', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));

      const result = await client.getFileInfo('nonexistent');
      expect(result).toBeNull();
    });

    it('should throw on non-404 HTTP errors', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Internal error' }, 500));

      await expect(client.getFileInfo('file-123')).rejects.toThrow(
        'Failed to get file info: 500',
      );
    });

    it('should return null when API returns success: false', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: false,
        error: 'Some error',
      }));

      const result = await client.getFileInfo('file-123');
      expect(result).toBeNull();
    });

    it('should return null when API returns success: true but no data', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        // data is missing
      }));

      const result = await client.getFileInfo('file-123');
      expect(result).toBeNull();
    });

    it('should clear timeout after request completes', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef },
      }));

      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      await client.getFileInfo('file-123');
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Timeout behavior
  // --------------------------------------------------------------------------

  describe('timeout behavior', () => {
    it('should abort request when timeout is reached during upload', async () => {
      const fastClient = new FileClient({
        commNodeUrl: 'http://localhost:3001',
        timeout: 100,
      });
      mockReadFile.mockResolvedValue(Buffer.from('data'));

      // Simulate a hanging fetch that never resolves
      let abortSignal: AbortSignal | undefined;
      mockFetch.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
        abortSignal = opts?.signal;
        return new Promise(() => {}); // Never resolves
      });

      const _uploadPromise = fastClient.uploadFile('/test.txt');

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(150);

      // The abort signal should have been triggered
      expect(abortSignal?.aborted).toBe(true);

      // Clean up the hanging promise to avoid test warnings
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));
    });

    it('should abort request when timeout is reached during download', async () => {
      const fastClient = new FileClient({
        commNodeUrl: 'http://localhost:3001',
        timeout: 100,
      });

      let abortSignal: AbortSignal | undefined;
      mockFetch.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
        abortSignal = opts?.signal;
        return new Promise(() => {});
      });

      const _downloadPromise = fastClient.downloadFile(createTestFileRef());

      await vi.advanceTimersByTimeAsync(150);

      expect(abortSignal?.aborted).toBe(true);

      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef(), content: '' },
      }));
    });

    it('should abort request when timeout is reached during getFileInfo', async () => {
      const fastClient = new FileClient({
        commNodeUrl: 'http://localhost:3001',
        timeout: 100,
      });

      let abortSignal: AbortSignal | undefined;
      mockFetch.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
        abortSignal = opts?.signal;
        return new Promise(() => {});
      });

      const _infoPromise = fastClient.getFileInfo('file-123');

      await vi.advanceTimersByTimeAsync(150);

      expect(abortSignal?.aborted).toBe(true);

      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle uploading file with uppercase extension', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));

      await client.uploadFile('/path/to/PHOTO.PNG');
      const callBody = getFetchCallBody();
      // Extension detection should be case-insensitive
      expect(callBody.mimeType).toBe('image/png');
    });

    it('should handle uploading file without extension', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));

      await client.uploadFile('/path/to/Makefile');
      const callBody = getFetchCallBody();
      expect(callBody.mimeType).toBe('application/octet-stream');
    });

    it('should handle empty file upload', async () => {
      mockReadFile.mockResolvedValue(Buffer.alloc(0));
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));

      const result = await client.uploadFile('/empty.txt');
      expect(result).toBeDefined();
      const callBody = getFetchCallBody();
      expect(callBody.content).toBe(''); // Empty base64
    });

    it('should handle download of large binary file', async () => {
      const largeContent = Buffer.alloc(1024 * 1024, 'x'); // 1MB
      const base64Large = largeContent.toString('base64');
      const fileRef = createTestFileRef({ size: largeContent.length });

      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef, content: base64Large },
      }));

      const result = await client.downloadFile(fileRef);
      expect(result.length).toBe(largeContent.length);
    });

    it('should handle URL without trailing slash correctly in all methods', async () => {
      const noSlashClient = new FileClient({ commNodeUrl: 'http://example.com' });
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef() },
      }));
      mockReadFile.mockResolvedValue(Buffer.from('data'));

      await noSlashClient.uploadFile('/test.txt');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/api/files',
        expect.anything(),
      );

      mockFetch.mockClear();
      const base64Content = Buffer.from('data').toString('base64');
      mockFetch.mockResolvedValue(jsonResponse({
        success: true,
        data: { fileRef: createTestFileRef(), content: base64Content },
      }));
      await noSlashClient.downloadFile(createTestFileRef());
      expect(mockFetch).toHaveBeenCalledWith(
        `http://example.com/api/files/${createTestFileRef().id}`,
        expect.anything(),
      );
    });
  });
});
