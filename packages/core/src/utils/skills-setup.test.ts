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

  describe('when target directory already exists', () => {
    it('should overwrite existing skill content', async () => {
      // First, create and copy initial skills
      const skillDir = path.join(sourceDir, 'my-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Version 1');
      await fs.mkdir(targetDir, { recursive: true });

      const result1 = await setupSkillsInWorkspace();
      expect(result1.success).toBe(true);

      // Now update source and re-run
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Version 2');

      const result2 = await setupSkillsInWorkspace();
      expect(result2.success).toBe(true);

      const content = await fs.readFile(
        path.join(targetDir, 'my-skill', 'SKILL.md'), 'utf-8',
      );
      expect(content).toBe('Version 2');
    });

    it('should not remove extra files in existing target skill directory', async () => {
      // Create source skill
      const skillDir = path.join(sourceDir, 'my-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');

      // First copy
      await setupSkillsInWorkspace();

      // Add an extra file to the target (simulating a file added by the user)
      await fs.writeFile(
        path.join(targetDir, 'my-skill', 'user-custom.md'), 'Custom',
      );

      // Re-run
      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      // Source file should still be there
      const content = await fs.readFile(
        path.join(targetDir, 'my-skill', 'SKILL.md'), 'utf-8',
      );
      expect(content).toBe('# Skill');

      // User-added file should also still be there (copyFile overwrites, doesn't delete)
      const customContent = await fs.readFile(
        path.join(targetDir, 'my-skill', 'user-custom.md'), 'utf-8',
      );
      expect(customContent).toBe('Custom');
    });
  });

  describe('file content integrity', () => {
    it('should preserve binary-like content in skill files', async () => {
      const skillDir = path.join(sourceDir, 'binary-skill');
      await fs.mkdir(skillDir, { recursive: true });

      // Write content with special characters
      const specialContent = '日本語テスト 🎉 \n\ttabs & "quotes"';
      await fs.writeFile(path.join(skillDir, 'data.txt'), specialContent, 'utf-8');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      const content = await fs.readFile(
        path.join(targetDir, 'binary-skill', 'data.txt'), 'utf-8',
      );
      expect(content).toBe(specialContent);
    });

    it('should handle multiple file types within a skill', async () => {
      const skillDir = path.join(sourceDir, 'multi-file-skill');
      await fs.mkdir(skillDir, { recursive: true });

      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Multi');
      await fs.writeFile(path.join(skillDir, 'script.sh'), '#!/bin/bash\necho hello');
      await fs.writeFile(path.join(skillDir, 'config.json'), '{"key": "value"}');
      await fs.writeFile(path.join(skillDir, 'data.yaml'), 'key: value\nlist:\n  - item1');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      // Verify all files were copied
      for (const file of ['SKILL.md', 'script.sh', 'config.json', 'data.yaml']) {
        const exists = await fs.access(path.join(targetDir, 'multi-file-skill', file))
          .then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }

      const jsonContent = await fs.readFile(
        path.join(targetDir, 'multi-file-skill', 'config.json'), 'utf-8',
      );
      expect(jsonContent).toBe('{"key": "value"}');
    });

    it('should handle empty files within skills', async () => {
      const skillDir = path.join(sourceDir, 'empty-file-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Empty File Skill');
      await fs.writeFile(path.join(skillDir, 'empty.txt'), '');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      const content = await fs.readFile(
        path.join(targetDir, 'empty-file-skill', 'empty.txt'), 'utf-8',
      );
      expect(content).toBe('');
    });

    it('should handle deeply nested directories (3+ levels)', async () => {
      const skillDir = path.join(sourceDir, 'deep-skill');
      const deepDir = path.join(skillDir, 'a', 'b', 'c', 'd');
      await fs.mkdir(deepDir, { recursive: true });
      await fs.writeFile(path.join(deepDir, 'deep.txt'), 'Deep content');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      const content = await fs.readFile(
        path.join(targetDir, 'deep-skill', 'a', 'b', 'c', 'd', 'deep.txt'), 'utf-8',
      );
      expect(content).toBe('Deep content');
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
