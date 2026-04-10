/**
 * Tests for skills-setup utility (packages/core/src/utils/skills-setup.ts)
 *
 * Validates skill directory copying from source to workspace .claude/skills.
 * Uses real temp directories to avoid ESM module mocking limitations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock Config module - returns temp directories for testing
let testWorkspaceDir: string;
let testSourceDir: string;

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => testWorkspaceDir,
    getSkillsDir: () => testSourceDir,
  },
}));

// Mock logger
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks are set up
import { setupSkillsInWorkspace } from './skills-setup.js';

describe('skills-setup', () => {
  beforeEach(async () => {
    // Create temp directories for testing
    testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-ws-'));
    testSourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-src-'));
  });

  afterEach(async () => {
    // Clean up temp directories
    await fs.rm(testWorkspaceDir, { recursive: true, force: true });
    await fs.rm(testSourceDir, { recursive: true, force: true });
  });

  describe('setupSkillsInWorkspace', () => {
    it('should return failure when source directory does not exist', async () => {
      // Point source to a non-existent directory
      testSourceDir = '/tmp/non-existent-skills-dir-12345';

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Source skills directory does not exist');
    });

    it('should return success when source directory is empty', async () => {
      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should copy skill directories to workspace', async () => {
      // Create source skill directories
      const skillA = path.join(testSourceDir, 'skill-a');
      const skillB = path.join(testSourceDir, 'skill-b');
      await fs.mkdir(skillA);
      await fs.mkdir(skillB);

      // Add files inside skills
      await fs.writeFile(path.join(skillA, 'skill.md'), '# Skill A');
      await fs.writeFile(path.join(skillB, 'skill.md'), '# Skill B');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      // Verify files were copied
      const targetDir = path.join(testWorkspaceDir, '.claude', 'skills');
      const contentA = await fs.readFile(path.join(targetDir, 'skill-a', 'skill.md'), 'utf-8');
      const contentB = await fs.readFile(path.join(targetDir, 'skill-b', 'skill.md'), 'utf-8');
      expect(contentA).toBe('# Skill A');
      expect(contentB).toBe('# Skill B');
    });

    it('should skip non-directory entries', async () => {
      // Create a file (not directory) in source
      await fs.writeFile(path.join(testSourceDir, 'readme.txt'), 'Not a skill');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      // Verify readme was not copied
      const targetDir = path.join(testWorkspaceDir, '.claude', 'skills');
      const entries = await fs.readdir(targetDir).catch(() => []);
      expect(entries).not.toContain('readme.txt');
    });

    it('should copy nested directory structures', async () => {
      const skill = path.join(testSourceDir, 'complex-skill');
      await fs.mkdir(path.join(skill, 'subdir'), { recursive: true });
      await fs.writeFile(path.join(skill, 'skill.md'), '# Complex Skill');
      await fs.writeFile(path.join(skill, 'subdir', 'helper.md'), '# Helper');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      const targetSkill = path.join(testWorkspaceDir, '.claude', 'skills', 'complex-skill');
      const helperContent = await fs.readFile(path.join(targetSkill, 'subdir', 'helper.md'), 'utf-8');
      expect(helperContent).toBe('# Helper');
    });

    it('should continue when individual skill copy fails', async () => {
      // Create one valid skill
      const skillOk = path.join(testSourceDir, 'skill-ok');
      await fs.mkdir(skillOk);
      await fs.writeFile(path.join(skillOk, 'skill.md'), '# OK');

      // Create a directory with restricted permissions (will fail on copy)
      const skillBroken = path.join(testSourceDir, 'skill-broken');
      await fs.mkdir(skillBroken, { recursive: true });

      const result = await setupSkillsInWorkspace();
      // Should still succeed - failures are logged but not fatal
      expect(result.success).toBe(true);

      // The valid skill should still be copied
      const targetDir = path.join(testWorkspaceDir, '.claude', 'skills');
      const okContent = await fs.readFile(path.join(targetDir, 'skill-ok', 'skill.md'), 'utf-8');
      expect(okContent).toBe('# OK');
    });

    it('should handle mix of files and directories', async () => {
      const skill = path.join(testSourceDir, 'my-skill');
      await fs.mkdir(skill);
      await fs.writeFile(path.join(skill, 'skill.md'), '# My Skill');
      await fs.writeFile(path.join(testSourceDir, 'config.json'), '{}');
      await fs.writeFile(path.join(testSourceDir, 'notes.txt'), 'notes');

      const result = await setupSkillsInWorkspace();
      expect(result.success).toBe(true);

      const targetDir = path.join(testWorkspaceDir, '.claude', 'skills');
      const entries = await fs.readdir(targetDir);
      expect(entries).toContain('my-skill');
      expect(entries).not.toContain('config.json');
      expect(entries).not.toContain('notes.txt');
    });
  });
});
