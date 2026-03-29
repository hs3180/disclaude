/**
 * Tests for CLAUDE.md loader utility.
 *
 * Issue #1506: Tests for loading CLAUDE.md from project directories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadClaudeMd } from './claude-md-loader.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock logger to suppress output during tests
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { readFile } from 'fs/promises';

const mockedReadFile = vi.mocked(readFile);

describe('loadClaudeMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return CLAUDE.md content when file exists', async () => {
    const content = '# Project Guidelines\n\nSome rules here.';
    mockedReadFile.mockResolvedValue(content);

    const result = await loadClaudeMd('/project');

    expect(result).toBe(content);
    expect(mockedReadFile).toHaveBeenCalledWith('/project/CLAUDE.md', 'utf-8');
  });

  it('should return undefined when file does not exist (ENOENT)', async () => {
    const error = new Error('File not found') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    mockedReadFile.mockRejectedValue(error);

    const result = await loadClaudeMd('/project');

    expect(result).toBeUndefined();
  });

  it('should return undefined when permission denied (EACCES)', async () => {
    const error = new Error('Permission denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    mockedReadFile.mockRejectedValue(error);

    const result = await loadClaudeMd('/project');

    expect(result).toBeUndefined();
  });

  it('should return undefined on other errors', async () => {
    const error = new Error('Unknown error') as NodeJS.ErrnoException;
    error.code = 'EBUSY';
    mockedReadFile.mockRejectedValue(error);

    const result = await loadClaudeMd('/project');

    expect(result).toBeUndefined();
  });

  it('should truncate content exceeding maxSize', async () => {
    const largeContent = 'x'.repeat(100);
    mockedReadFile.mockResolvedValue(largeContent);

    const result = await loadClaudeMd('/project', 50);

    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(50 + '\n\n... [truncated]'.length);
    expect(result).toContain('... [truncated]');
  });

  it('should not truncate content within maxSize', async () => {
    const content = 'Small content';
    mockedReadFile.mockResolvedValue(content);

    const result = await loadClaudeMd('/project', 1024);

    expect(result).toBe(content);
    expect(result).not.toContain('[truncated]');
  });

  it('should use default maxSize of 32KB', async () => {
    const content = 'a'.repeat(32 * 1024); // exactly 32KB
    mockedReadFile.mockResolvedValue(content);

    const result = await loadClaudeMd('/project');

    // Should not be truncated at exactly 32KB
    expect(result).toBe(content);
  });

  it('should truncate when content exceeds default 32KB', async () => {
    const content = 'a'.repeat(32 * 1024 + 100); // 32KB + 100
    mockedReadFile.mockResolvedValue(content);

    const result = await loadClaudeMd('/project');

    expect(result).toContain('... [truncated]');
    expect(result!.length).toBeLessThan(content.length);
  });

  it('should handle empty file', async () => {
    mockedReadFile.mockResolvedValue('');

    const result = await loadClaudeMd('/project');

    expect(result).toBe('');
  });
});
