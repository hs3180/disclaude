/**
 * Tests for virtual filesystem mock (mock-fs).
 *
 * Issue #1617: The mock-fs utility has complex filesystem simulation logic
 * that should itself be tested to ensure test reliability.
 *
 * Tests cover: existsSync, mkdirSync, writeFileSync, readFileSync,
 * readdirSync, rmSync, renameSync, and resetVfs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockFs, resetVfs } from './mock-fs.js';

describe('mock-fs', () => {
  beforeEach(() => {
    resetVfs();
  });

  describe('existsSync', () => {
    it('should return false for non-existent path', () => {
      expect(mockFs.existsSync('/nonexistent')).toBe(false);
    });

    it('should return true for created file', () => {
      mockFs.writeFileSync('/test.txt', 'hello');
      expect(mockFs.existsSync('/test.txt')).toBe(true);
    });

    it('should return true for created directory', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      expect(mockFs.existsSync('/mydir')).toBe(true);
    });

    it('should normalize backslashes to forward slashes', () => {
      mockFs.writeFileSync('/test.txt', 'content');
      expect(mockFs.existsSync('\\test.txt')).toBe(true);
    });

    it('should normalize trailing slashes', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      expect(mockFs.existsSync('/mydir/')).toBe(true);
    });

    it('should handle paths with spaces', () => {
      mockFs.mkdirSync('/my dir', { recursive: true });
      mockFs.writeFileSync('/my dir/file.txt', 'content');
      expect(mockFs.existsSync('/my dir/file.txt')).toBe(true);
    });
  });

  describe('writeFileSync and readFileSync', () => {
    it('should write and read file content', () => {
      mockFs.writeFileSync('/file.txt', 'hello world');
      expect(mockFs.readFileSync('/file.txt', 'utf-8')).toBe('hello world');
    });

    it('should overwrite existing file', () => {
      mockFs.writeFileSync('/file.txt', 'first');
      mockFs.writeFileSync('/file.txt', 'second');
      expect(mockFs.readFileSync('/file.txt', 'utf-8')).toBe('second');
    });

    it('should convert non-string content to string', () => {
      mockFs.writeFileSync('/file.txt', 42 as unknown as string);
      expect(mockFs.readFileSync('/file.txt', 'utf-8')).toBe('42');
    });

    it('should throw ENOENT when reading non-existent file', () => {
      expect(() => mockFs.readFileSync('/nonexistent.txt', 'utf-8')).toThrow('ENOENT');
    });

    it('should throw EISDIR when reading a directory', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      expect(() => mockFs.readFileSync('/mydir', 'utf-8')).toThrow('EISDIR');
    });

    it('should write and read empty string content', () => {
      mockFs.writeFileSync('/file.txt', '');
      expect(mockFs.readFileSync('/file.txt', 'utf-8')).toBe('');
    });

    it('should throw ENOENT when writing to non-existent parent directory', () => {
      expect(() => mockFs.writeFileSync('/nonexistent/file.txt', 'content')).toThrow('ENOENT');
    });
  });

  describe('mkdirSync', () => {
    it('should create a single directory without recursive', () => {
      mockFs.mkdirSync('/mydir');
      expect(mockFs.existsSync('/mydir')).toBe(true);
    });

    it('should throw EEXIST when directory already exists without recursive', () => {
      mockFs.mkdirSync('/mydir');
      expect(() => mockFs.mkdirSync('/mydir')).toThrow('EEXIST');
    });

    it('should create nested directories with recursive', () => {
      mockFs.mkdirSync('/a/b/c', { recursive: true });
      expect(mockFs.existsSync('/a')).toBe(true);
      expect(mockFs.existsSync('/a/b')).toBe(true);
      expect(mockFs.existsSync('/a/b/c')).toBe(true);
    });

    it('should not throw when recursive and directory exists', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      expect(() => mockFs.mkdirSync('/mydir', { recursive: true })).not.toThrow();
    });

    it('should throw ENOENT when parent does not exist without recursive', () => {
      expect(() => mockFs.mkdirSync('/a/b')).toThrow('ENOENT');
    });
  });

  describe('readdirSync', () => {
    it('should throw ENOENT for non-existent directory', () => {
      expect(() => mockFs.readdirSync('/nonexistent')).toThrow('ENOENT');
    });

    it('should throw ENOENT when path is a file', () => {
      mockFs.writeFileSync('/file.txt', 'content');
      expect(() => mockFs.readdirSync('/file.txt')).toThrow('ENOENT');
    });

    it('should list files in a directory', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.writeFileSync('/dir/a.txt', 'a');
      mockFs.writeFileSync('/dir/b.txt', 'b');

      const entries = mockFs.readdirSync('/dir') as string[];
      expect(entries).toContain('a.txt');
      expect(entries).toContain('b.txt');
      expect(entries).toHaveLength(2);
    });

    it('should list subdirectories', () => {
      mockFs.mkdirSync('/dir/sub', { recursive: true });
      mockFs.writeFileSync('/dir/file.txt', 'content');

      const entries = mockFs.readdirSync('/dir') as string[];
      expect(entries).toContain('sub');
      expect(entries).toContain('file.txt');
    });

    it('should not list nested contents (only direct children)', () => {
      mockFs.mkdirSync('/dir/sub/deep', { recursive: true });
      mockFs.writeFileSync('/dir/sub/file.txt', 'content');

      const entries = mockFs.readdirSync('/dir') as string[];
      expect(entries).toEqual(['sub']);
    });

    it('should return Dirent-like objects with withFileTypes', () => {
      mockFs.mkdirSync('/dir/sub', { recursive: true });
      mockFs.writeFileSync('/dir/file.txt', 'content');

      const entries = mockFs.readdirSync('/dir', { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;

      const fileEntry = entries.find((e) => e.name === 'file.txt')!;
      expect(fileEntry.isFile()).toBe(true);
      expect(fileEntry.isDirectory()).toBe(false);

      const dirEntry = entries.find((e) => e.name === 'sub')!;
      expect(dirEntry.isDirectory()).toBe(true);
      expect(dirEntry.isFile()).toBe(false);
    });

    it('should return empty array for empty directory', () => {
      mockFs.mkdirSync('/empty', { recursive: true });
      expect(mockFs.readdirSync('/empty')).toEqual([]);
    });

    it('should normalize backslashes in readdir path', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      mockFs.writeFileSync('/mydir/a.txt', 'a');
      expect(mockFs.readdirSync('\\mydir')).toContain('a.txt');
    });

    it('should normalize trailing slashes in readdir path', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      mockFs.writeFileSync('/mydir/a.txt', 'a');
      expect(mockFs.readdirSync('/mydir/')).toContain('a.txt');
    });
  });

  describe('rmSync', () => {
    it('should throw ENOENT for non-existent path without force', () => {
      expect(() => mockFs.rmSync('/nonexistent')).toThrow('ENOENT');
    });

    it('should not throw for non-existent path with force', () => {
      expect(() => mockFs.rmSync('/nonexistent', { force: true })).not.toThrow();
    });

    it('should remove a file', () => {
      mockFs.writeFileSync('/file.txt', 'content');
      mockFs.rmSync('/file.txt');
      expect(mockFs.existsSync('/file.txt')).toBe(false);
    });

    it('should remove directory and contents with recursive', () => {
      mockFs.mkdirSync('/dir/sub', { recursive: true });
      mockFs.writeFileSync('/dir/a.txt', 'a');
      mockFs.writeFileSync('/dir/sub/b.txt', 'b');

      mockFs.rmSync('/dir', { recursive: true });

      expect(mockFs.existsSync('/dir')).toBe(false);
      expect(mockFs.existsSync('/dir/a.txt')).toBe(false);
      expect(mockFs.existsSync('/dir/sub')).toBe(false);
      expect(mockFs.existsSync('/dir/sub/b.txt')).toBe(false);
    });

    it('should throw ENOTEMPTY when removing non-empty directory without recursive', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.writeFileSync('/dir/file.txt', 'content');

      expect(() => mockFs.rmSync('/dir')).toThrow('ENOTEMPTY');
      expect(mockFs.existsSync('/dir')).toBe(true);
      expect(mockFs.existsSync('/dir/file.txt')).toBe(true);
    });

    it('should remove empty directory without recursive', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.rmSync('/dir');
      expect(mockFs.existsSync('/dir')).toBe(false);
    });
  });

  describe('renameSync', () => {
    it('should rename a file', () => {
      mockFs.writeFileSync('/old.txt', 'content');
      mockFs.renameSync('/old.txt', '/new.txt');

      expect(mockFs.existsSync('/old.txt')).toBe(false);
      expect(mockFs.existsSync('/new.txt')).toBe(true);
      expect(mockFs.readFileSync('/new.txt', 'utf-8')).toBe('content');
    });

    it('should throw ENOENT when source does not exist', () => {
      expect(() => mockFs.renameSync('/nonexistent', '/target')).toThrow('ENOENT');
    });

    it('should rename a directory and its contents', () => {
      mockFs.mkdirSync('/olddir/sub', { recursive: true });
      mockFs.writeFileSync('/olddir/file.txt', 'content');
      mockFs.writeFileSync('/olddir/sub/nested.txt', 'nested');

      mockFs.renameSync('/olddir', '/newdir');

      expect(mockFs.existsSync('/olddir')).toBe(false);
      expect(mockFs.existsSync('/newdir')).toBe(true);
      expect(mockFs.existsSync('/newdir/file.txt')).toBe(true);
      expect(mockFs.existsSync('/newdir/sub/nested.txt')).toBe(true);
      expect(mockFs.readFileSync('/newdir/file.txt', 'utf-8')).toBe('content');
    });

    it('should overwrite target file when renaming', () => {
      mockFs.writeFileSync('/old.txt', 'old content');
      mockFs.writeFileSync('/new.txt', 'new content');
      mockFs.renameSync('/old.txt', '/new.txt');

      expect(mockFs.existsSync('/old.txt')).toBe(false);
      expect(mockFs.readFileSync('/new.txt', 'utf-8')).toBe('old content');
    });
  });

  describe('resetVfs', () => {
    it('should clear all virtual filesystem entries', () => {
      mockFs.writeFileSync('/file1.txt', 'a');
      mockFs.writeFileSync('/file2.txt', 'b');
      mockFs.mkdirSync('/dir', { recursive: true });

      resetVfs();

      expect(mockFs.existsSync('/file1.txt')).toBe(false);
      expect(mockFs.existsSync('/file2.txt')).toBe(false);
      expect(mockFs.existsSync('/dir')).toBe(false);
    });
  });
});
