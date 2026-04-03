/**
 * Unit tests for SoulLoader
 *
 * Issue #1315: SOUL.md Agent personality/behavior definition system.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoulLoader } from './loader.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

describe('SoulLoader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolvePath', () => {
    it('should expand ~ to home directory', () => {
      const result = SoulLoader.resolvePath('~/.disclaude/SOUL.md');
      expect(result).toBe(path.join(os.homedir(), '.disclaude/SOUL.md'));
    });

    it('should handle plain relative paths', () => {
      const result = SoulLoader.resolvePath('config/SOUL.md');
      expect(result).toBe(path.resolve('config/SOUL.md'));
    });

    it('should handle absolute paths', () => {
      const absPath = '/etc/disclaude/SOUL.md';
      const result = SoulLoader.resolvePath(absPath);
      expect(result).toBe(absPath);
    });
  });

  describe('constructor', () => {
    it('should resolve path on construction', () => {
      const loader = new SoulLoader('~/test/SOUL.md');
      // Path should be resolved (no way to access private field, but load will use it)
      expect(loader).toBeDefined();
    });

    it('should use default max size of 32KB', () => {
      const loader = new SoulLoader('~/test/SOUL.md');
      expect(loader).toBeDefined();
    });

    it('should accept custom max size', () => {
      const loader = new SoulLoader('~/test/SOUL.md', 1024);
      expect(loader).toBeDefined();
    });
  });

  describe('load', () => {
    it('should return null for non-existent file', async () => {
      vi.mocked(fsPromises.stat).mockRejectedValue({ code: 'ENOENT' } as NodeJS.ErrnoException);

      const loader = new SoulLoader('/non/existent/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for file exceeding size limit', async () => {
      // File size is 64KB, limit is 32KB
      vi.mocked(fsPromises.stat).mockResolvedValue({
        size: 64 * 1024,
      } as Awaited<ReturnType<typeof fsPromises.stat>>);

      const loader = new SoulLoader('/large/SOUL.md', 32 * 1024);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for file exactly at size limit + 1 byte', async () => {
      vi.mocked(fsPromises.stat).mockResolvedValue({
        size: 32 * 1024 + 1,
      } as Awaited<ReturnType<typeof fsPromises.stat>>);

      const loader = new SoulLoader('/exact/SOUL.md', 32 * 1024);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load file within size limit', async () => {
      const content = '# Core Truths\n\nBe helpful.';
      // Use Buffer.byteLength to get byte size (handles Unicode correctly)
      const byteLength = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fsPromises.stat).mockResolvedValue({
        size: byteLength,
      } as Awaited<ReturnType<typeof fsPromises.stat>>);
      vi.mocked(fsPromises.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/valid/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.content).toBe(content);
      expect(result?.sourcePath).toBe('/valid/SOUL.md');
      expect(result?.sizeBytes).toBe(byteLength);
    });

    it('should handle Unicode content correctly (byte size vs character length)', async () => {
      // Chinese characters are 3 bytes each in UTF-8
      const content = '你好世界'; // 4 chars, 12 bytes
      const byteLength = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fsPromises.stat).mockResolvedValue({
        size: byteLength, // 12 bytes
      } as Awaited<ReturnType<typeof fsPromises.stat>>);
      vi.mocked(fsPromises.readFile).mockResolvedValue(content);

      // Set limit to 12 bytes - should succeed
      const loader = new SoulLoader('/unicode/SOUL.md', 12);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.content).toBe('你好世界');
      expect(result?.sizeBytes).toBe(12);
    });

    it('should reject Unicode content that exceeds byte limit', async () => {
      // Emoji is 4 bytes per character
      const content = '🧠💡🎯'; // 3 chars, 12 bytes
      const byteLength = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fsPromises.stat).mockResolvedValue({
        size: byteLength, // 12 bytes
      } as Awaited<ReturnType<typeof fsPromises.stat>>);

      // Set limit to 11 bytes - should fail (12 > 11)
      const loader = new SoulLoader('/emoji/SOUL.md', 11);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for permission errors', async () => {
      vi.mocked(fsPromises.stat).mockRejectedValue({ code: 'EACCES' } as NodeJS.ErrnoException);

      const loader = new SoulLoader('/permission/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for generic file system errors', async () => {
      vi.mocked(fsPromises.stat).mockRejectedValue(new Error('Unknown error'));

      const loader = new SoulLoader('/error/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load file exactly at size limit', async () => {
      const content = 'A'.repeat(32 * 1024);
      const byteLength = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fsPromises.stat).mockResolvedValue({
        size: byteLength,
      } as Awaited<ReturnType<typeof fsPromises.stat>>);
      vi.mocked(fsPromises.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/exact/SOUL.md', 32 * 1024);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.sizeBytes).toBe(32 * 1024);
    });
  });
});
