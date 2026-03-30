import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSoulFile, resolveTilde } from './loader.js';

describe('soul/loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveTilde', () => {
    it('resolves ~ to home directory', () => {
      expect(resolveTilde('~')).toBe(os.homedir());
    });

    it('resolves ~/path to home directory + path', () => {
      expect(resolveTilde('~/Documents/SOUL.md')).toBe(
        path.join(os.homedir(), 'Documents/SOUL.md'),
      );
    });

    it('returns unchanged path when no tilde prefix', () => {
      const absPath = '/etc/config/SOUL.md';
      expect(resolveTilde(absPath)).toBe(absPath);
    });

    it('returns unchanged relative path', () => {
      expect(resolveTilde('config/SOUL.md')).toBe('config/SOUL.md');
    });
  });

  describe('loadSoulFile', () => {
    it('returns null when file does not exist', () => {
      const result = loadSoulFile(path.join(tmpDir, 'nonexistent.md'));
      expect(result).toBeNull();
    });

    it('loads valid SOUL.md file and returns trimmed content', () => {
      const soulPath = path.join(tmpDir, 'SOUL.md');
      fs.writeFileSync(soulPath, '\n# My Soul\n\nYou are helpful.\n\n');
      const result = loadSoulFile(soulPath);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('# My Soul\n\nYou are helpful.');
      expect(result!.resolvedPath).toBe(soulPath);
      expect(result!.sizeBytes).toBeGreaterThan(0);
    });

    it('resolves tilde paths', () => {
      // Only test resolveTilde logic directly (no actual file I/O)
      const resolved = resolveTilde('~/nonexistent.md');
      expect(resolved).toBe(path.join(os.homedir(), 'nonexistent.md'));
    });

    it('returns null for empty file', () => {
      const soulPath = path.join(tmpDir, 'SOUL.md');
      fs.writeFileSync(soulPath, '   \n\n  ');
      const result = loadSoulFile(soulPath);
      expect(result).toBeNull();
    });

    it('returns null for file exceeding 32KB size limit', () => {
      const soulPath = path.join(tmpDir, 'SOUL.md');
      // Create a file larger than 32KB
      const largeContent = 'A'.repeat(33 * 1024);
      fs.writeFileSync(soulPath, largeContent);
      const result = loadSoulFile(soulPath);
      expect(result).toBeNull();
    });

    it('loads file exactly at 32KB size limit', () => {
      const soulPath = path.join(tmpDir, 'SOUL.md');
      // Create a file exactly 32KB
      const content = 'A'.repeat(32 * 1024);
      fs.writeFileSync(soulPath, content);
      const result = loadSoulFile(soulPath);
      expect(result).not.toBeNull();
      expect(result!.content.length).toBe(32 * 1024);
    });

    it('returns null when path points to a directory', () => {
      const dirPath = path.join(tmpDir, 'SOUL.md');
      fs.mkdirSync(dirPath);
      const result = loadSoulFile(dirPath);
      expect(result).toBeNull();
    });

    it('correctly handles Unicode content (CJK + emoji)', () => {
      const soulPath = path.join(tmpDir, 'SOUL.md');
      const unicodeContent = '# 人格定义\n\n你是友好的 AI 助手 🤖\n\n日本語テスト';
      fs.writeFileSync(soulPath, unicodeContent);
      const result = loadSoulFile(soulPath);
      expect(result).not.toBeNull();
      expect(result!.content).toBe(unicodeContent);
      // Verify sizeBytes is byte size, not character count
      const expectedByteSize = Buffer.byteLength(unicodeContent, 'utf-8');
      expect(result!.sizeBytes).toBe(expectedByteSize);
      // Character count != byte count for Unicode
      if (unicodeContent.length !== expectedByteSize) {
        expect(result!.sizeBytes).not.toBe(unicodeContent.length);
      }
    });

    it('trims whitespace from content', () => {
      const soulPath = path.join(tmpDir, 'SOUL.md');
      fs.writeFileSync(soulPath, '  \n  Hello  \n  ');
      const result = loadSoulFile(soulPath);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('Hello');
    });
  });
});
