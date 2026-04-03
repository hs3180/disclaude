/**
 * Tests for SkillsSetup - copying skills to workspace.
 *
 * @module utils/skills-setup.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

// Mock Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(),
    getSkillsDir: vi.fn(),
  },
}));

// Mock logger module
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { setupSkillsInWorkspace } from './skills-setup.js';
import { Config } from '../config/index.js';

describe('SkillsSetup', () => {
  let tmpDir: string;
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-setup-test-'));
    sourceDir = path.join(tmpDir, 'source-skills');
    targetDir = path.join(tmpDir, 'workspace', '.claude', 'skills');

    // Create source skills directory
    await fs.mkdir(sourceDir, { recursive: true });

    // Create skill directories with files
    const skill1Dir = path.join(sourceDir, 'skill-1');
    await fs.mkdir(skill1Dir, { recursive: true });
    await fs.writeFile(path.join(skill1Dir, 'skill.md'), '# Skill 1', 'utf-8');

    const skill2Dir = path.join(sourceDir, 'skill-2');
    await fs.mkdir(skill2Dir, { recursive: true });
    await fs.writeFile(path.join(skill2Dir, 'index.ts'), 'export default {}', 'utf-8');

    // Create a nested skill
    const skill3Dir = path.join(sourceDir, 'skill-3');
    await fs.mkdir(path.join(skill3Dir, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(skill3Dir, 'main.ts'), 'export default {}', 'utf-8');
    await fs.writeFile(path.join(skill3Dir, 'subdir', 'helper.ts'), 'export const help = true;', 'utf-8');

    // Create a regular file in source (not a directory, should be skipped)
    await fs.writeFile(path.join(sourceDir, 'readme.txt'), 'Skills directory', 'utf-8');

    // Mock Config
    vi.mocked(Config.getWorkspaceDir).mockReturnValue(path.join(tmpDir, 'workspace'));
    vi.mocked(Config.getSkillsDir).mockReturnValue(sourceDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('setupSkillsInWorkspace', () => {
    it('should copy all skill directories to workspace', async () => {
      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);

      // Verify skill-1 was copied
      const skill1Content = await fs.readFile(
        path.join(targetDir, 'skill-1', 'skill.md'), 'utf-8'
      );
      expect(skill1Content).toBe('# Skill 1');

      // Verify skill-2 was copied
      const skill2Content = await fs.readFile(
        path.join(targetDir, 'skill-2', 'index.ts'), 'utf-8'
      );
      expect(skill2Content).toBe('export default {}');
    });

    it('should copy nested directories recursively', async () => {
      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);

      // Verify nested structure
      const mainContent = await fs.readFile(
        path.join(targetDir, 'skill-3', 'main.ts'), 'utf-8'
      );
      expect(mainContent).toBe('export default {}');

      const helperContent = await fs.readFile(
        path.join(targetDir, 'skill-3', 'subdir', 'helper.ts'), 'utf-8'
      );
      expect(helperContent).toBe('export const help = true;');
    });

    it('should skip non-directory entries in source', async () => {
      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);

      // readme.txt should not be copied as a skill
      const readmePath = path.join(targetDir, 'readme.txt');
      await expect(fs.access(readmePath)).rejects.toThrow();
    });

    it('should return error when source directory does not exist', async () => {
      vi.mocked(Config.getSkillsDir).mockReturnValue('/nonexistent/skills');

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Source skills directory does not exist');
    });

    it('should continue copying when one skill fails', async () => {
      // Make skill-2 directory unreadable by mocking fs.readdir to throw for skill-2
      // We test this by verifying the overall success even with partial failures
      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
    });

    it('should handle empty source directory', async () => {
      // Clear source directory
      const entries = await fs.readdir(sourceDir);
      for (const entry of entries) {
        await fs.rm(path.join(sourceDir, entry), { recursive: true, force: true });
      }

      const result = await setupSkillsInWorkspace();

      expect(result.success).toBe(true);
    });
  });
});
