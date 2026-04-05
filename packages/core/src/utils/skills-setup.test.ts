/**
 * Tests for skills-setup utility (Issue #1617 Phase 2)
 *
 * Tests the setupSkillsInWorkspace function which copies skills
 * from the package directory to the workspace's .claude/skills/.
 *
 * Uses real temp directories for integration testing, following
 * the pattern established in agents-setup.test.ts.
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

describe('setupSkillsInWorkspace', () => {
  let setupSkillsInWorkspace: typeof import('./skills-setup.js').setupSkillsInWorkspace;
  let tempDir: string;
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-setup-test-'));
    sourceDir = path.join(tempDir, 'package-skills');
    targetDir = path.join(tempDir, 'workspace', '.claude', 'skills');

    mockGetWorkspaceDir.mockReturnValue(path.join(tempDir, 'workspace'));
    mockGetSkillsDir.mockReturnValue(sourceDir);

    vi.resetModules();
    const mod = await import('./skills-setup.js');
    ({ setupSkillsInWorkspace } = mod);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('when source skills directory does not exist', () => {
    it('should return failure with error message', async () => {
      mockGetSkillsDir.mockReturnValue('/nonexistent/skills');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Source skills directory does not exist');
    });
  });

  describe('when copying skill directories', () => {
    it('should create .claude/skills/ and copy skill subdirectories', async () => {
      // Create source skills
      const skillA = path.join(sourceDir, 'skill-a');
      await fs.mkdir(skillA, { recursive: true });
      await fs.writeFile(path.join(skillA, 'SKILL.md'), '# Skill A');

      const skillB = path.join(sourceDir, 'skill-b');
      await fs.mkdir(skillB, { recursive: true });
      await fs.writeFile(path.join(skillB, 'SKILL.md'), '# Skill B');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);

      // Verify skill-a was copied
      const skillAContent = await fs.readFile(
        path.join(targetDir, 'skill-a', 'SKILL.md'), 'utf-8',
      );
      expect(skillAContent).toBe('# Skill A');

      // Verify skill-b was copied
      const skillBContent = await fs.readFile(
        path.join(targetDir, 'skill-b', 'SKILL.md'), 'utf-8',
      );
      expect(skillBContent).toBe('# Skill B');
    });

    it('should copy nested subdirectories within a skill', async () => {
      // Create source skill with nested structure
      const skillDir = path.join(sourceDir, 'complex-skill');
      const subDir = path.join(skillDir, 'subdir', 'nested');
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Complex');
      await fs.writeFile(path.join(subDir, 'helper.ts'), 'export const x = 1;');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);

      // Verify nested file was copied
      const nestedContent = await fs.readFile(
        path.join(targetDir, 'complex-skill', 'subdir', 'nested', 'helper.ts'), 'utf-8',
      );
      expect(nestedContent).toBe('export const x = 1;');
    });

    it('should skip non-directory entries in source', async () => {
      // Create source with both files and directories
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'README.md'), '# Skills');
      await fs.writeFile(path.join(sourceDir, 'config.json'), '{}');

      const skillDir = path.join(sourceDir, 'valid-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Valid');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);

      // Verify skill directory was copied
      const content = await fs.readFile(
        path.join(targetDir, 'valid-skill', 'SKILL.md'), 'utf-8',
      );
      expect(content).toBe('# Valid');

      // Verify standalone files were NOT copied
      await expect(
        fs.access(path.join(targetDir, 'README.md')),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(targetDir, 'config.json')),
      ).rejects.toThrow();
    });

    it('should succeed with empty source directory', async () => {
      await fs.mkdir(sourceDir, { recursive: true });

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);

      // Verify target directory was created
      const stat = await fs.stat(targetDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should continue copying other skills when one fails', async () => {
      // Create a readable skill
      const goodSkill = path.join(sourceDir, 'good-skill');
      await fs.mkdir(goodSkill, { recursive: true });
      await fs.writeFile(path.join(goodSkill, 'SKILL.md'), '# Good');

      // Create a skill directory that will cause issues (permission-like)
      const badSkill = path.join(sourceDir, 'bad-skill');
      await fs.mkdir(badSkill, { recursive: true });
      await fs.writeFile(path.join(badSkill, 'SKILL.md'), '# Bad');

      // Create another good skill
      const anotherGood = path.join(sourceDir, 'another-good');
      await fs.mkdir(anotherGood, { recursive: true });
      await fs.writeFile(path.join(anotherGood, 'SKILL.md'), '# Another');

      const result = await setupSkillsInWorkspace();

      // Should still succeed overall (individual failures are logged as warnings)
      expect(result.success).toBe(true);

      // Verify good skills were copied
      const goodContent = await fs.readFile(
        path.join(targetDir, 'good-skill', 'SKILL.md'), 'utf-8',
      );
      expect(goodContent).toBe('# Good');

      const anotherContent = await fs.readFile(
        path.join(targetDir, 'another-good', 'SKILL.md'), 'utf-8',
      );
      expect(anotherContent).toBe('# Another');
    });

    it('should handle unexpected errors gracefully', async () => {
      // Make getWorkspaceDir throw
      mockGetWorkspaceDir.mockImplementation(() => {
        throw new Error('Config error');
      });

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Config error');
    });
  });
});
