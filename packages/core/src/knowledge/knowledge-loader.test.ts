/**
 * Tests for KnowledgeLoader module.
 *
 * Issue #1916: Tests for project instructions and knowledge base loading.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadKnowledge, fsOps } from './knowledge-loader.js';
import type { KnowledgeConfig } from '../config/types.js';

// Helper to create mock file system state
function createMockFs(files: Record<string, string> = {}, dirs: string[] = []) {
  // Derive parent directories from file paths
  const derivedDirs = new Set<string>();
  for (const filePath of Object.keys(files)) {
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (parentDir) {
      derivedDirs.add(parentDir);
    }
  }

  return {
    readFileSync: vi.fn((filePath: string) => {
      const normalized = filePath.replace(/\\/g, '/');
      if (files[normalized] !== undefined) return files[normalized];
      if (files[filePath] !== undefined) return files[filePath];
      throw new Error(`ENOENT: no such file '${filePath}'`);
    }),
    readdirSync: vi.fn((dirPath: string) => {
      const normalized = dirPath.replace(/\\/g, '/');
      // Find entries under this directory
      const entries: string[] = [];
      for (const filePath of Object.keys(files)) {
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir === normalized) {
          entries.push(filePath.substring(filePath.lastIndexOf('/') + 1));
        }
      }
      for (const d of dirs) {
        const parent = d.substring(0, d.lastIndexOf('/'));
        if (parent === normalized) {
          entries.push(d.substring(d.lastIndexOf('/') + 1));
        }
      }
      if (entries.length === 0) {
        throw new Error(`ENOENT: no such directory '${dirPath}'`);
      }
      return entries;
    }),
    statSync: vi.fn((targetPath: string) => {
      const normalized = targetPath.replace(/\\/g, '/');
      if (files[normalized] !== undefined || files[targetPath] !== undefined) {
        return { isFile: () => true, isDirectory: () => false };
      }
      if (dirs.includes(normalized) || dirs.includes(targetPath) || derivedDirs.has(normalized)) {
        return { isFile: () => false, isDirectory: () => true };
      }
      throw new Error(`ENOENT: no such file or directory '${targetPath}'`);
    }),
    existsSync: vi.fn((targetPath: string) => {
      const normalized = targetPath.replace(/\\/g, '/');
      return files[normalized] !== undefined || files[targetPath] !== undefined ||
        dirs.includes(normalized) || dirs.includes(targetPath) ||
        derivedDirs.has(normalized);
    }),
  };
}

describe('loadKnowledge', () => {
  let originalFsOps: typeof fsOps;

  beforeEach(() => {
    originalFsOps = { ...fsOps };
  });

  afterEach(() => {
    // Restore original fsOps
    Object.assign(fsOps, originalFsOps);
  });

  it('should return empty content when no config is provided', () => {
    const result = loadKnowledge(undefined);
    expect(result.instructions).toBe('');
    expect(result.files).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.totalChars).toBe(0);
  });

  it('should return empty content when config has no paths or instructions', () => {
    const config: KnowledgeConfig = {};
    const mockFs = createMockFs();
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.instructions).toBe('');
    expect(result.files).toHaveLength(0);
  });

  it('should load project instructions from explicit path', () => {
    const config: KnowledgeConfig = {
      instructionsPath: '/project/CLAUDE.md',
    };
    const mockFs = createMockFs({
      '/project/CLAUDE.md': '# Project Instructions\n\nThis is a test project.',
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.instructions).toContain('Project Instructions');
    expect(result.instructions).toContain('This is a test project');
    expect(result.totalChars).toBeGreaterThan(0);
  });

  it('should auto-detect CLAUDE.md in workspace directory', () => {
    const config: KnowledgeConfig = {};
    const mockFs = createMockFs({
      '/workspace/CLAUDE.md': '# Auto-detected Instructions',
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config, '/workspace');
    expect(result.instructions).toContain('Auto-detected Instructions');
  });

  it('should not load instructions when explicitly disabled', () => {
    const config: KnowledgeConfig = {
      instructionsPath: 'disabled',
    };
    const mockFs = createMockFs({
      '/workspace/CLAUDE.md': '# Should not load',
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config, '/workspace');
    expect(result.instructions).toBe('');
  });

  it('should not load instructions when path does not exist', () => {
    const config: KnowledgeConfig = {
      instructionsPath: '/nonexistent/CLAUDE.md',
    };
    const mockFs = createMockFs();
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.instructions).toBe('');
  });

  it('should load knowledge files from configured directories', () => {
    const config: KnowledgeConfig = {
      paths: ['/docs'],
    };
    const mockFs = createMockFs(
      {
        '/docs/readme.md': '# Documentation\n\nSome docs content.',
        '/docs/guide.txt': 'Guide content here.',
        '/docs/image.png': 'binary content',
      },
      [] // no subdirs
    );
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    // Should load .md and .txt but skip .png (not in default extensions)
    const loadedPaths = result.files.map(f => f.path);
    expect(loadedPaths).toContain('/docs/readme.md');
    expect(loadedPaths).toContain('/docs/guide.txt');
    expect(loadedPaths).not.toContain('/docs/image.png');
    expect(result.files).toHaveLength(2);
  });

  it('should respect includeExtensions filter', () => {
    const config: KnowledgeConfig = {
      paths: ['/data'],
      includeExtensions: ['.md'],
    };
    const mockFs = createMockFs({
      '/data/readme.md': '# Markdown',
      '/data/data.txt': 'Text file',
      '/data/config.json': '{}',
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toContain('readme.md');
  });

  it('should handle extensions with and without leading dot', () => {
    const config: KnowledgeConfig = {
      paths: ['/data'],
      includeExtensions: ['md', '.txt'],
    };
    const mockFs = createMockFs({
      '/data/a.md': 'md content',
      '/data/b.txt': 'txt content',
      '/data/c.json': '{}',
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(2);
  });

  it('should load files from multiple directories', () => {
    const config: KnowledgeConfig = {
      paths: ['/docs', '/data'],
    };
    const mockFs = createMockFs({
      '/docs/a.md': 'docs content',
      '/data/b.md': 'data content',
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(2);
  });

  it('should truncate content when exceeding maxChars', () => {
    const config: KnowledgeConfig = {
      instructionsPath: '/workspace/CLAUDE.md',
      maxChars: 100,
    };
    const mockFs = createMockFs({
      '/workspace/CLAUDE.md': 'A'.repeat(200),
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.instructions.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it('should handle non-existent knowledge directories gracefully', () => {
    const config: KnowledgeConfig = {
      paths: ['/nonexistent'],
    };
    const mockFs = createMockFs();
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(0);
  });

  it('should skip unreadable files', () => {
    const config: KnowledgeConfig = {
      paths: ['/docs'],
    };
    const mockFs = createMockFs({
      '/docs/readable.md': 'Readable content',
    });
    // Override readFileSync to fail for specific file
    const originalRead = mockFs.readFileSync;
    mockFs.readFileSync = vi.fn((filePath: string) => {
      if (filePath.includes('unreadable')) {
        throw new Error('Permission denied');
      }
      return originalRead(filePath);
    });
    // Add the unreadable file to the mock
    mockFs.readdirSync = vi.fn(() => ['readable.md', 'unreadable.md']);
    mockFs.statSync = vi.fn(() => ({ isFile: () => true, isDirectory: () => false }));
    mockFs.existsSync = vi.fn(() => true);
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toContain('readable.md');
  });

  it('should use default maxChars when not configured', () => {
    const config: KnowledgeConfig = {
      instructionsPath: '/workspace/CLAUDE.md',
    };
    const mockFs = createMockFs({
      '/workspace/CLAUDE.md': 'Short content',
    });
    Object.assign(fsOps, mockFs);

    const result = loadKnowledge(config);
    expect(result.truncated).toBe(false);
  });
});
