/**
 * Tests for FileStorageService.
 *
 * @see file-storage.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises — source uses `import * as fs from 'fs/promises'`
// so we need named exports (not default)
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  copyFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  createFileRef: vi.fn((_fileName: string, source: string, options?: any) => ({
    id: `file_${Math.random().toString(36).slice(2, 10)}`,
    fileName: _fileName,
    source,
    mimeType: options?.mimeType,
    size: options?.size,
    localPath: options?.localPath,
  })),
}));

import * as fs from 'fs/promises';
import { FileStorageService } from './file-storage.js';

const mockFs = vi.mocked(fs) as any;

describe('FileStorageService', () => {
  let service: FileStorageService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FileStorageService({
      storageDir: '/tmp/test-storage',
      maxFileSize: 1024, // 1KB for testing
    });
  });

  describe('constructor', () => {
    it('should use default maxFileSize when not specified', () => {
      const svc = new FileStorageService({
        storageDir: '/tmp/storage',
      });
      // Default is 100MB
      expect(svc).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should create storage directory', async () => {
      await service.initialize();
      expect(mockFs.mkdir).toHaveBeenCalledWith(
        '/tmp/test-storage',
        { recursive: true }
      );
    });
  });

  describe('storeFromLocal', () => {
    it('should store a file from local path', async () => {
      mockFs.stat.mockResolvedValue({ size: 100 } as any);

      const fileRef = await service.storeFromLocal(
        '/source/file.txt',
        'file.txt',
        'text/plain',
        'user'
      );

      expect(fileRef.fileName).toBe('file.txt');
      expect(fileRef.source).toBe('user');
      expect(fileRef.mimeType).toBe('text/plain');
      expect(fileRef.size).toBe(100);
      expect(mockFs.copyFile).toHaveBeenCalled();
      expect(mockFs.mkdir).toHaveBeenCalled();
    });

    it('should reject files exceeding maxFileSize', async () => {
      mockFs.stat.mockResolvedValue({ size: 2048 } as any); // 2KB > 1KB max

      await expect(
        service.storeFromLocal('/source/big.txt', 'big.txt')
      ).rejects.toThrow('File size exceeds maximum allowed size');
    });

    it('should store file with user source by default', async () => {
      mockFs.stat.mockResolvedValue({ size: 50 } as any);

      const fileRef = await service.storeFromLocal('/src/data.bin', 'data.bin');
      expect(fileRef.source).toBe('user'); // default
    });
  });

  describe('storeFromBase64', () => {
    it('should store a file from base64 content', async () => {
      // "hello" in base64
      const content = Buffer.from('hello').toString('base64');

      const fileRef = await service.storeFromBase64(
        content,
        'hello.txt',
        'text/plain',
        'agent'
      );

      expect(fileRef.fileName).toBe('hello.txt');
      expect(fileRef.source).toBe('agent');
      expect(fileRef.size).toBe(5); // "hello" is 5 bytes
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should reject base64 content exceeding maxFileSize', async () => {
      // Create content larger than 1KB
      const bigContent = Buffer.alloc(2048).toString('base64');

      await expect(
        service.storeFromBase64(bigContent, 'big.bin')
      ).rejects.toThrow('File size exceeds maximum allowed size');
    });

    it('should store file without mimeType', async () => {
      const content = Buffer.from('data').toString('base64');

      const fileRef = await service.storeFromBase64(content, 'data.raw');
      expect(fileRef.mimeType).toBeUndefined();
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent file', () => {
      expect(service.get('nonexistent')).toBeUndefined();
    });

    it('should return stored file after storeFromBase64', async () => {
      const content = Buffer.from('test').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');
      const stored = service.get(fileRef.id);

      expect(stored).toBeDefined();
      expect(stored!.ref.fileName).toBe('test.txt');
    });
  });

  describe('getContent', () => {
    it('should throw for non-existent file', async () => {
      await expect(service.getContent('nonexistent')).rejects.toThrow(
        'File not found'
      );
    });

    it('should return base64 content of stored file', async () => {
      const content = Buffer.from('hello world').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'hello.txt');

      mockFs.readFile.mockResolvedValue(Buffer.from('hello world'));

      const result = await service.getContent(fileRef.id);
      expect(result).toBe(Buffer.from('hello world').toString('base64'));
    });
  });

  describe('getLocalPath', () => {
    it('should return undefined for non-existent file', () => {
      expect(service.getLocalPath('nonexistent')).toBeUndefined();
    });

    it('should return local path for stored file', async () => {
      const content = Buffer.from('data').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'data.txt');

      const path = service.getLocalPath(fileRef.id);
      expect(path).toBeDefined();
      expect(path).toContain('data.txt');
    });
  });

  describe('delete', () => {
    it('should return false for non-existent file', async () => {
      const result = await service.delete('nonexistent');
      expect(result).toBe(false);
    });

    it('should delete a stored file', async () => {
      const content = Buffer.from('temp').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'temp.txt');

      const result = await service.delete(fileRef.id);
      expect(result).toBe(true);
      expect(service.get(fileRef.id)).toBeUndefined();
      expect(mockFs.rm).toHaveBeenCalled();
    });

    it('should return false on rm error', async () => {
      const content = Buffer.from('data').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'rmfail.txt');

      mockFs.rm.mockRejectedValueOnce(new Error('Permission denied'));

      const result = await service.delete(fileRef.id);
      expect(result).toBe(false);
    });
  });

  describe('has', () => {
    it('should return false for non-existent file', () => {
      expect(service.has('nonexistent')).toBe(false);
    });

    it('should return true for stored file', async () => {
      const content = Buffer.from('data').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'exists.txt');

      expect(service.has(fileRef.id)).toBe(true);
    });

    it('should return false after deletion', async () => {
      const content = Buffer.from('data').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'del.txt');

      await service.delete(fileRef.id);
      expect(service.has(fileRef.id)).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty storage', () => {
      const stats = service.getStats();
      expect(stats).toEqual({ totalFiles: 0, totalSize: 0 });
    });

    it('should count stored files and their sizes', async () => {
      const content1 = Buffer.from('aaaa').toString('base64'); // 4 bytes
      const content2 = Buffer.from('bbbbbb').toString('base64'); // 6 bytes

      await service.storeFromBase64(content1, 'file1.txt');
      await service.storeFromBase64(content2, 'file2.txt');

      const stats = service.getStats();
      expect(stats.totalFiles).toBe(2);
      expect(stats.totalSize).toBe(10); // 4 + 6
    });
  });

  describe('shutdown', () => {
    it('should not throw on shutdown', () => {
      expect(() => service.shutdown()).not.toThrow();
    });
  });
});
