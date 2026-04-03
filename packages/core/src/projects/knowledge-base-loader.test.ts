/**
 * Tests for KnowledgeBaseLoader.
 *
 * Issue #1916: Tests the knowledge base file loading and formatting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KnowledgeBaseLoader } from './knowledge-base-loader.js';

describe('KnowledgeBaseLoader', () => {
  let loader: KnowledgeBaseLoader;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kb-test-'));
    loader = new KnowledgeBaseLoader();
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadFromDirectories', () => {
    it('should return empty result for empty directories list', async () => {
      const result = await loader.loadFromDirectories([]);
      expect(result.content).toBe('');
      expect(result.fileCount).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('should return empty result for non-existent directory', async () => {
      const result = await loader.loadFromDirectories(['/nonexistent/path']);
      expect(result.content).toBe('');
      expect(result.fileCount).toBe(0);
    });

    it('should load markdown files from a directory', async () => {
      // Create test files
      await fs.promises.mkdir(path.join(tempDir, 'docs'));
      await fs.promises.writeFile(
        path.join(tempDir, 'docs', 'guide.md'),
        '# Guide\n\nThis is a guide.'
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'docs', 'readme.txt'),
        'Readme content here.'
      );

      const result = await loader.loadFromDirectories([path.join(tempDir, 'docs')]);

      expect(result.fileCount).toBe(2);
      expect(result.content).toContain('guide.md');
      expect(result.content).toContain('This is a guide');
      expect(result.content).toContain('readme.txt');
      expect(result.content).toContain('Readme content here');
      expect(result.truncated).toBe(false);
    });

    it('should skip binary files', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'mixed'));
      await fs.promises.writeFile(
        path.join(tempDir, 'mixed', 'text.md'),
        '# Text'
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'mixed', 'image.png'),
        Buffer.from([0x89, 0x50, 0x4E, 0x47]) // PNG header
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'mixed', 'data.pdf'),
        'fake pdf content'
      );

      const result = await loader.loadFromDirectories([path.join(tempDir, 'mixed')]);

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain('text.md');
      expect(result.content).not.toContain('image.png');
      expect(result.content).not.toContain('data.pdf');
    });

    it('should skip node_modules directory', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'node_modules', 'pkg'), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, 'node_modules', 'pkg', 'index.md'),
        '# Package'
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'real.md'),
        '# Real'
      );

      const result = await loader.loadFromDirectories([tempDir]);

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain('real.md');
      expect(result.content).not.toContain('Package');
    });

    it('should skip hidden directories', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.hidden'));
      await fs.promises.writeFile(
        path.join(tempDir, '.hidden', 'secret.md'),
        '# Secret'
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'visible.md'),
        '# Visible'
      );

      const result = await loader.loadFromDirectories([tempDir]);

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain('visible.md');
      expect(result.content).not.toContain('Secret');
    });

    it('should truncate content when exceeding maxTotalSize', async () => {
      const smallLoader = new KnowledgeBaseLoader({ maxTotalSize: 100 });

      await fs.promises.mkdir(path.join(tempDir, 'big'));
      await fs.promises.writeFile(
        path.join(tempDir, 'big', 'file1.md'),
        '# File 1\n\n' + 'A'.repeat(200)
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'big', 'file2.md'),
        '# File 2\n\n' + 'B'.repeat(200)
      );

      const result = await loader.loadFromDirectories([path.join(tempDir, 'big')]);
      const smallResult = await smallLoader.loadFromDirectories([path.join(tempDir, 'big')]);

      expect(result.fileCount).toBe(2);
      expect(smallResult.truncated).toBe(true);
      expect(smallResult.fileCount).toBeLessThan(2);
    });

    it('should skip files exceeding maxFileSize', async () => {
      const strictLoader = new KnowledgeBaseLoader({ maxFileSize: 10 });

      await fs.promises.mkdir(path.join(tempDir, 'sizes'));
      await fs.promises.writeFile(
        path.join(tempDir, 'sizes', 'small.md'),
        '# Small'
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'sizes', 'big.md'),
        '# Big\n\n' + 'X'.repeat(10000)
      );

      const result = await strictLoader.loadFromDirectories([path.join(tempDir, 'sizes')]);

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain('small.md');
      expect(result.content).not.toContain('big.md');
    });

    it('should scan subdirectories recursively', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'level1', 'level2'), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, 'level1', 'a.md'),
        '# Level 1'
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'level1', 'level2', 'b.md'),
        '# Level 2'
      );

      const result = await loader.loadFromDirectories([tempDir]);

      expect(result.fileCount).toBe(2);
      expect(result.content).toContain('Level 1');
      expect(result.content).toContain('Level 2');
    });

    it('should filter by file extension', async () => {
      const customLoader = new KnowledgeBaseLoader({
        fileExtensions: ['.md'],
      });

      await fs.promises.mkdir(path.join(tempDir, 'filtered'));
      await fs.promises.writeFile(
        path.join(tempDir, 'filtered', 'doc.md'),
        '# Markdown'
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'filtered', 'data.csv'),
        'col1,col2\nval1,val2'
      );

      const result = await customLoader.loadFromDirectories([path.join(tempDir, 'filtered')]);

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain('doc.md');
      expect(result.content).not.toContain('data.csv');
    });

    it('should handle multiple directories', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'dir1'));
      await fs.promises.mkdir(path.join(tempDir, 'dir2'));
      await fs.promises.writeFile(path.join(tempDir, 'dir1', 'a.md'), '# A');
      await fs.promises.writeFile(path.join(tempDir, 'dir2', 'b.md'), '# B');

      const result = await loader.loadFromDirectories([
        path.join(tempDir, 'dir1'),
        path.join(tempDir, 'dir2'),
      ]);

      expect(result.fileCount).toBe(2);
      expect(result.content).toContain('a.md');
      expect(result.content).toContain('b.md');
    });

    it('should gracefully handle unreadable files', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'perms'));
      await fs.promises.writeFile(path.join(tempDir, 'perms', 'good.md'), '# Good');
      // Create a file and make it unreadable (may not work on all platforms)
      const badFile = path.join(tempDir, 'perms', 'bad.md');
      await fs.promises.writeFile(badFile, '# Bad');
      try {
        await fs.promises.chmod(badFile, 0o000);
      } catch {
        // chmod may fail on Windows, skip this test
      }

      const result = await loader.loadFromDirectories([path.join(tempDir, 'perms')]);

      // Should at least load the good file
      expect(result.fileCount).toBeGreaterThanOrEqual(1);
      expect(result.content).toContain('good.md');

      // Restore permissions for cleanup
      try {
        await fs.promises.chmod(badFile, 0o644);
      } catch {
        // Ignore
      }
    });
  });

  describe('formatKnowledgeContent', () => {
    it('should format files with relative paths as headers', () => {
      const files = [
        {
          path: '/root/docs/guide.md',
          content: '# Guide\n\nContent here',
          size: 24,
          relativePath: 'docs/guide.md',
        },
        {
          path: '/root/data/readme.txt',
          content: 'Readme content',
          size: 14,
          relativePath: 'data/readme.txt',
        },
      ];

      const result = loader.formatKnowledgeContent(files);

      expect(result.content).toContain('### 📄 docs/guide.md');
      expect(result.content).toContain('### 📄 data/readme.txt');
      expect(result.content).toContain('# Guide');
      expect(result.content).toContain('Readme content');
      expect(result.fileCount).toBe(2);
      expect(result.files).toEqual(['docs/guide.md', 'data/readme.txt']);
    });

    it('should separate files with horizontal rules', () => {
      const files = [
        { path: '/a.md', content: 'A', size: 1, relativePath: 'a.md' },
        { path: '/b.md', content: 'B', size: 1, relativePath: 'b.md' },
      ];

      const result = loader.formatKnowledgeContent(files);

      expect(result.content).toContain('---\n\n### 📄 b.md');
    });
  });
});
