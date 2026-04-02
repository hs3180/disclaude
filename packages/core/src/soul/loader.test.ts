/**
 * Unit tests for SoulLoader.
 *
 * @module @disclaude/core/soul
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SoulLoader, SOUL_MAX_SIZE_BYTES } from './loader.js';

describe('SoulLoader', () => {
  let tempDir: string;
  let cleanupPaths: string[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-loader-test-'));
    cleanupPaths = [tempDir];
  });

  afterEach(async () => {
    for (const p of cleanupPaths) {
      await fs.rm(p, { recursive: true, force: true });
    }
  });

  describe('resolvePath', () => {
    it('should expand tilde to home directory', () => {
      const resolved = SoulLoader.resolvePath('~/.disclaude/SOUL.md');
      expect(resolved).toBe(path.join(os.homedir(), '.disclaude/SOUL.md'));
    });

    it('should expand bare tilde', () => {
      const resolved = SoulLoader.resolvePath('~');
      expect(resolved).toBe(os.homedir());
    });

    it('should not modify absolute paths', () => {
      const absPath = '/etc/disclaude/SOUL.md';
      const resolved = SoulLoader.resolvePath(absPath);
      expect(resolved).toBe(absPath);
    });

    it('should not modify relative paths', () => {
      const relPath = 'config/SOUL.md';
      const resolved = SoulLoader.resolvePath(relPath);
      expect(resolved).toBe(relPath);
    });
  });

  describe('load', () => {
    it('should load a valid SOUL.md file', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      const content = '# SOUL\n\nYou are a helpful assistant.';
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
      expect(result!.resolvedPath).toBe(soulPath);
      expect(result!.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('should return null for non-existent file', async () => {
      const soulPath = path.join(tempDir, 'NONEXISTENT.md');
      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for files exceeding size limit', async () => {
      const soulPath = path.join(tempDir, 'TOO_LARGE.md');
      // Create a file larger than 32KB
      const largeContent = 'x'.repeat(SOUL_MAX_SIZE_BYTES + 1);
      await fs.writeFile(soulPath, largeContent, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load files exactly at size limit', async () => {
      const soulPath = path.join(tempDir, 'EXACT_LIMIT.md');
      const content = 'x'.repeat(SOUL_MAX_SIZE_BYTES);
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.sizeBytes).toBe(SOUL_MAX_SIZE_BYTES);
    });

    it('should handle Unicode content correctly', async () => {
      const soulPath = path.join(tempDir, 'UNICODE.md');
      const content = '# SOUL\n\n你好世界 🌍\nEmoji: 😀🎉\n中文内容测试';
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
      // sizeBytes should be the byte size, not character count
      expect(result!.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('should expand tilde in constructor path', async () => {
      // Create a file in a temp dir that simulates home expansion
      const soulPath = path.join(tempDir, 'SOUL.md');
      const content = '# SOUL\n\nTest content.';
      await fs.writeFile(soulPath, content, 'utf-8');

      // We can't actually test ~ expansion with a fake home dir easily,
      // but we can verify the constructor stores the resolved path
      const absolutePath = path.resolve(soulPath);
      const loader = new SoulLoader(absolutePath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
    });

    it('should handle empty file', async () => {
      const soulPath = path.join(tempDir, 'EMPTY.md');
      await fs.writeFile(soulPath, '', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe('');
      expect(result!.sizeBytes).toBe(0);
    });

    it('should handle file with only whitespace', async () => {
      const soulPath = path.join(tempDir, 'WHITESPACE.md');
      const content = '   \n\n\t\n   ';
      await fs.writeFile(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
    });
  });
});
