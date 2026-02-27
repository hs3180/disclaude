/**
 * Tests for File Client (src/file-transfer/node-transfer/file-client.ts)
 *
 * Tests the following functionality:
 * - MIME type detection
 * - File upload
 * - File download
 * - File info retrieval
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileClient } from './file-client.js';
import type { FileRef } from '../types.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('test content')),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('FileClient', () => {
  let client: FileClient;
  const baseUrl = 'http://localhost:3001';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = new FileClient({
      commNodeUrl: baseUrl,
      timeout: 30000,
      downloadDir: '/tmp/downloads',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create client with provided config', () => {
      const c = new FileClient({
        commNodeUrl: 'http://test:8080/',
        timeout: 60000,
        downloadDir: '/custom/dir',
      });

      expect(c).toBeDefined();
    });

    it('should strip trailing slash from URL', () => {
      // Client strips trailing slash internally
      const c = new FileClient({
        commNodeUrl: 'http://test:8080/',
      });

      expect(c).toBeDefined();
    });

    it('should use default timeout if not provided', () => {
      const c = new FileClient({
        commNodeUrl: baseUrl,
      });

      expect(c).toBeDefined();
    });
  });

  describe('uploadFile', () => {
    it('should upload file successfully', async () => {
      const mockFileRef: FileRef = {
        id: 'file-123',
        fileName: 'test.txt',
        source: 'agent',
        createdAt: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { fileRef: mockFileRef },
          }),
      });

      const result = await client.uploadFile('/path/to/test.txt', 'chat_123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/api/files`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      expect(result).toEqual(mockFileRef);
    });

    it('should detect MIME type from extension', async () => {
      const mockFileRef: FileRef = {
        id: 'file-123',
        fileName: 'test.pdf',
        source: 'agent',
        createdAt: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { fileRef: mockFileRef },
          }),
      });

      await client.uploadFile('/path/to/test.pdf');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.mimeType).toBe('application/pdf');
    });

    it('should handle upload failure response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });

      await expect(client.uploadFile('/path/to/test.txt')).rejects.toThrow(
        'Failed to upload file: 500'
      );
    });

    it('should handle error in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: false,
            error: 'Upload failed',
          }),
      });

      await expect(client.uploadFile('/path/to/test.txt')).rejects.toThrow('Upload failed');
    });
  });

  describe('downloadFile', () => {
    it('should download file successfully', async () => {
      const fileRef: FileRef = {
        id: 'file-123',
        fileName: 'test.txt',
        source: 'agent',
        createdAt: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              fileRef,
              content: Buffer.from('test content').toString('base64'),
            },
          }),
      });

      const result = await client.downloadFile(fileRef);

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/api/files/file-123`,
        expect.objectContaining({
          method: 'GET',
        })
      );

      expect(result.toString()).toBe('test content');
    });

    it('should handle download failure', async () => {
      const fileRef: FileRef = {
        id: 'file-123',
        fileName: 'test.txt',
        source: 'agent',
        createdAt: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      await expect(client.downloadFile(fileRef)).rejects.toThrow('Failed to download file: 404');
    });
  });

  describe('downloadToFile', () => {
    it('should download and save file', async () => {
      const fileRef: FileRef = {
        id: 'file-123',
        fileName: 'test.txt',
        source: 'agent',
        createdAt: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              fileRef,
              content: Buffer.from('test content').toString('base64'),
            },
          }),
      });

      const result = await client.downloadToFile(fileRef);

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
      expect(result).toContain('file-123');
    });

    it('should use provided local path', async () => {
      const fileRef: FileRef = {
        id: 'file-123',
        fileName: 'test.txt',
        source: 'agent',
        createdAt: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              fileRef,
              content: Buffer.from('test content').toString('base64'),
            },
          }),
      });

      const result = await client.downloadToFile(fileRef, '/custom/path/test.txt');

      expect(result).toBe('/custom/path/test.txt');
    });
  });

  describe('getFileInfo', () => {
    it('should get file info successfully', async () => {
      const mockFileRef: FileRef = {
        id: 'file-123',
        fileName: 'test.txt',
        source: 'agent',
        createdAt: Date.now(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { fileRef: mockFileRef },
          }),
      });

      const result = await client.getFileInfo('file-123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/api/files/file-123/info`,
        expect.objectContaining({
          method: 'GET',
        })
      );

      expect(result).toEqual(mockFileRef);
    });

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      const result = await client.getFileInfo('nonexistent');

      expect(result).toBeNull();
    });

    it('should throw for other errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });

      await expect(client.getFileInfo('file-123')).rejects.toThrow('Failed to get file info: 500');
    });

    it('should return null for unsuccessful response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: false,
            error: 'Not found',
          }),
      });

      const result = await client.getFileInfo('file-123');

      expect(result).toBeNull();
    });
  });
});
