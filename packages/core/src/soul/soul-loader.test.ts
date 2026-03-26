/**
 * SoulLoader unit tests.
 *
 * Issue #1315: SOUL.md - Agent personality/behavior definition system.
 *
 * Tests cover:
 * - Basic file loading
 * - Tilde path expansion
 * - File size limits (byte-based for Unicode safety)
 * - Unicode content handling
 * - Error cases (not found, too large, read error)
 * - hasSoulConfig utility
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSoul, hasSoulConfig } from './soul-loader.js';
import { SoulLoadError } from './types.js';

describe('SoulLoader', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soul-test-'));
    testFilePath = path.join(tempDir, 'SOUL.md');
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadSoul', () => {
    it('should load a valid SOUL.md file', async () => {
      const content = 'You are a helpful coding assistant.';
      await fs.promises.writeFile(testFilePath, content);

      const result = await loadSoul({ path: testFilePath });

      expect(result.content).toBe(content);
      expect(result.resolvedPath).toBe(testFilePath);
      expect(result.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('should trim whitespace from content', async () => {
      const content = '  You are a helpful assistant.  \n  ';
      await fs.promises.writeFile(testFilePath, content);

      const result = await loadSoul({ path: testFilePath });

      expect(result.content).toBe('You are a helpful assistant.');
    });

    it('should expand tilde paths', async () => {
      // Create a file in home directory's temp location
      const homeDir = os.homedir();
      const homePath = path.join(homeDir, '.disclaude-test-soul');
      const homeSoulPath = path.join(homePath, 'SOUL.md');

      try {
        await fs.promises.mkdir(homePath, { recursive: true });
        const content = 'Home directory soul';
        await fs.promises.writeFile(homeSoulPath, content);

        const result = await loadSoul({
          path: '~/.disclaude-test-soul/SOUL.md',
        });

        expect(result.content).toBe(content);
        expect(result.resolvedPath).toBe(homeSoulPath);
      } finally {
        await fs.promises.rm(homePath, { recursive: true, force: true });
      }
    });

    it('should resolve relative paths against workspace directory', async () => {
      const content = 'Relative path soul';
      await fs.promises.writeFile(testFilePath, content);

      const relativePath = 'SOUL.md';
      const result = await loadSoul(
        { path: relativePath },
        tempDir
      );

      expect(result.content).toBe(content);
      expect(result.resolvedPath).toBe(testFilePath);
    });

    it('should handle Unicode content correctly (byte-based size)', async () => {
      // Chinese characters: each is 3 bytes in UTF-8
      const content = '你是一个有帮助的助手 🤖';
      await fs.promises.writeFile(testFilePath, content);

      const result = await loadSoul({ path: testFilePath });

      expect(result.content).toBe(content);
      // Byte size should match stat.size (not content.length which counts characters)
      const byteLength = Buffer.byteLength(content, 'utf-8');
      expect(result.sizeBytes).toBe(byteLength);
      // Characters and bytes differ for non-ASCII
      expect(content.length).toBeLessThan(byteLength);
    });

    it('should reject files exceeding max size', async () => {
      // Create a file larger than the limit
      const maxSize = 100;
      const largeContent = 'x'.repeat(maxSize + 1);
      await fs.promises.writeFile(testFilePath, largeContent);

      await expect(
        loadSoul({ path: testFilePath, maxSize })
      ).rejects.toThrow(SoulLoadError);

      await expect(
        loadSoul({ path: testFilePath, maxSize })
      ).rejects.toMatchObject({
        code: 'TOO_LARGE',
      });
    });

    it('should accept files within max size', async () => {
      const maxSize = 100;
      const content = 'x'.repeat(maxSize);
      await fs.promises.writeFile(testFilePath, content);

      const result = await loadSoul({ path: testFilePath, maxSize });
      expect(result.content).toBe(content);
    });

    it('should throw NOT_FOUND for non-existent file', async () => {
      const nonExistent = path.join(tempDir, 'non-existent.md');

      await expect(
        loadSoul({ path: nonExistent })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should throw INVALID_PATH when no path is configured', async () => {
      await expect(
        loadSoul({})
      ).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    });

    it('should use default max size of 32KB', async () => {
      // Create a file exactly at 32KB
      const defaultMaxSize = 32 * 1024;
      const content = 'x'.repeat(defaultMaxSize);
      await fs.promises.writeFile(testFilePath, content);

      const result = await loadSoul({ path: testFilePath });
      expect(result.sizeBytes).toBe(defaultMaxSize);
    });

    it('should reject file exceeding default 32KB', async () => {
      const defaultMaxSize = 32 * 1024;
      const content = 'x'.repeat(defaultMaxSize + 1);
      await fs.promises.writeFile(testFilePath, content);

      await expect(
        loadSoul({ path: testFilePath })
      ).rejects.toMatchObject({
        code: 'TOO_LARGE',
      });
    });

    it('should handle empty file', async () => {
      await fs.promises.writeFile(testFilePath, '');

      const result = await loadSoul({ path: testFilePath });
      expect(result.content).toBe('');
      expect(result.sizeBytes).toBe(0);
    });
  });

  describe('hasSoulConfig', () => {
    it('should return true when path is configured', () => {
      expect(hasSoulConfig({ path: '~/.disclaude/SOUL.md' })).toBe(true);
    });

    it('should return false when path is undefined', () => {
      expect(hasSoulConfig({})).toBe(false);
    });

    it('should return false when path is empty string', () => {
      expect(hasSoulConfig({ path: '' })).toBe(false);
    });

    it('should return true for non-empty path', () => {
      expect(hasSoulConfig({ path: '/absolute/path.md' })).toBe(true);
    });
  });

  describe('SoulLoadError', () => {
    it('should have correct name and code', () => {
      const error = new SoulLoadError('test message', 'NOT_FOUND');
      expect(error.name).toBe('SoulLoadError');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('test message');
    });

    it('should support cause chain', () => {
      const cause = new Error('original error');
      const error = new SoulLoadError('wrapper', 'READ_ERROR', cause);
      expect(error.cause).toBe(cause);
    });

    it('should be an instance of Error', () => {
      const error = new SoulLoadError('test', 'TOO_LARGE');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SoulLoadError);
    });
  });
});
