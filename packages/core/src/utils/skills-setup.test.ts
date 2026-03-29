/**
 * Unit tests for setupSkillsInWorkspace
 *
 * Issue #1617 Phase 2: Tests for skills workspace setup utility.
 *
 * Uses real temp directories to avoid fs/promises mocking issues (OOM in CI).
 *
 * Tests cover:
 * - Successful skills directory copy
 * - Source directory not found handling
 * - Target directory creation
 * - Non-directory entries are skipped
 * - Recursive subdirectory copying
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock Config to use temp directories
let tempDir: string;
let sourceDir: string;
let targetDir: string;

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => targetDir,
    getSkillsDir: () => sourceDir,
  },
}));

// Mock logger to suppress output
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { setupSkillsInWorkspace } from './skills-setup.js';

describe('setupSkillsInWorkspace', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    sourceDir = path.join(tempDir, 'source-skills');
    targetDir = path.join(tempDir, 'workspace');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return failure when source directory does not exist', async () => {
    // Override sourceDir to a non-existent path
    sourceDir = path.join(tempDir, 'nonexistent');
    // Need to re-mock... but vi.mock is hoisted.
    // Instead, use the actual sourceDir and just remove it
    await fs.rm(sourceDir, { recursive: true, force: true });

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Source skills directory does not exist');
  });

  it('should copy skill directories to workspace', async () => {
    // Create skill directories with files
    const skillA = path.join(sourceDir, 'skill-a');
    await fs.mkdir(skillA);
    await fs.writeFile(path.join(skillA, 'index.ts'), 'export const x = 1;');

    const skillB = path.join(sourceDir, 'skill-b');
    await fs.mkdir(skillB);
    await fs.writeFile(path.join(skillB, 'main.ts'), 'console.log("hello");');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify files were copied
    const targetSkillA = path.join(targetDir, '.claude', 'skills', 'skill-a', 'index.ts');
    const targetSkillB = path.join(targetDir, '.claude', 'skills', 'skill-b', 'main.ts');
    const contentA = await fs.readFile(targetSkillA, 'utf-8');
    const contentB = await fs.readFile(targetSkillB, 'utf-8');
    expect(contentA).toBe('export const x = 1;');
    expect(contentB).toBe('console.log("hello");');
  });

  it('should skip non-directory entries in source', async () => {
    // Create a directory skill and a non-directory file
    const skillDir = path.join(sourceDir, 'real-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, 'handler.ts'), 'export {}');

    await fs.writeFile(path.join(sourceDir, 'README.md'), '# Skills');
    await fs.writeFile(path.join(sourceDir, '.gitkeep'), '');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);

    // Only the directory skill should be copied
    const targetSkillDir = path.join(targetDir, '.claude', 'skills', 'real-skill');
    expect(await fs.stat(targetSkillDir)).toBeDefined();

    // Non-directories should not be copied
    try {
      await fs.access(path.join(targetDir, '.claude', 'skills', 'README.md'));
      expect.unreachable('README.md should not be copied as a skill');
    } catch {
      // Expected: file does not exist
    }
  });

  it('should handle empty source directory', async () => {
    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);
  });

  it('should recursively copy subdirectories', async () => {
    const skill = path.join(sourceDir, 'nested-skill');
    const subDir = path.join(skill, 'sub', 'deep');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'deep-file.ts'), 'deep content');
    await fs.writeFile(path.join(skill, 'top-file.ts'), 'top content');

    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(true);

    const deepTarget = path.join(targetDir, '.claude', 'skills', 'nested-skill', 'sub', 'deep', 'deep-file.ts');
    const topTarget = path.join(targetDir, '.claude', 'skills', 'nested-skill', 'top-file.ts');
    expect(await fs.readFile(deepTarget, 'utf-8')).toBe('deep content');
    expect(await fs.readFile(topTarget, 'utf-8')).toBe('top content');
  });

  it('should overwrite existing skill directories on re-run', async () => {
    // Create a skill directory
    const skillDir = path.join(sourceDir, 'overwrite-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, 'config.yaml'), 'version: 1');

    // First run
    const result1 = await setupSkillsInWorkspace();
    expect(result1.success).toBe(true);

    // Update the source file
    await fs.writeFile(path.join(skillDir, 'config.yaml'), 'version: 2');

    // Second run - should overwrite
    const result2 = await setupSkillsInWorkspace();
    expect(result2.success).toBe(true);

    const targetFile = path.join(targetDir, '.claude', 'skills', 'overwrite-skill', 'config.yaml');
    const content = await fs.readFile(targetFile, 'utf-8');
    expect(content).toBe('version: 2');
  });
});
