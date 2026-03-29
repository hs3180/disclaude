import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSoulContent } from './soul-loader.js';

describe('soul-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadSoulContent', () => {
    it('returns null when path is empty string', () => {
      expect(loadSoulContent('')).toBeNull();
    });

    it('returns null when path is null', () => {
      expect(loadSoulContent(null as unknown as string)).toBeNull();
    });

    it('returns null when file does not exist', () => {
      const result = loadSoulContent(path.join(tmpDir, 'nonexistent.md'));
      expect(result).toBeNull();
    });

    it('loads file content successfully', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      const content = 'You are a helpful assistant.\nAlways be polite.';
      fs.writeFileSync(filePath, content);

      const result = loadSoulContent(filePath);
      expect(result).toBe(content);
    });

    it('trims whitespace from loaded content', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      const content = '  You are a helpful assistant.  \n\n  ';
      fs.writeFileSync(filePath, content);

      const result = loadSoulContent(filePath);
      expect(result).toBe('You are a helpful assistant.');
    });

    it('returns null when file is empty', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      fs.writeFileSync(filePath, '   \n\n   ');

      const result = loadSoulContent(filePath);
      expect(result).toBeNull();
    });

    it('returns null when file exceeds default 32KB size limit', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      // 33KB of content
      const largeContent = 'X'.repeat(33 * 1024);
      fs.writeFileSync(filePath, largeContent);

      const result = loadSoulContent(filePath);
      expect(result).toBeNull();
    });

    it('respects custom maxSize parameter', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      // 100 bytes
      const content = 'A'.repeat(100);
      fs.writeFileSync(filePath, content);

      // With 50 byte limit, should return null
      const result = loadSoulContent(filePath, 50);
      expect(result).toBeNull();
    });

    it('loads file within custom maxSize', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      const content = 'A'.repeat(100);
      fs.writeFileSync(filePath, content);

      // With 200 byte limit, should succeed
      const result = loadSoulContent(filePath, 200);
      expect(result).toBe(content);
    });

    it('loads file at exact maxSize boundary', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      const content = 'A'.repeat(100);
      fs.writeFileSync(filePath, content);

      // Exactly at the boundary — fileStat.size (bytes) == maxSize, should pass
      const result = loadSoulContent(filePath, 100);
      expect(result).toBe(content);
    });

    it('expands tilde (~) to home directory', () => {
      const homeDir = os.homedir();
      const filePath = path.join(homeDir, '.disclaude_test_soul_loader_SOUL.md');
      const content = 'You are a test soul.';

      try {
        fs.writeFileSync(filePath, content);
        const result = loadSoulContent('~/.disclaude_test_soul_loader_SOUL.md');
        expect(result).toBe(content);
      } finally {
        fs.unlinkSync(filePath);
      }
    });

    it('uses fs.stat().size (bytes) not content.length (chars) for size check', () => {
      // This tests the Unicode bug fix from PR #1632
      // Chinese characters are 3 bytes in UTF-8 but 1 char in JS string
      const filePath = path.join(tmpDir, 'SOUL.md');
      // 10 Chinese characters = 30 bytes in UTF-8
      const chineseContent = '你好世界测试人格注入';
      fs.writeFileSync(filePath, chineseContent);

      // Set maxSize to 20 bytes (less than 30 bytes, but more than 10 chars)
      // Should use byte size and return null
      const result = loadSoulContent(filePath, 20);
      expect(result).toBeNull();
    });

    it('handles file read errors gracefully', () => {
      const filePath = path.join(tmpDir, 'SOUL.md');
      fs.writeFileSync(filePath, 'content');

      // Make directory to cause permission-like issues
      // Actually, let's just test with a directory path instead
      const dirPath = path.join(tmpDir, 'subdir');
      fs.mkdirSync(dirPath);

      const result = loadSoulContent(dirPath);
      // On some systems this returns null (ENOENT when trying to stat),
      // on others it might throw. The function should handle it gracefully.
      expect(result).toBeNull();
    });
  });
});
