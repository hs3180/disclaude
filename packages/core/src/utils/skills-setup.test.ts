/**
 * Unit tests for skills-setup.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  copyFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../config/index.js', () => ({
  Config: { getWorkspaceDir: () => '/test/workspace', getSkillsDir: () => '/test/package/skills' },
}));

import * as fs from 'fs/promises';
import { setupSkillsInWorkspace } from './skills-setup.js';

function mockDir(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

describe('setupSkillsInWorkspace', () => {
  beforeEach(() => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([]);
    vi.mocked(fs.copyFile).mockResolvedValue(undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('should return failure when source directory does not exist', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Source skills directory does not exist');
  });

  it('should succeed when source directory exists', async () => {
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(true);
  });

  it('should create target directory with recursive option', async () => {
    await setupSkillsInWorkspace();
    expect(fs.mkdir).toHaveBeenCalledWith('/test/workspace/.claude/skills', { recursive: true });
  });

  it('should return failure when target mkdir fails', async () => {
    vi.mocked(fs.mkdir).mockRejectedValue(new Error('Permission denied'));
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied');
  });

  it('should copy skill directories and skip files', async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      mockDir('skill-a', true),
      mockDir('readme.md', false),
    ]);
    vi.mocked(fs.readdir).mockResolvedValueOnce([]);
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(true);
    expect(fs.mkdir).toHaveBeenCalledWith('/test/workspace/.claude/skills/skill-a', { recursive: true });
  });

  it('should handle empty source directory', async () => {
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(true);
  });

  it('should continue when one skill copy fails', async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([mockDir('fail', true), mockDir('ok', true)]);
    vi.mocked(fs.readdir).mockRejectedValueOnce(new Error('fail'));
    vi.mocked(fs.readdir).mockResolvedValueOnce([]);
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(true);
  });

  it('should copy files in skill directories', async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([mockDir('skill-a', true)]);
    vi.mocked(fs.readdir).mockResolvedValueOnce([mockDir('index.js', false)]);
    await setupSkillsInWorkspace();
    expect(fs.copyFile).toHaveBeenCalledWith(
      '/test/package/skills/skill-a/index.js',
      '/test/workspace/.claude/skills/skill-a/index.js'
    );
  });

  it('should handle nested subdirectories', async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([mockDir('skill-a', true)]);
    vi.mocked(fs.readdir).mockResolvedValueOnce([mockDir('sub', true)]);
    vi.mocked(fs.readdir).mockResolvedValueOnce([mockDir('f.js', false)]);
    await setupSkillsInWorkspace();
    expect(fs.mkdir).toHaveBeenCalledWith('/test/workspace/.claude/skills/skill-a/sub', { recursive: true });
    expect(fs.copyFile).toHaveBeenCalledWith(
      '/test/package/skills/skill-a/sub/f.js',
      '/test/workspace/.claude/skills/skill-a/sub/f.js'
    );
  });

  it('should handle mkdir rejection with the error message', async () => {
    vi.mocked(fs.mkdir).mockRejectedValue(new Error('disk full'));
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(false);
    expect(result.error).toBe('disk full');
  });

  it('should handle mkdir rejection with non-Error (error message is undefined)', async () => {
    vi.mocked(fs.mkdir).mockRejectedValue('disk full');
    const result = await setupSkillsInWorkspace();
    expect(result.success).toBe(false);
    // Non-Error rejections produce undefined error.message (error as Error).message
    expect(result.error).toBeUndefined();
  });
});
