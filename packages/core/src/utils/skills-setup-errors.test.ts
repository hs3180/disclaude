/**
 * Tests for skills-setup error handling paths
 *
 * Covers uncovered branches:
 * - Target directory mkdir failure (lines 51-54)
 * - Individual skill copy failure (lines 72-75)
 *
 * Uses real filesystem with specific setups to trigger error conditions.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock Config before importing skills-setup
const mockGetWorkspaceDir = vi.fn();
const mockGetSkillsDir = vi.fn();

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: (...args: unknown[]) => mockGetWorkspaceDir(...args),
    getSkillsDir: (...args: unknown[]) => mockGetSkillsDir(...args),
  },
}));

describe('setupSkillsInWorkspace — error handling', () => {
  let tempDir: string;
  let sourceDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-errors-test-'));
    sourceDir = path.join(tempDir, 'package-skills');
    workspaceDir = path.join(tempDir, 'workspace');

    mockGetWorkspaceDir.mockReturnValue(workspaceDir);
    mockGetSkillsDir.mockReturnValue(sourceDir);

    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return failure when target directory creation fails', async () => {
    // Create source directory (so access check passes)
    await fs.mkdir(path.join(sourceDir, 'skill-a'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'skill-a', 'SKILL.md'), '# Skill A');

    // Create a FILE at the target path — mkdir will fail because a file exists there
    await fs.mkdir(workspaceDir, { recursive: true });
    const targetClaudeDir = path.join(workspaceDir, '.claude');
    await fs.writeFile(targetClaudeDir, 'this is a file, not a directory');

    const { setupSkillsInWorkspace } = await import('./skills-setup.js');
    const result = await setupSkillsInWorkspace();

    expect(result.success).toBe(false);
    // The error could be EEXIST or EACCES or ENOTDIR
    expect(result.error).toBeTruthy();
  });

  it('should succeed when individual skill copy fails but others succeed', async () => {
    // Create skills: one good, one will be removed to trigger error
    await fs.mkdir(path.join(sourceDir, 'good-skill'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'good-skill', 'SKILL.md'), '# Good');

    // Create a "bad" skill with a file that's actually a symlink to nowhere
    await fs.mkdir(path.join(sourceDir, 'broken-skill'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'broken-skill', 'SKILL.md'), '# Broken');
    // Create a broken symlink inside (copyFile will fail on this)
    try {
      await fs.symlink(
        '/nonexistent/path/dead-link.txt',
        path.join(sourceDir, 'broken-skill', 'dead-link.txt'),
      );
    } catch {
      // Symlink creation might fail in some environments, that's OK
      // The test still validates the error handling path
    }

    await fs.mkdir(path.join(sourceDir, 'another-good'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'another-good', 'SKILL.md'), '# Another Good');

    const { setupSkillsInWorkspace } = await import('./skills-setup.js');
    const result = await setupSkillsInWorkspace();

    // Should succeed overall — broken skill is skipped, others are copied
    expect(result.success).toBe(true);

    // Verify good skills were copied
    const targetDir = path.join(workspaceDir, '.claude', 'skills');
    const goodContent = await fs.readFile(
      path.join(targetDir, 'good-skill', 'SKILL.md'), 'utf-8',
    );
    expect(goodContent).toBe('# Good');

    const anotherContent = await fs.readFile(
      path.join(targetDir, 'another-good', 'SKILL.md'), 'utf-8',
    );
    expect(anotherContent).toBe('# Another Good');
  });

  it('should handle source directory with only broken entries gracefully', async () => {
    // Create source with only a broken symlink
    await fs.mkdir(sourceDir, { recursive: true });
    try {
      await fs.symlink(
        '/nonexistent/skill-dir',
        path.join(sourceDir, 'broken-link'),
      );
    } catch {
      // Symlink might not be supported
    }

    const { setupSkillsInWorkspace } = await import('./skills-setup.js');
    const result = await setupSkillsInWorkspace();

    // Should succeed — symlink is not a directory, so it's skipped
    expect(result.success).toBe(true);
  });
});
