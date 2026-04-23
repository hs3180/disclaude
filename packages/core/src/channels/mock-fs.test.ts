/**
 * Tests for virtual filesystem mock (packages/core/src/channels/mock-fs.ts)
 *
 * Issue #1617 Phase 2: Tests for the in-memory filesystem mock used in unit tests.
 *
 * Covers:
 * - norm: path normalization (backslashes, trailing slashes)
 * - existsSync: file and directory existence checks
 * - mkdirSync: non-recursive and recursive directory creation
 * - writeFileSync / readFileSync: file I/O with error handling
 * - readdirSync: directory listing with and without withFileTypes
 * - rmSync: single file, recursive, and force removal
 * - renameSync: file and directory renaming with children
 * - resetVfs: clearing the virtual filesystem
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockFs, resetVfs } from './mock-fs.js';

describe('Virtual Filesystem Mock (mockFs)', () => {
  beforeEach(() => {
    resetVfs();
  });

  // =========================================================================
  // existsSync
  // =========================================================================
  describe('existsSync', () => {
    it('should return false for non-existent path', () => {
      expect(mockFs.existsSync('/nonexistent')).toBe(false);
    });

    it('should return true for an existing file', () => {
      mockFs.writeFileSync('/test.txt', 'hello');
      expect(mockFs.existsSync('/test.txt')).toBe(true);
    });

    it('should return true for an existing directory', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      expect(mockFs.existsSync('/mydir')).toBe(true);
    });

    it('should normalize backslashes', () => {
      mockFs.writeFileSync('/path/to/file.txt', 'data');
      expect(mockFs.existsSync('\\path\\to\\file.txt')).toBe(true);
    });

    it('should normalize trailing slashes', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      expect(mockFs.existsSync('/dir/')).toBe(true);
      expect(mockFs.existsSync('/dir')).toBe(true);
    });
  });

  // =========================================================================
  // writeFileSync / readFileSync
  // =========================================================================
  describe('writeFileSync and readFileSync', () => {
    it('should write and read file content', () => {
      mockFs.writeFileSync('/file.txt', 'hello world');
      expect(mockFs.readFileSync('/file.txt')).toBe('hello world');
    });

    it('should overwrite existing file content', () => {
      mockFs.writeFileSync('/file.txt', 'first');
      mockFs.writeFileSync('/file.txt', 'second');
      expect(mockFs.readFileSync('/file.txt')).toBe('second');
    });

    it('should throw ENOENT when reading non-existent file', () => {
      expect(() => mockFs.readFileSync('/nope.txt')).toThrow();
      try {
        mockFs.readFileSync('/nope.txt');
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }
    });

    it('should throw EISDIR when reading a directory', () => {
      mockFs.mkdirSync('/mydir', { recursive: true });
      expect(() => mockFs.readFileSync('/mydir')).toThrow();
      try {
        mockFs.readFileSync('/mydir');
      } catch (err: any) {
        expect(err.code).toBe('EISDIR');
      }
    });

    it('should handle empty file content', () => {
      mockFs.writeFileSync('/empty.txt', '');
      expect(mockFs.readFileSync('/empty.txt')).toBe('');
    });

    it('should coerce non-string content to string', () => {
      mockFs.writeFileSync('/num.txt', 42 as any);
      expect(mockFs.readFileSync('/num.txt')).toBe('42');
    });
  });

  // =========================================================================
  // mkdirSync
  // =========================================================================
  describe('mkdirSync', () => {
    it('should create a directory (non-recursive)', () => {
      mockFs.mkdirSync('/newdir');
      expect(mockFs.existsSync('/newdir')).toBe(true);
    });

    it('should throw EEXIST if directory already exists (non-recursive)', () => {
      mockFs.mkdirSync('/existing');
      expect(() => mockFs.mkdirSync('/existing')).toThrow();
      try {
        mockFs.mkdirSync('/existing');
      } catch (err: any) {
        expect(err.code).toBe('EEXIST');
      }
    });

    it('should create nested directories with recursive option', () => {
      mockFs.mkdirSync('/a/b/c', { recursive: true });
      expect(mockFs.existsSync('/a')).toBe(true);
      expect(mockFs.existsSync('/a/b')).toBe(true);
      expect(mockFs.existsSync('/a/b/c')).toBe(true);
    });

    it('should not throw when recursive mkdir on existing directory', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      expect(() => mockFs.mkdirSync('/dir', { recursive: true })).not.toThrow();
    });

    it('should create intermediate directories that do not exist', () => {
      mockFs.mkdirSync('/deep/nested/path', { recursive: true });
      // All intermediate paths should exist
      expect(mockFs.existsSync('/deep')).toBe(true);
      expect(mockFs.existsSync('/deep/nested')).toBe(true);
      expect(mockFs.existsSync('/deep/nested/path')).toBe(true);
    });
  });

  // =========================================================================
  // readdirSync
  // =========================================================================
  describe('readdirSync', () => {
    it('should throw ENOENT for non-existent directory', () => {
      expect(() => mockFs.readdirSync('/nope')).toThrow();
      try {
        mockFs.readdirSync('/nope');
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }
    });

    it('should throw ENOENT when path is a file', () => {
      mockFs.writeFileSync('/file.txt', 'data');
      expect(() => mockFs.readdirSync('/file.txt')).toThrow();
    });

    it('should return names of direct children', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.writeFileSync('/dir/a.txt', 'a');
      mockFs.writeFileSync('/dir/b.txt', 'b');
      const entries = mockFs.readdirSync('/dir') as string[];
      expect(entries).toContain('a.txt');
      expect(entries).toContain('b.txt');
      expect(entries).toHaveLength(2);
    });

    it('should not include nested files (only direct children)', () => {
      mockFs.mkdirSync('/dir/sub', { recursive: true });
      mockFs.writeFileSync('/dir/a.txt', 'a');
      mockFs.writeFileSync('/dir/sub/deep.txt', 'deep');
      const entries = mockFs.readdirSync('/dir') as string[];
      expect(entries).toContain('a.txt');
      expect(entries).toContain('sub');
      expect(entries).toHaveLength(2);
      // deep.txt is NOT a direct child
      expect(entries).not.toContain('deep.txt');
    });

    it('should return empty array for empty directory', () => {
      mockFs.mkdirSync('/empty-dir', { recursive: true });
      const entries = mockFs.readdirSync('/empty-dir') as string[];
      expect(entries).toHaveLength(0);
    });

    it('should support withFileTypes option', () => {
      mockFs.mkdirSync('/mixed', { recursive: true });
      mockFs.mkdirSync('/mixed/subdir', { recursive: true });
      mockFs.writeFileSync('/mixed/file.txt', 'data');

      const entries = mockFs.readdirSync('/mixed', { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;

      expect(entries).toHaveLength(2);
      const dirEntry = entries.find((e) => e.name === 'subdir');
      const fileEntry = entries.find((e) => e.name === 'file.txt');

      expect(dirEntry).toBeDefined();
      expect(dirEntry!.isDirectory()).toBe(true);
      expect(dirEntry!.isFile()).toBe(false);

      expect(fileEntry).toBeDefined();
      expect(fileEntry!.isFile()).toBe(true);
      expect(fileEntry!.isDirectory()).toBe(false);
    });

    it('should deduplicate entries (each name appears once)', () => {
      mockFs.mkdirSync('/d', { recursive: true });
      mockFs.writeFileSync('/d/item.txt', 'a');
      // Write to a nested path that shares the first component
      mockFs.mkdirSync('/d/item.txt.bak', { recursive: true });
      const entries = mockFs.readdirSync('/d') as string[];
      const itemCount = entries.filter((e) => e === 'item.txt').length;
      expect(itemCount).toBe(1);
    });
  });

  // =========================================================================
  // rmSync
  // =========================================================================
  describe('rmSync', () => {
    it('should remove a file', () => {
      mockFs.writeFileSync('/file.txt', 'data');
      mockFs.rmSync('/file.txt');
      expect(mockFs.existsSync('/file.txt')).toBe(false);
    });

    it('should throw ENOENT for non-existent path without force', () => {
      expect(() => mockFs.rmSync('/nope')).toThrow();
      try {
        mockFs.rmSync('/nope');
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }
    });

    it('should not throw with force option for non-existent path', () => {
      expect(() => mockFs.rmSync('/nope', { force: true })).not.toThrow();
    });

    it('should remove directory and children with recursive option', () => {
      mockFs.mkdirSync('/dir/sub', { recursive: true });
      mockFs.writeFileSync('/dir/a.txt', 'a');
      mockFs.writeFileSync('/dir/sub/b.txt', 'b');

      mockFs.rmSync('/dir', { recursive: true });

      expect(mockFs.existsSync('/dir')).toBe(false);
      expect(mockFs.existsSync('/dir/a.txt')).toBe(false);
      expect(mockFs.existsSync('/dir/sub')).toBe(false);
      expect(mockFs.existsSync('/dir/sub/b.txt')).toBe(false);
    });

    it('should remove only the target entry without recursive', () => {
      mockFs.writeFileSync('/file.txt', 'data');
      mockFs.rmSync('/file.txt');
      expect(mockFs.existsSync('/file.txt')).toBe(false);
    });
  });

  // =========================================================================
  // renameSync
  // =========================================================================
  describe('renameSync', () => {
    it('should rename a file', () => {
      mockFs.writeFileSync('/old.txt', 'content');
      mockFs.renameSync('/old.txt', '/new.txt');
      expect(mockFs.existsSync('/old.txt')).toBe(false);
      expect(mockFs.existsSync('/new.txt')).toBe(true);
      expect(mockFs.readFileSync('/new.txt')).toBe('content');
    });

    it('should throw ENOENT if source does not exist', () => {
      expect(() => mockFs.renameSync('/nope', '/target')).toThrow();
      try {
        mockFs.renameSync('/nope', '/target');
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }
    });

    it('should rename a directory and its children', () => {
      mockFs.mkdirSync('/olddir/sub', { recursive: true });
      mockFs.writeFileSync('/olddir/a.txt', 'a');
      mockFs.writeFileSync('/olddir/sub/b.txt', 'b');

      mockFs.renameSync('/olddir', '/newdir');

      expect(mockFs.existsSync('/olddir')).toBe(false);
      expect(mockFs.existsSync('/newdir')).toBe(true);
      expect(mockFs.existsSync('/newdir/a.txt')).toBe(true);
      expect(mockFs.existsSync('/newdir/sub')).toBe(true);
      expect(mockFs.existsSync('/newdir/sub/b.txt')).toBe(true);
      expect(mockFs.readFileSync('/newdir/a.txt')).toBe('a');
      expect(mockFs.readFileSync('/newdir/sub/b.txt')).toBe('b');
    });

    it('should overwrite destination if it exists', () => {
      mockFs.writeFileSync('/src.txt', 'source');
      mockFs.writeFileSync('/dst.txt', 'dest');
      mockFs.renameSync('/src.txt', '/dst.txt');
      expect(mockFs.existsSync('/src.txt')).toBe(false);
      expect(mockFs.readFileSync('/dst.txt')).toBe('source');
    });
  });

  // =========================================================================
  // chmodSync
  // =========================================================================
  describe('chmodSync', () => {
    it('should be a no-op (does not throw)', () => {
      mockFs.writeFileSync('/file.txt', 'data');
      expect(() => mockFs.chmodSync('/file.txt', 0o755)).not.toThrow();
    });
  });

  // =========================================================================
  // resetVfs
  // =========================================================================
  describe('resetVfs', () => {
    it('should clear all entries from the virtual filesystem', () => {
      mockFs.writeFileSync('/file1.txt', 'a');
      mockFs.writeFileSync('/file2.txt', 'b');
      mockFs.mkdirSync('/dir', { recursive: true });

      resetVfs();

      expect(mockFs.existsSync('/file1.txt')).toBe(false);
      expect(mockFs.existsSync('/file2.txt')).toBe(false);
      expect(mockFs.existsSync('/dir')).toBe(false);
    });

    it('should allow new writes after reset', () => {
      mockFs.writeFileSync('/before.txt', 'old');
      resetVfs();
      mockFs.writeFileSync('/after.txt', 'new');

      expect(mockFs.existsSync('/before.txt')).toBe(false);
      expect(mockFs.existsSync('/after.txt')).toBe(true);
      expect(mockFs.readFileSync('/after.txt')).toBe('new');
    });
  });

  // =========================================================================
  // Cross-operation behaviors
  // =========================================================================
  describe('cross-operation behaviors', () => {
    it('should handle mixed path separators (backslashes)', () => {
      mockFs.writeFileSync('/path/to/file.txt', 'data');
      expect(mockFs.existsSync('\\path\\to\\file.txt')).toBe(true);
      expect(mockFs.readFileSync('\\path\\to/file.txt')).toBe('data');
    });

    it('should maintain isolation between files and directories', () => {
      mockFs.mkdirSync('/dir', { recursive: true });
      mockFs.writeFileSync('/dir/file.txt', 'content');

      // Directory and file coexist
      const entries = mockFs.readdirSync('/dir', { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('file.txt');
      expect(entries[0].isFile()).toBe(true);
    });

    it('should correctly track state across multiple operations', () => {
      // Create nested structure
      mockFs.mkdirSync('/app/config', { recursive: true });
      mockFs.writeFileSync('/app/config/settings.json', '{"theme":"dark"}');

      // Read and verify
      expect(mockFs.readFileSync('/app/config/settings.json')).toBe('{"theme":"dark"}');

      // Rename config dir
      mockFs.renameSync('/app/config', '/app/settings');

      // Verify old path gone, new path works
      expect(mockFs.existsSync('/app/config')).toBe(false);
      expect(mockFs.readFileSync('/app/settings/settings.json')).toBe('{"theme":"dark"}');

      // Delete recursively
      mockFs.rmSync('/app', { recursive: true });
      expect(mockFs.existsSync('/app')).toBe(false);
    });
  });
});
