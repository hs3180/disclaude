/**
 * Tests for SoulLoader - SOUL.md personality loading.
 *
 * Issue #1315
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SoulLoader } from './loader.js';

describe('SoulLoader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('load() - success cases', () => {
    it('should load a valid SOUL.md file', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      fs.writeFileSync(soulPath, '# My Soul\n\nYou are a helpful assistant.', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.content).toBe('# My Soul\n\nYou are a helpful assistant.');
      expect(result.resolvedPath).toBe(soulPath);
      expect(result.reason).toBeUndefined();
    });

    it('should trim whitespace from content', async () => {
      const soulPath = path.join(tempDir, 'SOUL.md');
      fs.writeFileSync(soulPath, '  \n# Soul\n\n  \n', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.content).toBe('# Soul');
    });
  });

  describe('load() - file not found', () => {
    it('should return loaded=false when file does not exist', async () => {
      const soulPath = path.join(tempDir, 'NONEXISTENT.md');
      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.content).toBe('');
      expect(result.reason).toBe('File not found');
    });
  });

  describe('load() - empty file', () => {
    it('should return loaded=false for empty file', async () => {
      const soulPath = path.join(tempDir, 'EMPTY.md');
      fs.writeFileSync(soulPath, '', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.content).toBe('');
      expect(result.reason).toBe('File is empty');
    });

    it('should return loaded=false for whitespace-only file', async () => {
      const soulPath = path.join(tempDir, 'WHITESPACE.md');
      fs.writeFileSync(soulPath, '   \n\n  \t  \n', 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.reason).toBe('File is empty');
    });
  });

  describe('load() - file size limit (Critical #3)', () => {
    it('should reject files exceeding the default 32KB limit', async () => {
      const soulPath = path.join(tempDir, 'LARGE.md');
      // 33KB content
      const largeContent = 'x'.repeat(33 * 1024);
      fs.writeFileSync(soulPath, largeContent, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.reason).toContain('exceeds limit');
    });

    it('should accept files within the size limit', async () => {
      const soulPath = path.join(tempDir, 'SMALL.md');
      // 1KB content
      const content = 'x'.repeat(1024);
      fs.writeFileSync(soulPath, content, 'utf-8');

      const loader = new SoulLoader(soulPath);
      const result = await loader.load();

      expect(result.loaded).toBe(true);
    });

    it('should respect custom size limit', async () => {
      const soulPath = path.join(tempDir, 'CUSTOM.md');
      const content = 'x'.repeat(100);
      fs.writeFileSync(soulPath, content, 'utf-8');

      // Set a very small limit (50 bytes)
      const loader = new SoulLoader(soulPath, 50);
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.reason).toContain('exceeds limit');
    });
  });

  describe('load() - tilde expansion (Critical #2)', () => {
    it('should expand ~ to home directory', async () => {
      // Create a SOUL.md file in home directory
      const homeSoulPath = path.join(os.homedir(), '.disclaude', 'SOUL.md');
      const homeDir = path.dirname(homeSoulPath);

      // Ensure directory exists
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(homeSoulPath, 'Home soul content', 'utf-8');

      const loader = new SoulLoader('~/.disclaude/SOUL.md');
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.content).toBe('Home soul content');
      expect(result.resolvedPath).toBe(homeSoulPath);

      // Cleanup
      fs.unlinkSync(homeSoulPath);
    });
  });

  describe('constructor', () => {
    it('should accept a path string', () => {
      const loader = new SoulLoader('/some/path/SOUL.md');
      expect(loader).toBeDefined();
    });

    it('should accept custom max size', () => {
      const loader = new SoulLoader('/some/path/SOUL.md', 1024);
      expect(loader).toBeDefined();
    });
  });
});
