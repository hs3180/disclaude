/**
 * Tests for Knowledge Loader module.
 *
 * Issue #1916: Tests for project instructions and knowledge base loading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadKnowledge, formatKnowledgeForPrompt } from './knowledge-loader.js';
import type { KnowledgeConfig } from '../config/types.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `knowledge-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function createFile(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('loadKnowledge', () => {
  it('should return empty result when no config is provided', () => {
    const result = loadKnowledge({});
    expect(result.instructions).toBeUndefined();
    expect(result.files).toHaveLength(0);
    expect(result.totalChars).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('should load project instructions from CLAUDE.md', () => {
    createFile(testDir, 'CLAUDE.md', 'Always respond in Japanese.');
    const config: KnowledgeConfig = {
      instructionsPath: join(testDir, 'CLAUDE.md'),
    };

    const result = loadKnowledge(config);
    expect(result.instructions).toBe('Always respond in Japanese.');
    expect(result.instructionsPath).toContain('CLAUDE.md');
    expect(result.totalChars).toBe('Always respond in Japanese.'.length);
  });

  it('should handle missing instructions file gracefully', () => {
    const config: KnowledgeConfig = {
      instructionsPath: join(testDir, 'nonexistent.md'),
    };

    const result = loadKnowledge(config);
    expect(result.instructions).toBeUndefined();
    expect(result.files).toHaveLength(0);
  });

  it('should load knowledge files from directories', () => {
    const knowledgeDir = join(testDir, 'docs');
    mkdirSync(knowledgeDir, { recursive: true });
    createFile(knowledgeDir, 'guide.md', '# Guide\nSome guide content.');
    createFile(knowledgeDir, 'readme.txt', 'Readme content.');

    const config: KnowledgeConfig = {
      knowledgeDirs: [knowledgeDir],
    };

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.relativePath).sort()).toEqual(['guide.md', 'readme.txt']);
  });

  it('should only include configured file extensions', () => {
    const knowledgeDir = join(testDir, 'docs');
    mkdirSync(knowledgeDir, { recursive: true });
    createFile(knowledgeDir, 'guide.md', 'Markdown content.');
    createFile(knowledgeDir, 'data.json', '{"key": "value"}');
    createFile(knowledgeDir, 'notes.txt', 'Text notes.');

    const config: KnowledgeConfig = {
      knowledgeDirs: [knowledgeDir],
      includeExtensions: ['.md'],
    };

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe('guide.md');
  });

  it('should exclude directories matching exclude patterns', () => {
    const knowledgeDir = join(testDir, 'docs');
    mkdirSync(join(knowledgeDir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(knowledgeDir, '.git', 'objects'), { recursive: true });
    createFile(knowledgeDir, 'guide.md', 'Guide content.');
    createFile(join(knowledgeDir, 'node_modules', 'pkg'), 'index.md', 'Package content.');
    createFile(join(knowledgeDir, '.git', 'objects'), 'readme.md', 'Git content.');

    const config: KnowledgeConfig = {
      knowledgeDirs: [knowledgeDir],
    };

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe('guide.md');
  });

  it('should handle non-existent knowledge directory gracefully', () => {
    const config: KnowledgeConfig = {
      knowledgeDirs: [join(testDir, 'nonexistent')],
    };

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(0);
  });

  it('should truncate files when total exceeds maxKnowledgeChars', () => {
    createFile(testDir, 'CLAUDE.md', 'Instructions.');
    const knowledgeDir = join(testDir, 'docs');
    mkdirSync(knowledgeDir, { recursive: true });
    createFile(knowledgeDir, 'a.md', 'x'.repeat(100));
    createFile(knowledgeDir, 'b.md', 'x'.repeat(100));

    const config: KnowledgeConfig = {
      instructionsPath: join(testDir, 'CLAUDE.md'),
      knowledgeDirs: [knowledgeDir],
      maxKnowledgeChars: 150,
    };

    const result = loadKnowledge(config);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBeLessThanOrEqual(150);
  });

  it('should load both instructions and knowledge files together', () => {
    createFile(testDir, 'CLAUDE.md', '# Project\nCustom instructions.');
    const knowledgeDir = join(testDir, 'docs');
    mkdirSync(knowledgeDir, { recursive: true });
    createFile(knowledgeDir, 'api.md', '# API\nAPI documentation.');

    const config: KnowledgeConfig = {
      instructionsPath: join(testDir, 'CLAUDE.md'),
      knowledgeDirs: [knowledgeDir],
    };

    const result = loadKnowledge(config);
    expect(result.instructions).toContain('Custom instructions.');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toContain('API documentation');
  });

  it('should scan subdirectories recursively', () => {
    const knowledgeDir = join(testDir, 'docs');
    mkdirSync(join(knowledgeDir, 'sub', 'deep'), { recursive: true });
    createFile(knowledgeDir, 'root.md', 'Root file.');
    createFile(join(knowledgeDir, 'sub'), 'sub.md', 'Sub file.');
    createFile(join(knowledgeDir, 'sub', 'deep'), 'deep.md', 'Deep file.');

    const config: KnowledgeConfig = {
      knowledgeDirs: [knowledgeDir],
    };

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(3);
  });
});

describe('formatKnowledgeForPrompt', () => {
  it('should return empty string for empty knowledge', () => {
    const result = formatKnowledgeForPrompt({ files: [], totalChars: 0, truncated: false });
    expect(result).toBe('');
  });

  it('should format instructions into prompt section', () => {
    const result = formatKnowledgeForPrompt({
      instructions: 'Always be concise.',
      files: [],
      totalChars: 19,
      truncated: false,
    });

    expect(result).toContain('Project Instructions');
    expect(result).toContain('Always be concise.');
  });

  it('should format knowledge files into prompt section', () => {
    const result = formatKnowledgeForPrompt({
      files: [
        { relativePath: 'guide.md', absolutePath: '/tmp/guide.md', content: '# Guide', size: 7 },
      ],
      totalChars: 7,
      truncated: false,
    });

    expect(result).toContain('Knowledge Base');
    expect(result).toContain('guide.md');
    expect(result).toContain('# Guide');
  });

  it('should include truncation warning when truncated', () => {
    const result = formatKnowledgeForPrompt({
      instructions: 'Instructions',
      files: [
        { relativePath: 'a.md', absolutePath: '/tmp/a.md', content: 'A', size: 1 },
      ],
      totalChars: 100,
      truncated: true,
    });

    expect(result).toContain('truncated');
    expect(result).toContain('size limits');
  });

  it('should combine instructions and knowledge files', () => {
    const result = formatKnowledgeForPrompt({
      instructions: 'Project rules.',
      files: [
        { relativePath: 'docs.md', absolutePath: '/tmp/docs.md', content: 'Docs content.', size: 13 },
      ],
      totalChars: 25,
      truncated: false,
    });

    expect(result).toContain('Project Instructions');
    expect(result).toContain('Project rules.');
    expect(result).toContain('Knowledge Base');
    expect(result).toContain('docs.md');
    expect(result).toContain('Docs content.');
  });
});
