/**
 * Tests for SkillFinder.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findSkill,
  listSkills,
  skillExists,
  readSkillContent,
  getDefaultSearchPaths,
  type SkillSearchPath,
} from './finder.js';

// Mock Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
    getSkillsDir: vi.fn(() => '/tmp/test-skills'),
  },
}));

describe('SkillFinder', () => {
  let tempDir: string;
  let projectSkillsDir: string;
  let workspaceSkillsDir: string;
  let packageSkillsDir: string;

  beforeEach(async () => {
    // Create temp directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    projectSkillsDir = path.join(tempDir, 'project', '.claude', 'skills');
    workspaceSkillsDir = path.join(tempDir, 'workspace', '.claude', 'skills');
    packageSkillsDir = path.join(tempDir, 'package', 'skills');

    await fs.mkdir(projectSkillsDir, { recursive: true });
    await fs.mkdir(workspaceSkillsDir, { recursive: true });
    await fs.mkdir(packageSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('getDefaultSearchPaths', () => {
    it('should return search paths sorted by priority', () => {
      const paths = getDefaultSearchPaths();

      expect(paths).toHaveLength(3);
      expect(paths[0].priority).toBeGreaterThanOrEqual(paths[1].priority);
      expect(paths[1].priority).toBeGreaterThanOrEqual(paths[2].priority);
    });

    it('should include project, workspace, and package domains', () => {
      const paths = getDefaultSearchPaths();
      const domains = paths.map(p => p.domain);

      expect(domains).toContain('project');
      expect(domains).toContain('workspace');
      expect(domains).toContain('package');
    });
  });

  describe('findSkill', () => {
    it('should find skill in highest priority domain', async () => {
      // Create skill in package domain
      const skillDir = path.join(packageSkillsDir, 'test-skill');
      await fs.mkdir(skillDir);
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');

      const searchPaths: SkillSearchPath[] = [
        { path: projectSkillsDir, domain: 'project', priority: 3 },
        { path: workspaceSkillsDir, domain: 'workspace', priority: 2 },
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const result = await findSkill('test-skill', searchPaths);

      expect(result).toBe(path.join(packageSkillsDir, 'test-skill', 'SKILL.md'));
    });

    it('should return project domain skill when exists in multiple domains', async () => {
      // Create skill in all domains
      for (const dir of [packageSkillsDir, workspaceSkillsDir, projectSkillsDir]) {
        const skillDir = path.join(dir, 'common-skill');
        await fs.mkdir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# Skill from ${dir}`);
      }

      const searchPaths: SkillSearchPath[] = [
        { path: projectSkillsDir, domain: 'project', priority: 3 },
        { path: workspaceSkillsDir, domain: 'workspace', priority: 2 },
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const result = await findSkill('common-skill', searchPaths);

      // Should return project domain (highest priority)
      expect(result).toBe(path.join(projectSkillsDir, 'common-skill', 'SKILL.md'));
    });

    it('should return null when skill not found', async () => {
      const searchPaths: SkillSearchPath[] = [
        { path: projectSkillsDir, domain: 'project', priority: 3 },
      ];

      const result = await findSkill('nonexistent', searchPaths);

      expect(result).toBeNull();
    });

    it('should skip directories without SKILL.md', async () => {
      // Create directory without SKILL.md
      const noSkillDir = path.join(packageSkillsDir, 'no-skill');
      await fs.mkdir(noSkillDir);
      await fs.writeFile(path.join(noSkillDir, 'README.md'), 'No skill here');

      const searchPaths: SkillSearchPath[] = [
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const result = await findSkill('no-skill', searchPaths);

      expect(result).toBeNull();
    });
  });

  describe('listSkills', () => {
    it('should list all skills across domains', async () => {
      // Create skills in different domains
      const skill1Dir = path.join(projectSkillsDir, 'project-skill');
      await fs.mkdir(skill1Dir);
      await fs.writeFile(path.join(skill1Dir, 'SKILL.md'), '# Project Skill');

      const skill2Dir = path.join(packageSkillsDir, 'package-skill');
      await fs.mkdir(skill2Dir);
      await fs.writeFile(path.join(skill2Dir, 'SKILL.md'), '# Package Skill');

      const searchPaths: SkillSearchPath[] = [
        { path: projectSkillsDir, domain: 'project', priority: 3 },
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const skills = await listSkills(searchPaths);

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name)).toContain('project-skill');
      expect(skills.map(s => s.name)).toContain('package-skill');
    });

    it('should deduplicate skills by priority', async () => {
      // Create same skill in multiple domains
      for (const dir of [packageSkillsDir, projectSkillsDir]) {
        const skillDir = path.join(dir, 'shared-skill');
        await fs.mkdir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# Skill from ${dir}`);
      }

      const searchPaths: SkillSearchPath[] = [
        { path: projectSkillsDir, domain: 'project', priority: 3 },
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const skills = await listSkills(searchPaths);

      // Should only return one entry (highest priority)
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('shared-skill');
      expect(skills[0].domain).toBe('project');
    });

    it('should return empty array when no skills found', async () => {
      const searchPaths: SkillSearchPath[] = [
        { path: projectSkillsDir, domain: 'project', priority: 3 },
      ];

      const skills = await listSkills(searchPaths);

      expect(skills).toEqual([]);
    });
  });

  describe('skillExists', () => {
    it('should return true when skill exists', async () => {
      const skillDir = path.join(packageSkillsDir, 'existing-skill');
      await fs.mkdir(skillDir);
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Existing Skill');

      const searchPaths: SkillSearchPath[] = [
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const exists = await skillExists('existing-skill', searchPaths);

      expect(exists).toBe(true);
    });

    it('should return false when skill does not exist', async () => {
      const searchPaths: SkillSearchPath[] = [
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const exists = await skillExists('nonexistent', searchPaths);

      expect(exists).toBe(false);
    });
  });

  describe('readSkillContent', () => {
    it('should read skill file content', async () => {
      const skillDir = path.join(packageSkillsDir, 'readable-skill');
      await fs.mkdir(skillDir);
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Readable Skill\n\nContent here.');

      const searchPaths: SkillSearchPath[] = [
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const content = await readSkillContent('readable-skill', searchPaths);

      expect(content).toBe('# Readable Skill\n\nContent here.');
    });

    it('should return null when skill not found', async () => {
      const searchPaths: SkillSearchPath[] = [
        { path: packageSkillsDir, domain: 'package', priority: 1 },
      ];

      const content = await readSkillContent('nonexistent', searchPaths);

      expect(content).toBeNull();
    });
  });
});
