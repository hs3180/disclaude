/**
 * Tests for File Storage Service (src/file-transfer/node-transfer/file-storage.ts)
 *
 * Tests the following functionality:
 * - File storage initialization
 * - Storing files from local path and base64
 * - File retrieval and content access
 * - File deletion
 * - Storage statistics
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileStorageService } from './file-storage.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
  copyFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('test content')),
  rm: vi.fn().mockResolvedValue(undefined),
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

describe('FileStorageService', () => {
  let service: FileStorageService;
  const testStorageDir = '/tmp/test-storage';

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FileStorageService({
      storageDir: testStorageDir,
    });
  });

  describe('constructor', () => {
    it('should create service with default max file size', () => {
      const svc = new FileStorageService({ storageDir: testStorageDir });
      // Default is 100MB
      expect(svc).toBeDefined();
    });

    it('should create service with custom max file size', () => {
      const svc = new FileStorageService({
        storageDir: testStorageDir,
        maxFileSize: 50 * 1024 * 1024, // 50MB
      });
      expect(svc).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should create storage directory', async () => {
      await service.initialize();
      expect(fs.mkdir).toHaveBeenCalledWith(testStorageDir, { recursive: true });
    });
  });

  describe('storeFromLocal', () => {
    it('should store file from local path', async () => {
      const fileRef = await service.storeFromLocal(
        '/source/file.pdf',
        'document.pdf',
        'application/pdf',
        'agent',
        'chat_123'
      );

      expect(fileRef.fileName).toBe('document.pdf');
      expect(fileRef.mimeType).toBe('application/pdf');
      expect(fileRef.source).toBe('agent');
      expect(fileRef.id).toBeDefined();
      expect(fileRef.createdAt).toBeDefined();
    });

    it('should reject file exceeding max size', async () => {
      const smallService = new FileStorageService({
        storageDir: testStorageDir,
        maxFileSize: 100, // Very small
      });

      (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ size: 1000 });

      await expect(
        smallService.storeFromLocal('/source/file.pdf', 'document.pdf')
      ).rejects.toThrow('File size exceeds maximum allowed size');
    });

    it('should store with user source', async () => {
      const fileRef = await service.storeFromLocal(
        '/source/file.pdf',
        'document.pdf',
        undefined,
        'user'
      );

      expect(fileRef.source).toBe('user');
    });
  });

  describe('storeFromBase64', () => {
    it('should store file from base64 content', async () => {
      const content = Buffer.from('test content').toString('base64');
      const fileRef = await service.storeFromBase64(
        content,
        'test.txt',
        'text/plain',
        'agent',
        'chat_123'
      );

      expect(fileRef.fileName).toBe('test.txt');
      expect(fileRef.mimeType).toBe('text/plain');
      expect(fileRef.source).toBe('agent');
      expect(fileRef.size).toBe(12); // 'test content' length
    });

    it('should reject base64 content exceeding max size', async () => {
      const smallService = new FileStorageService({
        storageDir: testStorageDir,
        maxFileSize: 10, // Very small
      });

      const content = Buffer.from('this is a longer test content').toString('base64');

      await expect(
        smallService.storeFromBase64(content, 'test.txt')
      ).rejects.toThrow('File size exceeds maximum allowed size');
    });

    it('should work without optional parameters', async () => {
      const content = Buffer.from('test').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');

      expect(fileRef.fileName).toBe('test.txt');
      expect(fileRef.source).toBe('agent'); // Default
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent file', () => {
      expect(service.get('nonexistent')).toBeUndefined();
    });

    it('should return stored file', async () => {
      const content = Buffer.from('test').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');
      const stored = service.get(fileRef.id);

      expect(stored).toBeDefined();
      expect(stored?.ref.fileName).toBe('test.txt');
    });
  });

  describe('getContent', () => {
    it('should throw error for non-existent file', async () => {
      await expect(service.getContent('nonexistent')).rejects.toThrow('File not found');
    });

    it('should return base64 content', async () => {
      const content = Buffer.from('test content').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');

      const retrieved = await service.getContent(fileRef.id);
      // readFile is mocked to return 'test content'
      expect(retrieved).toBe(Buffer.from('test content').toString('base64'));
    });
  });

  describe('getLocalPath', () => {
    it('should return undefined for non-existent file', () => {
      expect(service.getLocalPath('nonexistent')).toBeUndefined();
    });

    it('should return local path for stored file', async () => {
      const content = Buffer.from('test').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');
      const localPath = service.getLocalPath(fileRef.id);

      expect(localPath).toBeDefined();
      expect(localPath).toContain(fileRef.id);
    });
  });

  describe('delete', () => {
    it('should return false for non-existent file', async () => {
      expect(await service.delete('nonexistent')).toBe(false);
    });

    it('should delete stored file', async () => {
      const content = Buffer.from('test').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');

      expect(service.has(fileRef.id)).toBe(true);

      const deleted = await service.delete(fileRef.id);
      expect(deleted).toBe(true);
      expect(service.has(fileRef.id)).toBe(false);
    });

    it('should handle deletion error gracefully', async () => {
      const content = Buffer.from('test').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');

      (fs.rm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Delete failed'));

      const deleted = await service.delete(fileRef.id);
      expect(deleted).toBe(false);
    });
  });

  describe('has', () => {
    it('should return false for non-existent file', () => {
      expect(service.has('nonexistent')).toBe(false);
    });

    it('should return true for stored file', async () => {
      const content = Buffer.from('test').toString('base64');
      const fileRef = await service.storeFromBase64(content, 'test.txt');

      expect(service.has(fileRef.id)).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty storage', () => {
      const stats = service.getStats();
      expect(stats.totalFiles).toBe(0);
      expect(stats.totalSize).toBe(0);
    });

    it('should return correct stats for stored files', async () => {
      const content1 = Buffer.from('test1').toString('base64');
      const content2 = Buffer.from('test22').toString('base64'); // 6 bytes

      await service.storeFromBase64(content1, 'test1.txt');
      await service.storeFromBase64(content2, 'test2.txt');

      const stats = service.getStats();
      expect(stats.totalFiles).toBe(2);
      // Sizes are from the mocked stat (1024) + buffer lengths
    });
  });

  describe('shutdown', () => {
    it('should not throw on shutdown', () => {
      expect(() => service.shutdown()).not.toThrow();
    });
  });
});
