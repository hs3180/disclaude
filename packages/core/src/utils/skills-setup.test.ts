/**
 * Unit tests for Skills Setup - copying skills to workspace.
 *
 * Issue #1617 Phase 2 (P2): Tests for skill directory copying,
 * error handling, and edge cases.
 *
 * Uses real temp directories for reliable filesystem testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// ============================================================================
// Mock Config - use vi.fn() so we can change return values per test
// ============================================================================

const mockGetWorkspaceDir = vi.fn();
const mockGetSkillsDir = vi.fn();

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => mockGetWorkspaceDir(),
    getSkillsDir: () => mockGetSkillsDir(),
  },
}));

vi.mock('./logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ============================================================================
// Tests
// ============================================================================

import { setupSkillsInWorkspace } from './skills-setup.js';

describe('setupSkillsInWorkspace', () => {
  let sourceDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create real temp directories
    sourceDir = mkdtempSync(path.join(tmpdir(), 'skills-source-'));
    workspaceDir = mkdtempSync(path.join(tmpdir(), 'skills-workspace-'));

    // Configure mocks to use test directories
    mockGetWorkspaceDir.mockReturnValue(workspaceDir);
    mockGetSkillsDir.mockReturnValue(sourceDir);
  });

  afterEach(() => {
    // Cleanup temp directories
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('should copy all skill directories from source to workspace', async () => {
    // Create source skills
    await fs.mkdir(path.join(sourceDir, 'feedback'));
    await fs.writeFile(path.join(sourceDir, 'feedback', 'SKILL.md'), 'feedback skill');
    await fs.mkdir(path.join(sourceDir, 'github-app'));
    await fs.writeFile(path.join(sourceDir, 'github-app', 'SKILL.md'), 'github skill');
    // Create a non-directory file (should be skipped)
    await fs.writeFile(path.join(sourceDir, 'README.md'), 'readme');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify directories were copied
    expect(await fs.stat(path.join(workspaceDir, '.claude', 'skills', 'feedback'))).toBeDefined();
    expect(await fs.stat(path.join(workspaceDir, '.claude', 'skills', 'github-app'))).toBeDefined();
    // Verify file content
    const content = await fs.readFile(path.join(workspaceDir, '.claude', 'skills', 'feedback', 'SKILL.md'), 'utf-8');
    expect(content).toBe('feedback skill');
  });

  it('should return error when source directory does not exist', async () => {
    mockGetSkillsDir.mockReturnValue('/nonexistent/path');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Source skills directory does not exist');
  });

  it('should handle empty source directory', async () => {
    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Target directory should still be created
    expect(await fs.stat(path.join(workspaceDir, '.claude', 'skills'))).toBeDefined();
  });

  it('should skip non-directory entries in source', async () => {
    await fs.writeFile(path.join(sourceDir, 'README.md'), 'readme');
    await fs.writeFile(path.join(sourceDir, '.gitkeep'), '');
    await fs.mkdir(path.join(sourceDir, 'actual-skill'));
    await fs.writeFile(path.join(sourceDir, 'actual-skill', 'SKILL.md'), 'skill');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    expect(await fs.stat(path.join(workspaceDir, '.claude', 'skills', 'actual-skill', 'SKILL.md'))).toBeDefined();
  });

  it('should recursively copy nested directories', async () => {
    await fs.mkdir(path.join(sourceDir, 'complex-skill', 'subdir', 'deep'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'complex-skill', 'root.txt'), 'root');
    await fs.writeFile(path.join(sourceDir, 'complex-skill', 'subdir', 'nested.txt'), 'nested');
    await fs.writeFile(path.join(sourceDir, 'complex-skill', 'subdir', 'deep', 'deep.txt'), 'deep');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    const deepContent = await fs.readFile(
      path.join(workspaceDir, '.claude', 'skills', 'complex-skill', 'subdir', 'deep', 'deep.txt'),
      'utf-8'
    );
    expect(deepContent).toBe('deep');
  });

  it('should create target directory with .claude/skills path', async () => {
    await fs.mkdir(path.join(sourceDir, 'test-skill'));

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    expect(await fs.stat(path.join(workspaceDir, '.claude'))).toBeDefined();
    expect(await fs.stat(path.join(workspaceDir, '.claude', 'skills'))).toBeDefined();
    expect(await fs.stat(path.join(workspaceDir, '.claude', 'skills', 'test-skill'))).toBeDefined();
  });
});
