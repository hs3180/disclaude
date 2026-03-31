/**
 * Tests for Research Mode utilities.
 *
 * Issue #1709: Research Mode Phase 1
 *
 * Tests cover:
 * - Research directory path resolution
 * - Topic name sanitization
 * - Research directory initialization
 * - SOUL file creation
 * - Research directory cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  getResearchDir,
  getSoulFilePath,
  initResearchDir,
  cleanupResearchDir,
} from './research-mode.js';

// Use a temp directory as workspace for tests
const TEST_WORKSPACE = path.join(os.tmpdir(), `research-mode-test-${Date.now()}`);

// Mock Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => TEST_WORKSPACE,
    getResearchConfig: () => ({}),
  },
}));

describe('getResearchDir', () => {
  it('should sanitize topic name to lowercase kebab-case', () => {
    const result = getResearchDir('Machine Learning');
    expect(result).toBe(`${TEST_WORKSPACE}/research/machine-learning`);
  });

  it('should handle special characters in topic name', () => {
    const result = getResearchDir('React & Redux: A Deep Dive!');
    expect(result).toBe(`${TEST_WORKSPACE}/research/react-redux-a-deep-dive`);
  });

  it('should handle Chinese characters by removing them', () => {
    const result = getResearchDir('深度学习 Deep Learning');
    expect(result).toBe(`${TEST_WORKSPACE}/research/deep-learning`);
  });

  it('should truncate long topic names to 64 characters', () => {
    const longTopic = 'a'.repeat(100);
    const result = getResearchDir(longTopic);
    const dirName = path.basename(result);
    expect(dirName.length).toBeLessThanOrEqual(64);
  });

  it('should strip leading and trailing dashes', () => {
    const result = getResearchDir('---test---');
    expect(path.basename(result)).toBe('test');
  });

  it('should handle empty topic name by returning base research dir', () => {
    const result = getResearchDir('');
    // Empty topic results in the base research dir itself
    expect(result).toBe(`${TEST_WORKSPACE}/research`);
  });
});

describe('getSoulFilePath', () => {
  it('should return CLAUDE.md path within research directory', () => {
    const result = getSoulFilePath(`${TEST_WORKSPACE}/research/my-topic`);
    expect(result).toBe(`${TEST_WORKSPACE}/research/my-topic/CLAUDE.md`);
  });
});

describe('initResearchDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create research directory and default SOUL file', async () => {
    const result = await initResearchDir('test-topic', {
      dirPath: path.join(tmpDir, 'research', 'test-topic'),
    });

    expect(result.created).toBe(true);
    expect(result.soulCreated).toBe(true);
    expect(result.dirPath).toContain('test-topic');
    expect(result.soulFilePath).toContain('CLAUDE.md');

    // Verify files exist
    const stat = await fs.stat(result.dirPath);
    expect(stat.isDirectory()).toBe(true);

    const soulContent = await fs.readFile(result.soulFilePath, 'utf-8');
    expect(soulContent).toContain('Research Mode');
  });

  it('should not overwrite existing directory and SOUL file', async () => {
    const dirPath = path.join(tmpDir, 'research', 'existing-topic');
    const soulPath = path.join(dirPath, 'CLAUDE.md');

    // Create directory and custom SOUL file
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(soulPath, 'Custom SOUL content', 'utf-8');

    const result = await initResearchDir('existing-topic', { dirPath });

    expect(result.created).toBe(false);
    expect(result.soulCreated).toBe(false);

    // Verify original SOUL is preserved
    const soulContent = await fs.readFile(soulPath, 'utf-8');
    expect(soulContent).toBe('Custom SOUL content');
  });

  it('should use custom SOUL file when specified', async () => {
    // Create custom SOUL file
    const customSoulPath = path.join(tmpDir, 'custom-soul.md');
    await fs.writeFile(customSoulPath, 'My Custom Research SOUL', 'utf-8');

    const dirPath = path.join(tmpDir, 'research', 'custom-topic');
    const result = await initResearchDir('custom-topic', {
      dirPath,
      soulFilePath: customSoulPath,
    });

    expect(result.soulCreated).toBe(true);

    const soulContent = await fs.readFile(result.soulFilePath, 'utf-8');
    expect(soulContent).toBe('My Custom Research SOUL');
  });

  it('should throw when custom SOUL file does not exist', async () => {
    const dirPath = path.join(tmpDir, 'research', 'missing-soul');
    await expect(
      initResearchDir('missing-soul', {
        dirPath,
        soulFilePath: path.join(tmpDir, 'nonexistent.md'),
      })
    ).rejects.toThrow('Failed to read custom SOUL file');
  });
});

describe('cleanupResearchDir', () => {
  afterEach(async () => {
    // Clean up any test directories
    await fs.rm(TEST_WORKSPACE, { recursive: true, force: true });
  });

  it('should remove existing research directory', async () => {
    // Create the directory at the expected path (using mocked workspace)
    const expectedDir = `${TEST_WORKSPACE}/research/cleanup-topic`;
    await fs.mkdir(expectedDir, { recursive: true });

    const removed = await cleanupResearchDir('cleanup-topic');
    expect(removed).toBe(true);

    // Verify directory no longer exists
    try {
      await fs.access(expectedDir);
      expect.fail('Directory should have been removed');
    } catch {
      // Expected - directory should not exist
    }
  });

  it('should return false for non-existing directory', async () => {
    const removed = await cleanupResearchDir('nonexistent-cleanup');
    expect(removed).toBe(false);
  });
});
