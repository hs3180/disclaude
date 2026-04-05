/**
 * Tests for Knowledge Loader.
 * Issue #1916: Project Knowledge Base feature.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  isSupportedKnowledgeFile,
  loadKnowledgeEntries,
  loadInstructions,
  formatProjectAsPromptSection,
} from './knowledge-loader.js';
import type { LoadedProject } from './types.js';
import { DEFAULT_MAX_KNOWLEDGE_LENGTH } from './types.js';

describe('knowledge-loader', () => {
  describe('isSupportedKnowledgeFile', () => {
    it('should return true for supported text formats', () => {
      expect(isSupportedKnowledgeFile('readme.md')).toBe(true);
      expect(isSupportedKnowledgeFile('doc.txt')).toBe(true);
      expect(isSupportedKnowledgeFile('config.json')).toBe(true);
      expect(isSupportedKnowledgeFile('settings.yaml')).toBe(true);
      expect(isSupportedKnowledgeFile('app.ts')).toBe(true);
      expect(isSupportedKnowledgeFile('index.js')).toBe(true);
      expect(isSupportedKnowledgeFile('main.py')).toBe(true);
      expect(isSupportedKnowledgeFile('script.sh')).toBe(true);
    });

    it('should return false for unsupported binary formats', () => {
      expect(isSupportedKnowledgeFile('photo.png')).toBe(false);
      expect(isSupportedKnowledgeFile('image.jpg')).toBe(false);
      expect(isSupportedKnowledgeFile('data.pdf')).toBe(false);
      expect(isSupportedKnowledgeFile('archive.zip')).toBe(false);
      expect(isSupportedKnowledgeFile('song.mp3')).toBe(false);
    });

    it('should be case-insensitive for extensions', () => {
      expect(isSupportedKnowledgeFile('README.MD')).toBe(true);
      expect(isSupportedKnowledgeFile('Doc.TXT')).toBe(true);
    });

    it('should handle files without extensions', () => {
      // Files without extensions are not in the supported set
      // since the set only contains extensions with leading dots
      expect(isSupportedKnowledgeFile('Makefile')).toBe(false);
      expect(isSupportedKnowledgeFile('Dockerfile')).toBe(false);
    });
  });

  describe('loadKnowledgeEntries', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should load files from a directory', async () => {
      // Create test files
      await fs.writeFile(path.join(tempDir, 'guide.md'), '# Guide\n\nSome content');
      await fs.writeFile(path.join(tempDir, 'config.json'), '{"key": "value"}');

      const entries = await loadKnowledgeEntries([tempDir]);

      expect(entries).toHaveLength(2);
      expect(entries.some(e => e.relativePath === 'guide.md')).toBe(true);
      expect(entries.some(e => e.relativePath === 'config.json')).toBe(true);
      expect(entries.every(e => e.content.length > 0)).toBe(true);
    });

    it('should skip binary files', async () => {
      await fs.writeFile(path.join(tempDir, 'readme.md'), '# Readme');
      await fs.writeFile(path.join(tempDir, 'photo.png'), 'binary data');

      const entries = await loadKnowledgeEntries([tempDir]);

      expect(entries).toHaveLength(1);
      expect(entries[0].relativePath).toBe('readme.md');
    });

    it('should skip hidden files and directories', async () => {
      await fs.writeFile(path.join(tempDir, 'visible.md'), '# Visible');
      await fs.writeFile(path.join(tempDir, '.hidden.md'), '# Hidden');
      await fs.mkdir(path.join(tempDir, '.hidden-dir'));

      const entries = await loadKnowledgeEntries([tempDir]);

      expect(entries).toHaveLength(1);
      expect(entries[0].relativePath).toBe('visible.md');
    });

    it('should skip node_modules and dist directories', async () => {
      await fs.writeFile(path.join(tempDir, 'app.ts'), 'export default {}');
      await fs.mkdir(path.join(tempDir, 'node_modules'));
      await fs.mkdir(path.join(tempDir, 'node_modules', 'pkg'));
      await fs.writeFile(path.join(tempDir, 'node_modules', 'pkg', 'index.js'), 'module code');
      await fs.mkdir(path.join(tempDir, 'dist'));
      await fs.writeFile(path.join(tempDir, 'dist', 'bundle.js'), 'bundled code');

      const entries = await loadKnowledgeEntries([tempDir]);

      expect(entries).toHaveLength(1);
      expect(entries[0].relativePath).toBe('app.ts');
    });

    it('should handle non-existent paths gracefully', async () => {
      const entries = await loadKnowledgeEntries(['/non/existent/path']);

      expect(entries).toHaveLength(0);
    });

    it('should load a single file directly', async () => {
      const filePath = path.join(tempDir, 'instructions.md');
      await fs.writeFile(filePath, '# Instructions\n\nFollow these rules.');

      const entries = await loadKnowledgeEntries([filePath]);

      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('# Instructions\n\nFollow these rules.');
      expect(entries[0].absolutePath).toBe(filePath);
    });

    it('should recursively scan subdirectories', async () => {
      await fs.mkdir(path.join(tempDir, 'docs'));
      await fs.mkdir(path.join(tempDir, 'docs', 'api'));
      await fs.writeFile(path.join(tempDir, 'docs', 'guide.md'), '# Guide');
      await fs.writeFile(path.join(tempDir, 'docs', 'api', 'reference.md'), '# Reference');

      const entries = await loadKnowledgeEntries([tempDir]);

      expect(entries).toHaveLength(2);
      const relativePaths = entries.map(e => e.relativePath).sort();
      expect(relativePaths).toContain(path.join('docs', 'guide.md'));
      expect(relativePaths).toContain(path.join('docs', 'api', 'reference.md'));
    });
  });

  describe('loadInstructions', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'instructions-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should load instructions from existing file', async () => {
      const filePath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(filePath, '# Project Instructions\n\nBe helpful.');

      const content = await loadInstructions(filePath);

      expect(content).toBe('# Project Instructions\n\nBe helpful.');
    });

    it('should return null for non-existent file', async () => {
      const content = await loadInstructions('/non/existent/CLAUDE.md');

      expect(content).toBeNull();
    });

    it('should return null for a directory path', async () => {
      const content = await loadInstructions(tempDir);

      expect(content).toBeNull();
    });
  });

  describe('formatProjectAsPromptSection', () => {
    it('should format instructions and knowledge into a prompt section', () => {
      const project: LoadedProject = {
        name: 'test-project',
        instructions: '# Rules\n\nBe concise.',
        knowledge: [
          {
            relativePath: 'guide.md',
            absolutePath: '/tmp/guide.md',
            content: '# Guide\n\nSome info',
            size: 20,
          },
        ],
        truncated: false,
        originalLength: 20,
        totalLength: 20,
      };

      const section = formatProjectAsPromptSection(project);

      expect(section).toContain('--- Project Context: test-project ---');
      expect(section).toContain('## Project Instructions');
      expect(section).toContain('# Rules');
      expect(section).toContain('## Project Knowledge Base');
      expect(section).toContain('guide.md');
      expect(section).toContain('# Guide');
      expect(section).toContain('--- End Project Context ---');
    });

    it('should indicate truncation when applicable', () => {
      const project: LoadedProject = {
        name: 'test-project',
        instructions: null,
        knowledge: [
          {
            relativePath: 'large.md',
            absolutePath: '/tmp/large.md',
            content: 'x'.repeat(100),
            size: 100,
          },
        ],
        truncated: true,
        originalLength: 50000,
        totalLength: 100,
      };

      const section = formatProjectAsPromptSection(project);

      expect(section).toContain('truncated');
      expect(section).toContain('50,000');
    });

    it('should return empty string when project has no content', () => {
      const project: LoadedProject = {
        name: 'empty-project',
        instructions: null,
        knowledge: [],
        truncated: false,
        originalLength: 0,
        totalLength: 0,
      };

      const section = formatProjectAsPromptSection(project);

      expect(section).toBe('');
    });

    it('should handle instructions-only project', () => {
      const project: LoadedProject = {
        name: 'instructions-only',
        instructions: 'Always respond in French.',
        knowledge: [],
        truncated: false,
        originalLength: 0,
        totalLength: 0,
      };

      const section = formatProjectAsPromptSection(project);

      expect(section).toContain('## Project Instructions');
      expect(section).toContain('French');
      expect(section).not.toContain('Knowledge Base');
    });

    it('should handle knowledge-only project', () => {
      const project: LoadedProject = {
        name: 'knowledge-only',
        instructions: null,
        knowledge: [
          {
            relativePath: 'data.csv',
            absolutePath: '/tmp/data.csv',
            content: 'id,name\n1,test',
            size: 14,
          },
        ],
        truncated: false,
        originalLength: 14,
        totalLength: 14,
      };

      const section = formatProjectAsPromptSection(project);

      expect(section).not.toContain('## Project Instructions');
      expect(section).toContain('## Project Knowledge Base');
      expect(section).toContain('data.csv');
    });
  });

  describe('DEFAULT_MAX_KNOWLEDGE_LENGTH', () => {
    it('should be 50000 characters', () => {
      expect(DEFAULT_MAX_KNOWLEDGE_LENGTH).toBe(50000);
    });
  });
});
