/**
 * Tests for project context builder functions.
 *
 * Issue #1916: Tests for knowledge base and instructions
 * prompt section builders.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProjectContextSection,
  SUPPORTED_EXTENSIONS,
  DEFAULT_MAX_KNOWLEDGE_CHARS,
} from './context-builder.js';
import type { ProjectContext, KnowledgeFileEntry } from '../config/types.js';

describe('buildProjectContextSection', () => {
  it('should return empty string for null/undefined context', () => {
    expect(buildProjectContextSection(null as unknown as ProjectContext)).toBe('');
    expect(buildProjectContextSection(undefined as unknown as ProjectContext)).toBe('');
  });

  it('should return empty string for empty project context', () => {
    const ctx: ProjectContext = {
      name: 'default',
      knowledgeFiles: [],
      totalChars: 0,
    };
    expect(buildProjectContextSection(ctx)).toBe('');
  });

  it('should include project name for non-default projects', () => {
    const ctx: ProjectContext = {
      name: 'book-reader',
      instructions: 'Read books carefully.',
      knowledgeFiles: [],
      totalChars: 22,
    };
    const result = buildProjectContextSection(ctx);
    expect(result).toContain('book-reader');
    expect(result).toContain('Active Project');
  });

  it('should NOT include project name for default project', () => {
    const ctx: ProjectContext = {
      name: 'default',
      instructions: 'Be helpful.',
      knowledgeFiles: [],
      totalChars: 12,
    };
    const result = buildProjectContextSection(ctx);
    expect(result).not.toContain('Active Project');
    expect(result).toContain('Be helpful.');
  });

  it('should include instructions section when present', () => {
    const ctx: ProjectContext = {
      name: 'default',
      instructions: 'You are a helpful assistant that summarizes documents.',
      knowledgeFiles: [],
      totalChars: 52,
    };
    const result = buildProjectContextSection(ctx);
    expect(result).toContain('Project Instructions (CLAUDE.md)');
    expect(result).toContain('You are a helpful assistant');
  });

  it('should include knowledge base files', () => {
    const files: KnowledgeFileEntry[] = [
      {
        path: '/docs/readme.md',
        name: 'readme.md',
        content: '# Project README\n\nThis is a test.',
        size: 30,
        extension: 'md',
      },
    ];
    const ctx: ProjectContext = {
      name: 'default',
      knowledgeFiles: files,
      totalChars: 30,
    };
    const result = buildProjectContextSection(ctx);
    expect(result).toContain('Knowledge Base Files');
    expect(result).toContain('readme.md');
    expect(result).toContain('Project README');
    expect(result).toContain('MD');
  });

  it('should include multiple knowledge files', () => {
    const files: KnowledgeFileEntry[] = [
      {
        path: '/docs/readme.md',
        name: 'readme.md',
        content: 'README content',
        size: 14,
        extension: 'md',
      },
      {
        path: '/docs/config.json',
        name: 'config.json',
        content: '{"key": "value"}',
        size: 16,
        extension: 'json',
      },
    ];
    const ctx: ProjectContext = {
      name: 'default',
      knowledgeFiles: files,
      totalChars: 30,
    };
    const result = buildProjectContextSection(ctx);
    expect(result).toContain('2 files');
    expect(result).toContain('readme.md');
    expect(result).toContain('config.json');
  });

  it('should wrap knowledge file content in code blocks', () => {
    const files: KnowledgeFileEntry[] = [
      {
        path: '/docs/test.txt',
        name: 'test.txt',
        content: 'plain text content',
        size: 18,
        extension: 'txt',
      },
    ];
    const ctx: ProjectContext = {
      name: 'default',
      knowledgeFiles: files,
      totalChars: 18,
    };
    const result = buildProjectContextSection(ctx);
    expect(result).toContain('```\nplain text content\n```');
  });

  it('should include both instructions and knowledge base', () => {
    const files: KnowledgeFileEntry[] = [
      {
        path: '/docs/guide.md',
        name: 'guide.md',
        content: 'Guide content',
        size: 13,
        extension: 'md',
      },
    ];
    const ctx: ProjectContext = {
      name: 'custom-project',
      instructions: 'Custom instructions here.',
      knowledgeFiles: files,
      totalChars: 34,
    };
    const result = buildProjectContextSection(ctx);
    expect(result).toContain('custom-project');
    expect(result).toContain('Custom instructions here.');
    expect(result).toContain('guide.md');
    expect(result).toContain('Guide content');
  });
});

describe('SUPPORTED_EXTENSIONS', () => {
  it('should include common text formats', () => {
    expect(SUPPORTED_EXTENSIONS).toContain('md');
    expect(SUPPORTED_EXTENSIONS).toContain('txt');
    expect(SUPPORTED_EXTENSIONS).toContain('json');
    expect(SUPPORTED_EXTENSIONS).toContain('yaml');
    expect(SUPPORTED_EXTENSIONS).toContain('yml');
  });

  it('should include common programming languages', () => {
    expect(SUPPORTED_EXTENSIONS).toContain('ts');
    expect(SUPPORTED_EXTENSIONS).toContain('js');
    expect(SUPPORTED_EXTENSIONS).toContain('py');
    expect(SUPPORTED_EXTENSIONS).toContain('go');
    expect(SUPPORTED_EXTENSIONS).toContain('rs');
  });

  it('should be a readonly array', () => {
    expect(Object.isFrozen(SUPPORTED_EXTENSIONS)).toBe(true);
  });
});

describe('DEFAULT_MAX_KNOWLEDGE_CHARS', () => {
  it('should be a reasonable limit', () => {
    expect(DEFAULT_MAX_KNOWLEDGE_CHARS).toBe(100_000);
  });
});
