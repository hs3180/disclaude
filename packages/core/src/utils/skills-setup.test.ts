/**
 * Tests for Skills Setup (packages/core/src/utils/skills-setup.ts)
 *
 * Issue #1617 Phase 2: Tests for the skill directory copying utility.
 * Covers successful copy, missing source, directory creation failure,
 * individual skill copy failure, and recursive directory handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsModule from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock the Config module before importing skills-setup
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(),
    getSkillsDir: vi.fn(),
  },
}));

// Mock fs/promises to allow spying
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual };
});

// Import after mocking
const { setupSkillsInWorkspace } = await import('./skills-setup.js');
const { Config } = await import('../config/index.js');

// ============================================================================
// Helpers
// ============================================================================

/** Create directory structure for testing. */
async function createDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Create a file with content. */
async function createFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/** Create a skill directory with files and subdirectories. */
async function createSkillDir(skillsDir: string, skillName: string): Promise<void> {
  const skillPath = path.join(skillsDir, skillName);
  await createDir(skillPath);
  await createFile(path.join(skillPath, 'skill.md'), `# ${skillName}\nSkill content`);
  await createFile(path.join(skillPath, 'config.json'), '{"enabled": true}');
}

/** Create a skill with nested subdirectories. */
async function createNestedSkillDir(skillsDir: string, skillName: string): Promise<void> {
  const skillPath = path.join(skillsDir, skillName);
  await createDir(skillPath);
  await createFile(path.join(skillPath, 'skill.md'), '# Nested Skill');
  await createDir(path.join(skillPath, 'subdir'));
  await createFile(path.join(skillPath, 'subdir', 'helper.md'), '# Helper');
  await createDir(path.join(skillPath, 'deep', 'nested'));
  await createFile(path.join(skillPath, 'deep', 'nested', 'deep.md'), '# Deep nested');
}

/** Check that a file exists (does not throw). */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Check that a path exists. */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('setupSkillsInWorkspace', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let skillsSourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-setup-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    skillsSourceDir = path.join(tmpDir, 'source-skills');
    targetDir = path.join(workspaceDir, '.claude', 'skills');

    await createDir(workspaceDir);
    await createDir(skillsSourceDir);

    vi.mocked(Config.getWorkspaceDir).mockReturnValue(workspaceDir);
    vi.mocked(Config.getSkillsDir).mockReturnValue(skillsSourceDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Successful copy
  // -------------------------------------------------------------------------
  describe('successful copy', () => {
    it('should copy all skill directories from source to target', async () => {
      await createSkillDir(skillsSourceDir, 'skill-a');
      await createSkillDir(skillsSourceDir, 'skill-b');
      await createSkillDir(skillsSourceDir, 'skill-c');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify all skills were copied
      expect(await fileExists(path.join(targetDir, 'skill-a', 'skill.md'))).toBe(true);
      expect(await fileExists(path.join(targetDir, 'skill-b', 'skill.md'))).toBe(true);
      expect(await fileExists(path.join(targetDir, 'skill-c', 'skill.md'))).toBe(true);
    });

    it('should copy nested directories recursively', async () => {
      await createNestedSkillDir(skillsSourceDir, 'nested-skill');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
      expect(await fileExists(path.join(targetDir, 'nested-skill', 'skill.md'))).toBe(true);
      expect(await fileExists(path.join(targetDir, 'nested-skill', 'subdir', 'helper.md'))).toBe(true);
      expect(await fileExists(path.join(targetDir, 'nested-skill', 'deep', 'nested', 'deep.md'))).toBe(true);
    });

    it('should copy file contents correctly', async () => {
      await createSkillDir(skillsSourceDir, 'content-skill');
      // Write specific content
      await fs.writeFile(
        path.join(skillsSourceDir, 'content-skill', 'config.json'),
        '{"key": "value"}',
        'utf-8'
      );

      await setupSkillsInWorkspace();

      const copied = await fs.readFile(path.join(targetDir, 'content-skill', 'config.json'), 'utf-8');
      expect(copied).toBe('{"key": "value"}');
    });

    it('should create target directory if it does not exist', async () => {
      // Remove .claude/skills if it exists
      await fs.rm(path.join(workspaceDir, '.claude'), { recursive: true, force: true });

      await createSkillDir(skillsSourceDir, 'test-skill');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
      expect(await pathExists(targetDir)).toBe(true);
    });

    it('should return success when source has no skill directories', async () => {
      // Source exists but has no subdirectories
      await fs.writeFile(path.join(skillsSourceDir, 'readme.txt'), 'Not a skill', 'utf-8');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should skip non-directory entries in source', async () => {
      await createSkillDir(skillsSourceDir, 'valid-skill');
      await fs.writeFile(path.join(skillsSourceDir, 'notes.txt'), 'Some notes', 'utf-8');
      await fs.writeFile(path.join(skillsSourceDir, '.gitkeep'), '', 'utf-8');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
      // Only the directory should be copied
      expect(await fileExists(path.join(targetDir, 'valid-skill', 'skill.md'))).toBe(true);
      // Non-directories should not be copied as skills
      expect(await fileExists(path.join(targetDir, 'notes.txt'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------
  describe('error cases', () => {
    it('should return failure when source directory does not exist', async () => {
      vi.mocked(Config.getSkillsDir).mockReturnValue(path.join(tmpDir, 'nonexistent-skills'));

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Source skills directory does not exist');
    });

    it('should continue copying other skills when one fails', async () => {
      // Create two valid skills
      await createSkillDir(skillsSourceDir, 'good-skill-1');
      await createSkillDir(skillsSourceDir, 'good-skill-2');

      // Create a skill directory with an unreadable subdirectory
      // We simulate a copy failure by creating a bad skill with a file that
      // points to a non-existent nested directory (triggers mkdir error)
      const badSkill = path.join(skillsSourceDir, 'bad-skill');
      await createDir(badSkill);
      // Create a subdirectory that we'll make inaccessible
      const badSubdir = path.join(badSkill, 'locked');
      await createDir(badSubdir);

      // Mock mkdir to fail for the bad skill's subdirectory during recursive copy
      const originalMkdir = fsModule.mkdir.bind(fsModule);
      vi.spyOn(fsModule, 'mkdir').mockImplementation(async (dir, options) => {
        if (String(dir).includes('locked')) {
          throw new Error('Permission denied');
        }
        return originalMkdir(dir, options);
      });

      const result = await setupSkillsInWorkspace();

      // Should still succeed overall (continues with other skills)
      expect(result.success).toBe(true);

      // Good skills should still be copied
      expect(await fileExists(path.join(targetDir, 'good-skill-1', 'skill.md'))).toBe(true);
      expect(await fileExists(path.join(targetDir, 'good-skill-2', 'skill.md'))).toBe(true);
    });

    it('should handle errors from the outer try-catch', async () => {
      // Mock mkdir to throw for the target directory creation
      const originalMkdir = fsModule.mkdir.bind(fsModule);
      vi.spyOn(fsModule, 'mkdir').mockImplementation(async (dir, options) => {
        if (String(dir).includes('.claude') && String(dir).includes('skills')) {
          throw new Error('Disk full');
        }
        return originalMkdir(dir, options);
      });

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Disk full');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should overwrite existing skills in target directory', async () => {
      // Create initial skill in target
      await createDir(targetDir);
      await createFile(path.join(targetDir, 'overwrite-skill', 'skill.md'), '# Old content');

      // Create new version in source
      await createSkillDir(skillsSourceDir, 'overwrite-skill');
      await fs.writeFile(
        path.join(skillsSourceDir, 'overwrite-skill', 'skill.md'),
        '# New content',
        'utf-8'
      );

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
      const content = await fs.readFile(path.join(targetDir, 'overwrite-skill', 'skill.md'), 'utf-8');
      expect(content).toBe('# New content');
    });

    it('should handle empty source directory', async () => {
      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
      // Target directory should be created
      expect(await pathExists(targetDir)).toBe(true);
    });
  });
});
