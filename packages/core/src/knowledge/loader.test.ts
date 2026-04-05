/**
 * Tests for knowledge base loader.
 * @module knowledge/loader.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { loadProjectKnowledge, buildKnowledgeSection } from './loader.js';

describe('KnowledgeLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadProjectKnowledge', () => {
    it('should load project instructions from CLAUDE.md', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(instructionsPath, '# Project Instructions\n\nBe helpful.');

      const result = await loadProjectKnowledge('test', {
        instructions_path: instructionsPath,
      }, tempDir);

      expect(result.projectFound).toBe(true);
      expect(result.instructions).toContain('# Project Instructions');
      expect(result.instructions).toContain('Be helpful.');
      expect(result.totalChars).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle missing instructions file gracefully', async () => {
      const result = await loadProjectKnowledge('test', {
        instructions_path: path.join(tempDir, 'nonexistent.md'),
      }, tempDir);

      expect(result.projectFound).toBe(true);
      expect(result.instructions).toBeUndefined();
      // Missing files are handled gracefully without errors
      expect(result.errors).toHaveLength(0);
    });

    it('should load knowledge files from directories', async () => {
      const knowledgeDir = path.join(tempDir, 'docs');
      await fs.mkdir(knowledgeDir);
      await fs.writeFile(path.join(knowledgeDir, 'guide.md'), '# Guide\n\nSome content.');
      await fs.writeFile(path.join(knowledgeDir, 'readme.txt'), 'Readme content.');

      const result = await loadProjectKnowledge('test', {
        knowledge: [knowledgeDir],
      }, tempDir);

      expect(result.files).toHaveLength(2);
      expect(result.knowledgeContent).toContain('# Guide');
      expect(result.knowledgeContent).toContain('Readme content');
      expect(result.totalChars).toBeGreaterThan(0);
    });

    it('should skip unsupported file types', async () => {
      const knowledgeDir = path.join(tempDir, 'docs');
      await fs.mkdir(knowledgeDir);
      await fs.writeFile(path.join(knowledgeDir, 'code.ts'), 'const x = 1;');
      await fs.writeFile(path.join(knowledgeDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));

      const result = await loadProjectKnowledge('test', {
        knowledge: [knowledgeDir],
      }, tempDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].extension).toBe('.ts');
    });

    it('should skip hidden files and node_modules', async () => {
      const knowledgeDir = path.join(tempDir, 'docs');
      await fs.mkdir(path.join(knowledgeDir, '.hidden'), { recursive: true });
      await fs.mkdir(path.join(knowledgeDir, 'node_modules'), { recursive: true });
      await fs.mkdir(path.join(knowledgeDir, 'normal'), { recursive: true });

      await fs.writeFile(path.join(knowledgeDir, '.hidden', 'secret.md'), 'Hidden');
      await fs.writeFile(path.join(knowledgeDir, 'node_modules', 'pkg.md'), 'Package');
      await fs.writeFile(path.join(knowledgeDir, 'normal', 'visible.md'), 'Visible');

      const result = await loadProjectKnowledge('test', {
        knowledge: [knowledgeDir],
      }, tempDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].relativePath).toContain('visible.md');
    });

    it('should handle nonexistent knowledge directory gracefully', async () => {
      const result = await loadProjectKnowledge('test', {
        knowledge: [path.join(tempDir, 'nonexistent')],
      }, tempDir);

      expect(result.files).toHaveLength(0);
      expect(result.knowledgeContent).toBe('');
    });

    it('should truncate content exceeding max chars', async () => {
      const knowledgeDir = path.join(tempDir, 'docs');
      await fs.mkdir(knowledgeDir);
      // Create a large file
      const largeContent = 'x'.repeat(200_000);
      await fs.writeFile(path.join(knowledgeDir, 'large.md'), largeContent);

      const result = await loadProjectKnowledge('test', {
        knowledge: [knowledgeDir],
      }, tempDir);

      // Content should be truncated but not empty
      expect(result.totalChars).toBeLessThan(800_000);
      expect(result.totalChars).toBeGreaterThan(0);
    });

    it('should load from multiple knowledge directories', async () => {
      const docsDir = path.join(tempDir, 'docs');
      const dataDir = path.join(tempDir, 'data');
      await fs.mkdir(docsDir);
      await fs.mkdir(dataDir);
      await fs.writeFile(path.join(docsDir, 'doc.md'), 'Documentation.');
      await fs.writeFile(path.join(dataDir, 'info.txt'), 'Information.');

      const result = await loadProjectKnowledge('test', {
        knowledge: [docsDir, dataDir],
      }, tempDir);

      expect(result.files).toHaveLength(2);
      expect(result.knowledgeContent).toContain('Documentation.');
      expect(result.knowledgeContent).toContain('Information.');
    });

    it('should load both instructions and knowledge', async () => {
      const instructionsPath = path.join(tempDir, 'CLAUDE.md');
      const knowledgeDir = path.join(tempDir, 'docs');
      await fs.mkdir(knowledgeDir);

      await fs.writeFile(instructionsPath, '# Instructions');
      await fs.writeFile(path.join(knowledgeDir, 'doc.md'), '# Doc');

      const result = await loadProjectKnowledge('test', {
        instructions_path: instructionsPath,
        knowledge: [knowledgeDir],
      }, tempDir);

      expect(result.instructions).toContain('# Instructions');
      expect(result.files).toHaveLength(1);
      expect(result.knowledgeContent).toContain('# Doc');
    });
  });

  describe('buildKnowledgeSection', () => {
    it('should return empty string for project with no content', () => {
      const result = {
        projectName: 'empty',
        projectFound: true,
        files: [],
        knowledgeContent: '',
        totalChars: 0,
        truncated: false,
        errors: [],
      };

      expect(buildKnowledgeSection(result)).toBe('');
    });

    it('should build section with instructions', () => {
      const result = {
        projectName: 'test',
        projectFound: true,
        instructions: '# Instructions\n\nBe helpful.',
        instructionsPath: '/path/to/CLAUDE.md',
        files: [],
        knowledgeContent: '',
        totalChars: 25,
        truncated: false,
        errors: [],
      };

      const section = buildKnowledgeSection(result);
      expect(section).toContain('## Project Knowledge: test');
      expect(section).toContain('# Instructions');
      expect(section).toContain('Be helpful.');
    });

    it('should build section with knowledge content', () => {
      const result = {
        projectName: 'test',
        projectFound: true,
        files: [{ relativePath: 'doc.md', absolutePath: '/path/doc.md', size: 100, extension: '.md' }],
        knowledgeContent: '### doc.md\n\nContent here.',
        totalChars: 30,
        truncated: false,
        errors: [],
      };

      const section = buildKnowledgeSection(result);
      expect(section).toContain('## Project Knowledge: test');
      expect(section).toContain('### Knowledge Base');
      expect(section).toContain('doc.md');
      expect(section).toContain('Content here.');
      expect(section).toContain('1 file(s)');
    });

    it('should include truncation warning when truncated', () => {
      const result = {
        projectName: 'test',
        projectFound: true,
        files: [{ relativePath: 'large.md', absolutePath: '/path/large.md', size: 900000, extension: '.md' }],
        knowledgeContent: 'Big content...',
        totalChars: 800_000,
        truncated: true,
        errors: [],
      };

      const section = buildKnowledgeSection(result);
      expect(section).toContain('truncated');
    });
  });
});
