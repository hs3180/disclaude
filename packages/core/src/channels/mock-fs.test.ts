/**
 * Unit tests for mock-fs virtual filesystem.
 *
 * Issue #1617 Phase 2: Tests for channels/mock-fs.ts.
 *
 * Verifies the in-memory Map-based filesystem mock used by channel tests:
 * - existsSync, mkdirSync, writeFileSync, readFileSync
 * - readdirSync (with and without withFileTypes)
 * - rmSync (recursive, force, non-recursive)
 * - renameSync (file and directory rename)
 * - chmodSync (no-op)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockFs, resetVfs } from './mock-fs.js';

beforeEach(() => {
  resetVfs();
  mockFs.existsSync.mockClear();
  mockFs.mkdirSync.mockClear();
  mockFs.writeFileSync.mockClear();
  mockFs.readFileSync.mockClear();
  mockFs.readdirSync.mockClear();
  mockFs.rmSync.mockClear();
  mockFs.renameSync.mockClear();
  mockFs.chmodSync.mockClear();
});

describe('mockFs', () => {
  describe('existsSync', () => {
    it('should return false for non-existent path', () => {
      expect(mockFs.existsSync('/no/such/path')).toBe(false);
    });

    it('should return true for existing path', () => {
      mockFs.mkdirSync('/existing');
      expect(mockFs.existsSync('/existing')).toBe(true);
    });

    it('should normalize paths (forward slashes, no trailing slash)', () => {
      mockFs.mkdirSync('/path/to/dir');
      expect(mockFs.existsSync('/path/to/dir/')).toBe(true);
      expect(mockFs.existsSync('\\path\\to\\dir')).toBe(true);
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

    it('should throw EEXIST when creating existing directory without recursive', () => {
      mockFs.mkdirSync('/existing');
      expect(() => mockFs.mkdirSync('/existing')).toThrow('EEXIST');
    });

    it('should not throw when creating existing directory with recursive', () => {
      mockFs.mkdirSync('/existing');
      expect(() => mockFs.mkdirSync('/existing', { recursive: true })).not.toThrow();
    });
  });

  describe('writeFileSync / readFileSync', () => {
    it('should write and read a file', () => {
      mockFs.mkdirSync('/dir');
      mockFs.writeFileSync('/dir/file.txt', 'hello world');
      expect(mockFs.readFileSync('/dir/file.txt')).toBe('hello world');
    });

    it('should throw ENOENT when reading non-existent file', () => {
      expect(() => mockFs.readFileSync('/no/file')).toThrow('ENOENT');
    });

    it('should throw EISDIR when reading a directory', () => {
      mockFs.mkdirSync('/dir');
      expect(() => mockFs.readFileSync('/dir')).toThrow('EISDIR');
    });

    it('should overwrite existing file content', () => {
      mockFs.mkdirSync('/dir');
      mockFs.writeFileSync('/dir/file.txt', 'first');
      mockFs.writeFileSync('/dir/file.txt', 'second');
      expect(mockFs.readFileSync('/dir/file.txt')).toBe('second');
    });
  });

  describe('readdirSync', () => {
    it('should list entries in a directory', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.writeFileSync('/dir/file1.txt', 'a');
      mockFs.writeFileSync('/dir/file2.txt', 'b');
      mockFs.mkdirSync('/dir/subdir', { recursive: true });

      const entries = mockFs.readdirSync('/dir') as string[];
      expect(entries).toContain('file1.txt');
      expect(entries).toContain('file2.txt');
      expect(entries).toContain('subdir');
      expect(entries).toHaveLength(3);
    });

    it('should throw ENOENT for non-existent directory', () => {
      expect(() => mockFs.readdirSync('/no/dir')).toThrow('ENOENT');
    });

    it('should throw ENOENT when path is a file', () => {
      mockFs.mkdirSync('/dir');
      mockFs.writeFileSync('/dir/file.txt', 'a');
      expect(() => mockFs.readdirSync('/dir/file.txt')).toThrow('ENOENT');
    });

    it('should return Dirent-like objects with withFileTypes option', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.writeFileSync('/dir/file.txt', 'a');
      mockFs.mkdirSync('/dir/sub', { recursive: true });

      const entries = mockFs.readdirSync('/dir', { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;
      const file = entries.find((e) => e.name === 'file.txt');
      const dir = entries.find((e) => e.name === 'sub');

      expect(file).toBeDefined();
      expect(file!.isFile()).toBe(true);
      expect(file!.isDirectory()).toBe(false);

      expect(dir).toBeDefined();
      expect(dir!.isDirectory()).toBe(true);
      expect(dir!.isFile()).toBe(false);
    });

    it('should not include nested entries from subdirectories', () => {
      mockFs.mkdirSync('/dir/sub/deep', { recursive: true });
      mockFs.writeFileSync('/dir/sub/deep/file.txt', 'a');

      const entries = mockFs.readdirSync('/dir') as string[];
      expect(entries).toEqual(['sub']);
    });
  });

  describe('rmSync', () => {
    it('should remove a file', () => {
      mockFs.mkdirSync('/dir');
      mockFs.writeFileSync('/dir/file.txt', 'a');
      mockFs.rmSync('/dir/file.txt');
      expect(mockFs.existsSync('/dir/file.txt')).toBe(false);
    });

    it('should remove a directory recursively', () => {
      mockFs.mkdirSync('/dir/sub', { recursive: true });
      mockFs.writeFileSync('/dir/sub/file.txt', 'a');
      mockFs.rmSync('/dir', { recursive: true });
      expect(mockFs.existsSync('/dir')).toBe(false);
      expect(mockFs.existsSync('/dir/sub')).toBe(false);
      expect(mockFs.existsSync('/dir/sub/file.txt')).toBe(false);
    });

    it('should throw ENOENT for non-existent path without force', () => {
      expect(() => mockFs.rmSync('/no/path')).toThrow('ENOENT');
    });

    it('should not throw for non-existent path with force', () => {
      expect(() => mockFs.rmSync('/no/path', { force: true })).not.toThrow();
    });

    it('should remove a directory non-recursively', () => {
      mockFs.mkdirSync('/dir');
      mockFs.rmSync('/dir');
      expect(mockFs.existsSync('/dir')).toBe(false);
    });
  });

  describe('renameSync', () => {
    it('should rename a file', () => {
      mockFs.mkdirSync('/dir');
      mockFs.writeFileSync('/dir/old.txt', 'content');
      mockFs.renameSync('/dir/old.txt', '/dir/new.txt');

      expect(mockFs.existsSync('/dir/old.txt')).toBe(false);
      expect(mockFs.existsSync('/dir/new.txt')).toBe(true);
      expect(mockFs.readFileSync('/dir/new.txt')).toBe('content');
    });

    it('should throw ENOENT when source does not exist', () => {
      expect(() => mockFs.renameSync('/no/src', '/no/dest')).toThrow('ENOENT');
    });

    it('should rename a directory and move its children', () => {
      mockFs.mkdirSync('/olddir/sub', { recursive: true });
      mockFs.writeFileSync('/olddir/sub/file.txt', 'nested content');

      mockFs.renameSync('/olddir', '/newdir');

      // Old directory should not exist
      expect(mockFs.existsSync('/olddir')).toBe(false);
      expect(mockFs.existsSync('/olddir/sub')).toBe(false);
      expect(mockFs.existsSync('/olddir/sub/file.txt')).toBe(false);

      // New directory should have all children
      expect(mockFs.existsSync('/newdir')).toBe(true);
      expect(mockFs.existsSync('/newdir/sub')).toBe(true);
      expect(mockFs.readFileSync('/newdir/sub/file.txt')).toBe('nested content');
    });

    it('should rename a directory to a new name without children', () => {
      mockFs.mkdirSync('/emptydir');
      mockFs.renameSync('/emptydir', '/renameddir');

      expect(mockFs.existsSync('/emptydir')).toBe(false);
      expect(mockFs.existsSync('/renameddir')).toBe(true);
    });

    it('should rename a file to a new name in a different directory', () => {
      mockFs.mkdirSync('/src', { recursive: true });
      mockFs.mkdirSync('/dst', { recursive: true });
      mockFs.writeFileSync('/src/file.txt', 'content');

      mockFs.renameSync('/src/file.txt', '/dst/file.txt');

      expect(mockFs.existsSync('/src/file.txt')).toBe(false);
      expect(mockFs.existsSync('/dst/file.txt')).toBe(true);
      expect(mockFs.readFileSync('/dst/file.txt')).toBe('content');
    });
  });

  describe('chmodSync', () => {
    it('should be a no-op function', () => {
      mockFs.mkdirSync('/dir');
      expect(() => mockFs.chmodSync('/dir', 0o755)).not.toThrow();
    });
  });

  describe('resetVfs', () => {
    it('should clear all entries from the virtual filesystem', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.writeFileSync('/dir/file.txt', 'content');
      expect(mockFs.existsSync('/dir')).toBe(true);

      resetVfs();
      expect(mockFs.existsSync('/dir')).toBe(false);
      expect(mockFs.existsSync('/dir/file.txt')).toBe(false);
    });
  });
});
