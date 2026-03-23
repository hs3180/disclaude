/**
 * Tests for SoulLoader (packages/core/src/soul/loader.ts)
 *
 * Issue #1315: SOUL.md - Agent 人格/行为定义系统
 *
 * Tests the following functionality:
 * - Loading SOUL.md from an existing file
 * - Handling missing SOUL.md file gracefully
 * - Path resolution (absolute and relative paths)
 * - Caching behavior
 * - Cache clearing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SoulLoader } from './loader.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Mock fs modules
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);

describe('SoulLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should resolve relative paths to absolute', () => {
      const loader = new SoulLoader('relative/path/SOUL.md');
      expect(loader.getPath()).toBe(path.resolve('relative/path/SOUL.md'));
    });

    it('should keep absolute paths as-is', () => {
      const absolutePath = '/home/user/.disclaude/SOUL.md';
      const loader = new SoulLoader(absolutePath);
      expect(loader.getPath()).toBe(absolutePath);
    });
  });

  describe('load', () => {
    it('should return loaded=false when SOUL.md does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const loader = new SoulLoader('/nonexistent/SOUL.md');
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.content).toBe('');
      expect(result.path).toBe('/nonexistent/SOUL.md');
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('should load and return SOUL.md content when file exists', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('# My SOUL\n\n## Core Truths\n- Be helpful\n');

      const loader = new SoulLoader('/home/user/SOUL.md');
      const result = await loader.load();

      expect(result.loaded).toBe(true);
      expect(result.content).toBe('# My SOUL\n\n## Core Truths\n- Be helpful');
      expect(result.path).toBe('/home/user/SOUL.md');
      expect(mockReadFile).toHaveBeenCalledWith('/home/user/SOUL.md', 'utf-8');
    });

    it('should trim trailing whitespace but preserve internal formatting', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('# SOUL\n\nContent here\n\n\n\n  \n');

      const loader = new SoulLoader('/test/SOUL.md');
      const result = await loader.load();

      expect(result.content).toBe('# SOUL\n\nContent here');
    });

    it('should return loaded=false on read error', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const loader = new SoulLoader('/restricted/SOUL.md');
      const result = await loader.load();

      expect(result.loaded).toBe(false);
      expect(result.content).toBe('');
    });

    it('should cache the result after first load', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('# Cached SOUL');

      const loader = new SoulLoader('/test/SOUL.md');

      // First load
      const result1 = await loader.load();
      expect(result1.loaded).toBe(true);
      expect(mockReadFile).toHaveBeenCalledTimes(1);

      // Second load should use cache
      const result2 = await loader.load();
      expect(result2.loaded).toBe(true);
      expect(result2.content).toBe('# Cached SOUL');
      // readFile should still only be called once (cached)
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it('should cache not-found results', async () => {
      mockExistsSync.mockReturnValue(false);

      const loader = new SoulLoader('/missing/SOUL.md');

      await loader.load();
      await loader.load();

      // existsSync should only be called once (cached after first check)
      expect(mockExistsSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearCache', () => {
    it('should allow re-reading after cache is cleared', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('# Version 1');

      const loader = new SoulLoader('/test/SOUL.md');

      // First load
      const result1 = await loader.load();
      expect(result1.content).toBe('# Version 1');

      // Clear cache and change mock
      loader.clearCache();
      mockReadFile.mockResolvedValue('# Version 2');

      // Re-read
      const result2 = await loader.load();
      expect(result2.content).toBe('# Version 2');
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPath', () => {
    it('should return the resolved absolute path', () => {
      const loader = new SoulLoader('./config/SOUL.md');
      const expectedPath = path.resolve('./config/SOUL.md');
      expect(loader.getPath()).toBe(expectedPath);
    });
  });
});
