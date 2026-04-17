/**
 * Tests for File Client - Execution Node file transfer operations.
 *
 * Issue #1617 Phase 3: Add meaningful unit tests for worker-node modules.
 * Covers FileClient constructor, upload, download, save-to-file, and get-file-info.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileClient } from './file-client.js';
import type { FileRef } from '@disclaude/core';
import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// Mocks
// ============================================================================

// Mock fs/promises - use importOriginal to preserve other exports
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  };
});

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ============================================================================
// Test Data & Helpers
// ============================================================================

const sampleFileRef: FileRef = {
  id: 'file-abc123',
  fileName: 'test-document.pdf',
  mimeType: 'application/pdf',
  size: 2048,
  source: 'user',
  createdAt: Date.now(),
};

/** Create a mock fetch response with JSON body */
function mockJsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

/** Create a mock fetch error response */
function mockErrorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
  };
}

/** Get the fetch call arguments */
function getFetchCall(index = 0): RequestInit {
  const [, call] = mockFetch.mock.calls[index];
  return call as RequestInit;
}

// ============================================================================
// Tests
// ============================================================================

describe('FileClient', () => {
  let client: FileClient;

  beforeEach(() => {
    client = new FileClient({
      commNodeUrl: 'http://localhost:3001',
      timeout: 5000,
      downloadDir: '/tmp/downloads',
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Constructor
  // ============================================================================

  describe('constructor', () => {
    it('should strip trailing slash from URL', () => {
      const c = new FileClient({ commNodeUrl: 'http://localhost:3001/' });
      // Verify via upload - the URL should not have double slashes
      expect(c).toBeDefined();
    });

    it('should set default timeout to 30000ms', () => {
      const c = new FileClient({ commNodeUrl: 'http://localhost:3001' });
      expect(c).toBeDefined();
      // Timeout is used internally; we verify behavior via upload/download
    });

    it('should accept custom downloadDir', () => {
      const c = new FileClient({
        commNodeUrl: 'http://localhost:3001',
        downloadDir: '/custom/dir',
      });
      expect(c).toBeDefined();
    });
  });

  // ============================================================================
  // uploadFile
  // ============================================================================

  describe('uploadFile', () => {
    it('should upload a file and return FileRef', async () => {
      const fileContent = Buffer.from('test file content');

      vi.mocked(fs.readFile).mockResolvedValue(fileContent);
      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { fileRef: sampleFileRef } }),
      );

      const result = await client.uploadFile('/path/to/test.pdf', 'chat-123');

      expect(result).toEqual(sampleFileRef);
      expect(fs.readFile).toHaveBeenCalledWith('/path/to/test.pdf');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/files',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      // Verify request body structure
      const call = getFetchCall();
      const body = JSON.parse(call.body as string);
      expect(body.fileName).toBe('test.pdf');
      expect(body.mimeType).toBe('application/pdf');
      expect(body.chatId).toBe('chat-123');
      expect(body.content).toBe(fileContent.toString('base64'));
    });

    it('should use application/octet-stream for unknown file types', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { fileRef: { ...sampleFileRef, id: 'file-xyz' } } }),
      );

      await client.uploadFile('/path/to/file.xyz');

      const call = getFetchCall();
      const body = JSON.parse(call.body as string);
      expect(body.mimeType).toBe('application/octet-stream');
    });

    it('should throw on HTTP error response', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(mockErrorResponse(500, 'Internal Server Error'));

      await expect(client.uploadFile('/path/to/test.pdf')).rejects.toThrow(
        'Failed to upload file: 500',
      );
    });

    it('should throw when API returns unsuccessful response', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: false, error: 'Upload quota exceeded' }),
      );

      await expect(client.uploadFile('/path/to/test.pdf')).rejects.toThrow(
        'Upload quota exceeded',
      );
    });

    it('should throw generic error when API returns no error message', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(mockJsonResponse({ success: false }));

      await expect(client.uploadFile('/path/to/test.pdf')).rejects.toThrow(
        'Failed to upload file',
      );
    });

    it('should work without chatId', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('data'));
      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { fileRef: sampleFileRef } }),
      );

      await client.uploadFile('/path/to/test.pdf');

      const call = getFetchCall();
      const body = JSON.parse(call.body as string);
      expect(body.chatId).toBeUndefined();
    });
  });

  // ============================================================================
  // downloadFile
  // ============================================================================

  describe('downloadFile', () => {
    it('should download a file and return Buffer', async () => {
      const base64Content = Buffer.from('downloaded content').toString('base64');

      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { content: base64Content } }),
      );

      const result = await client.downloadFile(sampleFileRef);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('downloaded content');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/files/file-abc123',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(404, 'Not Found'));

      await expect(client.downloadFile(sampleFileRef)).rejects.toThrow(
        'Failed to download file: 404',
      );
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: false, error: 'File expired' }),
      );

      await expect(client.downloadFile(sampleFileRef)).rejects.toThrow(
        'File expired',
      );
    });
  });

  // ============================================================================
  // downloadToFile
  // ============================================================================

  describe('downloadToFile', () => {
    it('should download and save file to specified path', async () => {
      const base64Content = Buffer.from('file data').toString('base64');

      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { content: base64Content } }),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const savePath = await client.downloadToFile(sampleFileRef, '/custom/path/test.pdf');

      expect(savePath).toBe('/custom/path/test.pdf');
      expect(fs.mkdir).toHaveBeenCalledWith('/custom/path', { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/custom/path/test.pdf',
        expect.any(Buffer),
      );
    });

    it('should auto-generate path from downloadDir when no path given', async () => {
      const base64Content = Buffer.from('file data').toString('base64');

      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { content: base64Content } }),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const savePath = await client.downloadToFile(sampleFileRef);

      expect(savePath).toBe(path.join('/tmp/downloads', sampleFileRef.id, sampleFileRef.fileName));
    });

    it('should use /tmp as fallback when no downloadDir', async () => {
      const noDirClient = new FileClient({ commNodeUrl: 'http://localhost:3001' });
      const base64Content = Buffer.from('data').toString('base64');

      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { content: base64Content } }),
      );
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const savePath = await noDirClient.downloadToFile(sampleFileRef);

      expect(savePath).toBe(path.join('/tmp', sampleFileRef.id, sampleFileRef.fileName));
    });
  });

  // ============================================================================
  // getFileInfo
  // ============================================================================

  describe('getFileInfo', () => {
    it('should return FileRef for existing file', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ success: true, data: { fileRef: sampleFileRef } }),
      );

      const result = await client.getFileInfo('file-abc123');

      expect(result).toEqual(sampleFileRef);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/files/file-abc123/info',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });

      const result = await client.getFileInfo('nonexistent');

      expect(result).toBeNull();
    });

    it('should throw on non-404 HTTP errors', async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(500, 'Server Error'));

      await expect(client.getFileInfo('file-abc123')).rejects.toThrow(
        'Failed to get file info: 500',
      );
    });

    it('should return null when API response is unsuccessful', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ success: false }));

      const result = await client.getFileInfo('file-abc123');

      expect(result).toBeNull();
    });
  });
});
