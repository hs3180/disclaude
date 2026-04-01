/**
 * Tests for SoulLoader - Pure utility class for loading SOUL.md files.
 *
 * Issue #1315: SOUL.md personality definition system.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SoulLoader } from './loader.js';

describe('SoulLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('resolvePath', () => {
    it('should expand tilde (~) to home directory', () => {
      const resolved = SoulLoader.resolvePath('~/test/soul.md');
      expect(resolved).toBe(path.join(os.homedir(), 'test/soul.md'));
    });

    it('should resolve relative paths against cwd', () => {
      const resolved = SoulLoader.resolvePath('relative/path.md');
      expect(resolved).toBe(path.resolve('relative/path.md'));
    });

    it('should keep absolute paths unchanged', () => {
      const absolutePath = '/tmp/test/soul.md';
      const resolved = SoulLoader.resolvePath(absolutePath);
      expect(resolved).toBe(absolutePath);
    });

    it('should handle tilde at root of path', () => {
      const resolved = SoulLoader.resolvePath('~/.disclaude/SOUL.md');
      expect(resolved).toBe(path.join(os.homedir(), '.disclaude/SOUL.md'));
    });
  });

  describe('load', () => {
    it('should load a valid SOUL.md file', async () => {
      const filePath = path.join(tempDir, 'SOUL.md');
      const content = '# SOUL.md\n\nYou are a helpful assistant.';
      await fs.writeFile(filePath, content);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.path).toBe(filePath);
      expect(result!.content).toBe(content);
      expect(result!.size).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('should return null when file does not exist', async () => {
      const filePath = path.join(tempDir, 'nonexistent.md');
      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for empty file', async () => {
      const filePath = path.join(tempDir, 'empty.md');
      await fs.writeFile(filePath, '   \n\n  \t  ');

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for file exceeding size limit', async () => {
      const filePath = path.join(tempDir, 'large.md');
      // Create a file larger than 1KB (our test limit)
      const largeContent = 'x'.repeat(2048);
      await fs.writeFile(filePath, largeContent);

      const loader = new SoulLoader(filePath, { maxSizeBytes: 1024 });
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load file at exact size limit', async () => {
      const filePath = path.join(tempDir, 'exact.md');
      const content = 'x'.repeat(100);
      await fs.writeFile(filePath, content);

      const loader = new SoulLoader(filePath, { maxSizeBytes: 100 });
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
    });

    it('should trim whitespace from content', async () => {
      const filePath = path.join(tempDir, 'whitespace.md');
      const content = '  \n# Soul\n\nContent here\n\n  ';
      await fs.writeFile(filePath, content);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe('# Soul\n\nContent here');
    });

    it('should return null for directory path', async () => {
      const loader = new SoulLoader(tempDir);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load file with tilde path', async () => {
      // Create a temp file in home directory
      const homeTestDir = path.join(os.homedir(), '.disclaude-test-soul');
      await fs.mkdir(homeTestDir, { recursive: true });
      const filePath = path.join(homeTestDir, 'SOUL.md');
      const content = 'Test soul content';
      await fs.writeFile(filePath, content);

      try {
        const loader = new SoulLoader('~/.disclaude-test-soul/SOUL.md');
        const result = await loader.load();

        expect(result).not.toBeNull();
        expect(result!.content).toBe(content);
      } finally {
        await fs.rm(homeTestDir, { recursive: true, force: true });
      }
    });

    it('should handle Unicode content correctly', async () => {
      const filePath = path.join(tempDir, 'unicode.md');
      const content = '# 人格定义\n\n你是一个专业的代码审查员。审查时请注意安全性。';
      await fs.writeFile(filePath, content);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
    });

    it('should handle multi-line markdown content', async () => {
      const filePath = path.join(tempDir, 'multiline.md');
      const content = `# SOUL.md

## Core Identity

You are Claude, an AI assistant.

## Behavioral Guidelines

- Be concise
- Be accurate
- Ask clarifying questions when needed

## Response Format

Use markdown formatting for all responses.`;
      await fs.writeFile(filePath, content);

      const loader = new SoulLoader(filePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toContain('## Core Identity');
      expect(result!.content).toContain('- Be concise');
    });
  });

  describe('getPath', () => {
    it('should return the resolved absolute path', () => {
      const filePath = path.join(tempDir, 'SOUL.md');
      const loader = new SoulLoader(filePath);
      expect(loader.getPath()).toBe(filePath);
    });

    it('should return expanded path for tilde paths', () => {
      const loader = new SoulLoader('~/SOUL.md');
      expect(loader.getPath()).toBe(path.join(os.homedir(), 'SOUL.md'));
    });
  });

  describe('constructor', () => {
    it('should accept custom maxSizeBytes', () => {
      const loader = new SoulLoader('/tmp/test.md', { maxSizeBytes: 64 * 1024 });
      expect(loader).toBeDefined();
      expect(loader.getPath()).toBe('/tmp/test.md');
    });

    it('should use default maxSizeBytes when not specified', () => {
      const loader = new SoulLoader('/tmp/test.md');
      expect(loader).toBeDefined();
    });
  });
});
