/**
 * SoulLoader unit tests.
 *
 * @see Issue #1315 (SOUL.md infrastructure)
 * @see Issue #1228 (Discussion SOUL profile)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { SoulLoader } from './loader.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'soul-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SoulLoader', () => {
  describe('resolvePath', () => {
    it('should resolve tilde to home directory', () => {
      const result = SoulLoader.resolvePath('~/test/soul.md');
      expect(result.startsWith('~')).toBe(false);
      expect(result).toContain(sep);
    });

    it('should resolve non-tilde paths as-is', () => {
      const result = SoulLoader.resolvePath('/absolute/path/soul.md');
      expect(result).toBe('/absolute/path/soul.md');
    });

    it('should resolve relative paths', () => {
      const result = SoulLoader.resolvePath('./relative/soul.md');
      expect(result.startsWith('/')).toBe(true);
    });
  });

  describe('load', () => {
    it('should load a valid SOUL.md file', async () => {
      const soulPath = join(tempDir, 'SOUL.md');
      const content = '# Discussion SOUL\n\nStay focused on the topic.';
      writeFileSync(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
      expect(result!.path).toBe(soulPath);
      expect(result!.size).toBeGreaterThan(0);
    });

    it('should return null for non-existent file', async () => {
      const loader = new SoulLoader(join(tempDir, 'nonexistent.md'));
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null for file exceeding size limit', async () => {
      const soulPath = join(tempDir, 'big-soul.md');
      // Create a file larger than 32KB
      const bigContent = 'x'.repeat(33 * 1024);
      writeFileSync(soulPath, bigContent, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load a file exactly at size limit', async () => {
      const soulPath = join(tempDir, 'exact-soul.md');
      // Create a file exactly at 32KB
      const exactContent = 'x'.repeat(32 * 1024);
      writeFileSync(soulPath, exactContent, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content.length).toBe(exactContent.length);
    });

    it('should load files with unicode content', async () => {
      const soulPath = join(tempDir, 'unicode-soul.md');
      const content = '# 讨论人格\n\n保持聚焦，不要跑题。';
      writeFileSync(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe(content);
    });

    it('should handle empty files', async () => {
      const soulPath = join(tempDir, 'empty-soul.md');
      writeFileSync(soulPath, '', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result!.content).toBe('');
      expect(result!.size).toBe(0);
    });

    it('should handle unreadable directories gracefully', async () => {
      const loader = new SoulLoader('/proc/nonexistent-soul-file.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });
  });

  describe('resolvedFilePath', () => {
    it('should expose the resolved path', () => {
      const loader = new SoulLoader(join(tempDir, 'soul.md'));
      expect(loader.resolvedFilePath).toBe(join(tempDir, 'soul.md'));
    });
  });
});
