/**
 * Tests for skills/finder.ts
 *
 * Tests skill discovery and management:
 * - findSkill: find skill by name across search paths
 * - listSkills: list all available skills
 * - skillExists: check if a skill exists
 * - readSkillContent: read skill file content
 * - getDefaultSearchPaths: get default search path configuration
 * - Priority-based resolution (project > workspace > package)
 * - Graceful handling of missing directories/files
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import {
  findSkill,
  listSkills,
  skillExists,
  readSkillContent,
  getDefaultSearchPaths,
  type SkillSearchPath,
} from './finder.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
    getSkillsDir: () => '/test/package/skills',
  },
}));

/** Helper to create a mock Dirent-like object for testing */
function makeDirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
  };
}

describe('SkillFinder', () => {
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockReaddir: ReturnType<typeof vi.fn>;

  const projectPath: SkillSearchPath = {
    path: '/cwd/.claude/skills',
    domain: 'project',
    priority: 3,
  };

  const workspacePath: SkillSearchPath = {
    path: '/test/workspace/.claude/skills',
    domain: 'workspace',
    priority: 2,
  };

  const packagePath: SkillSearchPath = {
    path: '/test/package/skills',
    domain: 'package',
    priority: 1,
  };

  const customSearchPaths = [projectPath, workspacePath, packagePath];

  beforeEach(() => {
    vi.clearAllMocks();

    mockAccess = vi.mocked(fs.access);
    mockReadFile = vi.mocked(fs.readFile);
    mockReaddir = vi.mocked(fs.readdir);

    // Default: no files found
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
  });

  describe('getDefaultSearchPaths', () => {
    it('should return paths sorted by priority (highest first)', () => {
      const paths = getDefaultSearchPaths();

      expect(paths).toHaveLength(3);
      expect(paths[0].domain).toBe('project');
      expect(paths[0].priority).toBe(3);
      expect(paths[1].domain).toBe('workspace');
      expect(paths[1].priority).toBe(2);
      expect(paths[2].domain).toBe('package');
      expect(paths[2].priority).toBe(1);
    });

    it('should include project domain path from cwd', () => {
      const paths = getDefaultSearchPaths();
      const projectPathEntry = paths.find(p => p.domain === 'project');
      expect(projectPathEntry).toBeDefined();
      expect(projectPathEntry?.path).toContain('.claude');
      expect(projectPathEntry?.path).toContain('skills');
    });

    it('should include workspace domain path from config', () => {
      const paths = getDefaultSearchPaths();
      const workspacePathEntry = paths.find(p => p.domain === 'workspace');
      expect(workspacePathEntry).toBeDefined();
      expect(workspacePathEntry?.path).toContain('/test/workspace');
    });

    it('should include package domain path from config', () => {
      const paths = getDefaultSearchPaths();
      const packagePathEntry = paths.find(p => p.domain === 'package');
      expect(packagePathEntry).toBeDefined();
      expect(packagePathEntry?.path).toBe('/test/package/skills');
    });
  });

  describe('findSkill', () => {
    it('should find skill in project domain (highest priority)', async () => {
      mockAccess.mockResolvedValue(undefined);

      const result = await findSkill('evaluator', customSearchPaths);

      expect(result).toContain('evaluator');
      expect(result).toContain('SKILL.md');
      expect(result).toContain('.claude/skills');
    });

    it('should fall through to workspace domain when not in project', async () => {
      // Project path: not found
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      // Workspace path: found
      mockAccess.mockResolvedValueOnce(undefined);

      const result = await findSkill('evaluator', customSearchPaths);

      expect(result).toContain('/test/workspace');
      expect(result).toContain('evaluator');
    });

    it('should fall through to package domain when not in project or workspace', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      mockAccess.mockResolvedValueOnce(undefined);

      const result = await findSkill('evaluator', customSearchPaths);

      expect(result).toContain('/test/package/skills');
      expect(result).toContain('evaluator');
    });

    it('should return null when skill is not found in any path', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await findSkill('nonexistent', customSearchPaths);

      expect(result).toBeNull();
    });

    it('should prioritize project over workspace for same skill name', async () => {
      // First call (project) succeeds
      mockAccess.mockResolvedValueOnce(undefined);

      const result = await findSkill('my-skill', customSearchPaths);

      expect(result).toContain('.claude/skills');
      expect(result).not.toContain('/test/workspace');
      // Only one call needed since first path has the skill
      expect(mockAccess).toHaveBeenCalledTimes(1);
    });

    it('should handle custom search paths', async () => {
      const customPaths: SkillSearchPath[] = [
        { path: '/custom/skills', domain: 'project', priority: 1 },
      ];

      mockAccess.mockResolvedValueOnce(undefined);

      const result = await findSkill('custom-skill', customPaths);

      expect(result).toBe('/custom/skills/custom-skill/SKILL.md');
    });

    it('should handle empty search paths', async () => {
      const result = await findSkill('any-skill', []);

      expect(result).toBeNull();
    });
  });

  describe('listSkills', () => {
    it('should list skills from a single domain', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('evaluator', true),
        makeDirent('analyzer', true),
        makeDirent('README.md', false),
      ]);

      mockAccess.mockResolvedValue(undefined);

      const skills = await listSkills(customSearchPaths);

      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name)).toContain('evaluator');
      expect(skills.map(s => s.name)).toContain('analyzer');
      expect(skills[0].domain).toBe('project');
    });

    it('should skip directories without SKILL.md', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('valid-skill', true),
        makeDirent('no-skill-md', true),
      ]);

      // valid-skill has SKILL.md, no-skill-md does not
      mockAccess.mockResolvedValueOnce(undefined);
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));

      const skills = await listSkills(customSearchPaths);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('valid-skill');
    });

    it('should skip non-directory entries', async () => {
      mockReaddir.mockResolvedValueOnce([
        makeDirent('evaluator', true),
        makeDirent('config.json', false),
        makeDirent('.gitkeep', false),
      ]);

      mockAccess.mockResolvedValue(undefined);

      const skills = await listSkills(customSearchPaths);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('evaluator');
    });

    it('should deduplicate skills across domains (higher priority wins)', async () => {
      // Project domain: has evaluator
      mockReaddir.mockResolvedValueOnce([
        makeDirent('evaluator', true),
      ]);
      mockAccess.mockResolvedValueOnce(undefined);

      // Workspace domain: also has evaluator
      mockReaddir.mockResolvedValueOnce([
        makeDirent('evaluator', true),
      ]);
      mockAccess.mockResolvedValueOnce(undefined);

      const skills = await listSkills(customSearchPaths);

      // Should only return one evaluator (from project, higher priority)
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('evaluator');
      expect(skills[0].domain).toBe('project');
    });

    it('should combine skills from different domains', async () => {
      // Project: has evaluator
      mockReaddir.mockResolvedValueOnce([
        makeDirent('evaluator', true),
      ]);
      mockAccess.mockResolvedValueOnce(undefined);

      // Workspace: has analyzer (not in project)
      mockReaddir.mockResolvedValueOnce([
        makeDirent('analyzer', true),
      ]);
      mockAccess.mockResolvedValueOnce(undefined);

      // Package: has deployer (not in project or workspace)
      mockReaddir.mockResolvedValueOnce([
        makeDirent('deployer', true),
      ]);
      mockAccess.mockResolvedValueOnce(undefined);

      const skills = await listSkills(customSearchPaths);

      expect(skills).toHaveLength(3);
      const names = skills.map(s => s.name);
      expect(names).toContain('evaluator');
      expect(names).toContain('analyzer');
      expect(names).toContain('deployer');
    });

    it('should handle non-existent search paths gracefully', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const skills = await listSkills(customSearchPaths);

      expect(skills).toHaveLength(0);
    });

    it('should return empty array when no skills found', async () => {
      mockReaddir.mockResolvedValueOnce([]);

      const skills = await listSkills(customSearchPaths);

      expect(skills).toHaveLength(0);
    });

    it('should handle empty search paths', async () => {
      const skills = await listSkills([]);

      expect(skills).toHaveLength(0);
    });
  });

  describe('skillExists', () => {
    it('should return true when skill exists', async () => {
      mockAccess.mockResolvedValue(undefined);

      const result = await skillExists('evaluator', customSearchPaths);

      expect(result).toBe(true);
    });

    it('should return false when skill does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await skillExists('nonexistent', customSearchPaths);

      expect(result).toBe(false);
    });
  });

  describe('readSkillContent', () => {
    it('should return content when skill exists', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('# My Skill\n\nThis is the skill content.');

      const content = await readSkillContent('evaluator', customSearchPaths);

      expect(content).toBe('# My Skill\n\nThis is the skill content.');
    });

    it('should return null when skill does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const content = await readSkillContent('nonexistent', customSearchPaths);

      expect(content).toBeNull();
    });

    it('should return null when file read fails', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const content = await readSkillContent('evaluator', customSearchPaths);

      expect(content).toBeNull();
    });
  });
});
