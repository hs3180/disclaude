/**
 * Unit tests for SoulLoader.
 *
 * Issue #1315: SOUL.md - Agent personality/behavior definition system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { SoulLoader, MAX_SOUL_SIZE } from './loader.js';

describe('SoulLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should expand tilde to home directory', () => {
      const loader = new SoulLoader('~/.disclaude/SOUL.md');
      expect(loader.getPath()).toBe(path.join(os.homedir(), '.disclaude/SOUL.md'));
    });

    it('should resolve relative paths to absolute', () => {
      const relativePath = './test/soul.md';
      const loader = new SoulLoader(relativePath);
      expect(loader.getPath()).toBe(path.resolve(relativePath));
    });

    it('should keep absolute paths as-is (resolved)', () => {
      const absolutePath = '/etc/disclaude/SOUL.md';
      const loader = new SoulLoader(absolutePath);
      expect(loader.getPath()).toBe(absolutePath);
    });

    it('should expand tilde with nested paths', () => {
      const loader = new SoulLoader('~/.disclaude/souls/code-reviewer.md');
      expect(loader.getPath()).toBe(path.join(os.homedir(), '.disclaude/souls/code-reviewer.md'));
    });
  });

  describe('resolvePath (static)', () => {
    it('should expand tilde correctly', () => {
      expect(SoulLoader.resolvePath('~/test.md')).toBe(path.join(os.homedir(), 'test.md'));
    });

    it('should handle non-tilde paths', () => {
      const result = SoulLoader.resolvePath('/absolute/path.md');
      expect(result).toBe('/absolute/path.md');
    });
  });

  describe('load', () => {
    it('should load a valid SOUL.md file', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      const content = '# Discussion SOUL\n\n## Core Truths\nBe helpful.';
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
      expect(result!.path).toBe(soulPath);
      expect(result!.size).toBe(content.length);
    });

    it('should return null for non-existent file', async () => {
      const loader = new SoulLoader(path.join(tempDir, 'non-existent.md'));
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for tilde-expanded non-existent path', async () => {
      // Use a path that definitely doesn't exist under home dir
      const loader = new SoulLoader('~/.disclaude-nonexistent-dir-xyz/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should throw for files exceeding MAX_SOUL_SIZE', async () => {
      const soulPath = path.join(tempDir, 'oversized.md');
      // Create a file larger than MAX_SOUL_SIZE
      const oversizedContent = 'x'.repeat(MAX_SOUL_SIZE + 1);
      await fs.writeFile(soulPath, oversizedContent, 'utf-8');

      const loader = new SoulLoader(soulPath);
      await expect(loader.load()).rejects.toThrow(/exceeds maximum size/);
    });

    it('should load files exactly at MAX_SOUL_SIZE', async () => {
      const soulPath = path.join(tempDir, 'max-size.md');
      const content = 'x'.repeat(MAX_SOUL_SIZE);
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.size).toBe(MAX_SOUL_SIZE);
    });

    it('should handle empty files', async () => {
      const soulPath = path.join(tempDir, 'empty.md');
      await fs.writeFile(soulPath, '', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe('');
      expect(result!.size).toBe(0);
    });

    it('should handle Unicode content', async () => {
      const soulPath = path.join(tempDir, 'unicode.md');
      const content = '# 灵魂定义\n\n## 核心真理\n作为 AI 助手，你应该：\n- 保持友好\n- 提供准确信息\n\n日本語テスト 🎉';
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
    });

    it('should handle markdown with code blocks', async () => {
      const soulPath = path.join(tempDir, 'with-code.md');
      const content = '# SOUL\n\n```typescript\nconst rule = "be helpful";\n```\n\nNormal text here.';
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toContain('```typescript');
    });
  });

  describe('getPath', () => {
    it('should return the resolved path', () => {
      const loader = new SoulLoader('~/test.md');
      expect(loader.getPath()).toBe(path.join(os.homedir(), 'test.md'));
    });
  });

  describe('MAX_SOUL_SIZE', () => {
    it('should be 32KB', () => {
      expect(MAX_SOUL_SIZE).toBe(32 * 1024);
    });
  });
});
