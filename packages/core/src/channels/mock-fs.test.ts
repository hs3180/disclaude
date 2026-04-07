/**
 * Tests for virtual filesystem mock (packages/core/src/channels/mock-fs.ts)
 *
 * Tests the in-memory Map-based filesystem:
 * - existsSync: Check file/directory existence
 * - mkdirSync: Create directories (recursive and non-recursive)
 * - writeFileSync / readFileSync: File read/write operations
 * - readdirSync: Directory listing (with and without fileTypes)
 * - rmSync: File/directory removal (recursive and force)
 * - renameSync: File/directory rename
 * - Path normalization
 *
 * Issue #1617: test: 提升单元测试覆盖率至 70%
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockFs, resetVfs } from './mock-fs.js';

describe('mockFs', () => {
  beforeEach(() => {
    resetVfs();
    mockFs.existsSync.mockClear();
    mockFs.mkdirSync.mockClear();
    mockFs.writeFileSync.mockClear();
    mockFs.readFileSync.mockClear();
    mockFs.readdirSync.mockClear();
    mockFs.rmSync.mockClear();
    mockFs.renameSync.mockClear();
  });

  describe('existsSync', () => {
    it('should return false for non-existent path', () => {
      expect(mockFs.existsSync('/no/such/file')).toBe(false);
    });

    it('should return true for existing directory', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      expect(mockFs.existsSync('/test')).toBe(true);
    });

    it('should return true for existing file', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/file.txt', 'hello');
      expect(mockFs.existsSync('/test/file.txt')).toBe(true);
    });

    it('should normalize backslash paths', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      expect(mockFs.existsSync('\\test')).toBe(true);
    });

    it('should strip trailing slashes', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      expect(mockFs.existsSync('/test/')).toBe(true);
    });
  });

  describe('mkdirSync', () => {
    it('should create a directory', () => {
      mockFs.mkdirSync('/newdir');
      expect(mockFs.existsSync('/newdir')).toBe(true);
    });

    it('should create nested directories with recursive option', () => {
      mockFs.mkdirSync('/a/b/c', { recursive: true });
      expect(mockFs.existsSync('/a')).toBe(true);
      expect(mockFs.existsSync('/a/b')).toBe(true);
      expect(mockFs.existsSync('/a/b/c')).toBe(true);
    });

    it('should throw EEXIST for non-recursive mkdir on existing dir', () => {
      mockFs.mkdirSync('/existing');
      expect(() => mockFs.mkdirSync('/existing')).toThrow('EEXIST');
    });

    it('should not throw for recursive mkdir on existing dir', () => {
      mockFs.mkdirSync('/existing');
      expect(() => mockFs.mkdirSync('/existing', { recursive: true })).not.toThrow();
    });
  });

  describe('writeFileSync / readFileSync', () => {
    it('should write and read a file', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/hello.txt', 'Hello, World!');

      expect(mockFs.readFileSync('/test/hello.txt')).toBe('Hello, World!');
    });

    it('should convert content to string when writing', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/num.txt', 42 as any);

      expect(mockFs.readFileSync('/test/num.txt')).toBe('42');
    });

    it('should throw ENOENT when reading non-existent file', () => {
      expect(() => mockFs.readFileSync('/no/such/file')).toThrow('ENOENT');
    });

    it('should throw EISDIR when reading a directory', () => {
      mockFs.mkdirSync('/dir');
      expect(() => mockFs.readFileSync('/dir')).toThrow('EISDIR');
    });
  });

  describe('readdirSync', () => {
    it('should list directory contents as names', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/a.txt', 'a');
      mockFs.writeFileSync('/test/b.txt', 'b');
      mockFs.mkdirSync('/test/subdir');

      const entries = mockFs.readdirSync('/test');

      expect(entries).toHaveLength(3);
      expect(entries).toContain('a.txt');
      expect(entries).toContain('b.txt');
      expect(entries).toContain('subdir');
    });

    it('should list with fileTypes option', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/file.txt', 'content');
      mockFs.mkdirSync('/test/dir');

      const entries = mockFs.readdirSync('/test', { withFileTypes: true });

      const file = entries.find((e: any) => e.name === 'file.txt');
      const dir = entries.find((e: any) => e.name === 'dir');

      expect(file).toBeDefined();
      expect(file.isFile()).toBe(true);
      expect(file.isDirectory()).toBe(false);

      expect(dir).toBeDefined();
      expect(dir.isDirectory()).toBe(true);
      expect(dir.isFile()).toBe(false);
    });

    it('should throw ENOENT for non-existent directory', () => {
      expect(() => mockFs.readdirSync('/no/such/dir')).toThrow('ENOENT');
    });

    it('should throw ENOENT when path points to a file', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/file.txt', 'content');

      expect(() => mockFs.readdirSync('/test/file.txt')).toThrow('ENOENT');
    });

    it('should not include deeply nested files in parent listing', () => {
      mockFs.mkdirSync('/a/b/c', { recursive: true });
      mockFs.writeFileSync('/a/b/c/deep.txt', 'deep');

      const entries = mockFs.readdirSync('/a/b');

      expect(entries).toHaveLength(1);
      expect(entries).toContain('c');
    });
  });

  describe('rmSync', () => {
    it('should remove a file', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/file.txt', 'content');

      mockFs.rmSync('/test/file.txt');
      expect(mockFs.existsSync('/test/file.txt')).toBe(false);
    });

    it('should remove a directory recursively', () => {
      mockFs.mkdirSync('/test/sub', { recursive: true });
      mockFs.writeFileSync('/test/sub/file.txt', 'content');

      mockFs.rmSync('/test', { recursive: true });
      expect(mockFs.existsSync('/test')).toBe(false);
    });

    it('should throw ENOENT when removing non-existent path without force', () => {
      expect(() => mockFs.rmSync('/no/such/file')).toThrow('ENOENT');
    });

    it('should not throw when removing non-existent path with force', () => {
      expect(() => mockFs.rmSync('/no/such/file', { force: true })).not.toThrow();
    });
  });

  describe('renameSync', () => {
    it('should rename a file', () => {
      mockFs.mkdirSync('/test', { recursive: true });
      mockFs.writeFileSync('/test/old.txt', 'content');

      mockFs.renameSync('/test/old.txt', '/test/new.txt');

      expect(mockFs.existsSync('/test/old.txt')).toBe(false);
      expect(mockFs.existsSync('/test/new.txt')).toBe(true);
      expect(mockFs.readFileSync('/test/new.txt')).toBe('content');
    });

    it('should rename a directory with its contents', () => {
      mockFs.mkdirSync('/old/sub', { recursive: true });
      mockFs.writeFileSync('/old/sub/file.txt', 'data');

      mockFs.renameSync('/old', '/new');

      expect(mockFs.existsSync('/old')).toBe(false);
      expect(mockFs.existsSync('/new')).toBe(true);
      expect(mockFs.existsSync('/new/sub')).toBe(true);
      expect(mockFs.readFileSync('/new/sub/file.txt')).toBe('data');
    });

    it('should throw ENOENT when renaming non-existent path', () => {
      expect(() => mockFs.renameSync('/no/such', '/dest')).toThrow('ENOENT');
    });
  });

  describe('chmodSync', () => {
    it('should be a no-op function', () => {
      expect(() => mockFs.chmodSync('/any/path', 0o755)).not.toThrow();
    });
  });
});
