/**
 * Tests for Skill Finder (packages/core/src/skills/finder.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, mockAccess, mockReaddir, mockReadFile } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockAccess: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue(mockLogger),
}));

vi.mock('fs/promises', () => ({
  default: {
    access: mockAccess,
    readdir: mockReaddir,
    readFile: mockReadFile,
  },
  access: mockAccess,
  readdir: mockReaddir,
  readFile: mockReadFile,
}));

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn().mockReturnValue('/workspace'),
    getSkillsDir: vi.fn().mockReturnValue('/package/skills'),
  },
}));

import {
  getDefaultSearchPaths,
  findSkill,
  listSkills,
  skillExists,
  readSkillContent,
} from './finder.js';
import type { SkillSearchPath } from './finder.js';

describe('getDefaultSearchPaths', () => {
  it('should return 3 search paths', () => {
    const paths = getDefaultSearchPaths();
    expect(paths).toHaveLength(3);
  });

  it('should return paths sorted by priority (descending)', () => {
    const paths = getDefaultSearchPaths();
    expect(paths[0].priority).toBeGreaterThan(paths[1].priority);
    expect(paths[1].priority).toBeGreaterThan(paths[2].priority);
  });

  it('should have project, workspace, and package domains', () => {
    const paths = getDefaultSearchPaths();
    const domains = paths.map(p => p.domain);
    expect(domains).toContain('project');
    expect(domains).toContain('workspace');
    expect(domains).toContain('package');
  });

  it('should have correct priority values', () => {
    const paths = getDefaultSearchPaths();
    expect(paths[0].domain).toBe('project');
    expect(paths[0].priority).toBe(3);
    expect(paths[1].domain).toBe('workspace');
    expect(paths[1].priority).toBe(2);
    expect(paths[2].domain).toBe('package');
    expect(paths[2].priority).toBe(1);
  });
});

describe('findSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the first found skill path', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // project domain found
    const result = await findSkill('evaluator');
    expect(result).toContain('evaluator');
    expect(result).toContain('SKILL.md');
  });

  it('should search multiple paths and return first match', async () => {
    mockAccess.mockRejectedValueOnce(new Error('not found')); // project not found
    mockAccess.mockResolvedValueOnce(undefined); // workspace found
    const result = await findSkill('evaluator');
    expect(result).toContain('workspace');
    expect(result).toContain('evaluator');
  });

  it('should return null when skill not found', async () => {
    mockAccess.mockRejectedValue(new Error('not found'));
    const result = await findSkill('nonexistent');
    expect(result).toBeNull();
  });

  it('should use custom search paths when provided', async () => {
    const customPaths: SkillSearchPath[] = [
      { path: '/custom/skills', domain: 'project', priority: 1 },
    ];
    mockAccess.mockResolvedValueOnce(undefined);
    const result = await findSkill('custom', customPaths);
    expect(result).toBe('/custom/skills/custom/SKILL.md');
  });

  it('should log debug message when skill is found', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    await findSkill('test-skill');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-skill' }),
      'Found skill'
    );
  });

  it('should log debug message when skill is not found', async () => {
    mockAccess.mockRejectedValue(new Error('not found'));
    await findSkill('missing');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'missing' }),
      'Skill not found'
    );
  });
});

describe('listSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list skills from available search paths', async () => {
    // First path (project) has one skill
    mockReaddir.mockResolvedValueOnce([
      { name: 'evaluator', isDirectory: () => true },
      { name: 'README.md', isDirectory: () => false },
    ] as any);
    mockAccess.mockResolvedValueOnce(undefined);

    // Second path (workspace) has one skill
    mockReaddir.mockResolvedValueOnce([
      { name: 'executor', isDirectory: () => true },
    ] as any);
    mockAccess.mockResolvedValueOnce(undefined);

    // Third path (package) - not found
    mockReaddir.mockRejectedValueOnce(new Error('not found'));

    const result = await listSkills();
    expect(result).toHaveLength(2);
    expect(result.map(s => s.name)).toContain('evaluator');
    expect(result.map(s => s.name)).toContain('executor');
  });

  it('should deduplicate skills by name (higher priority wins)', async () => {
    // Project has evaluator
    mockReaddir.mockResolvedValueOnce([
      { name: 'evaluator', isDirectory: () => true },
    ] as any);
    mockAccess.mockResolvedValueOnce(undefined);

    // Workspace also has evaluator (should be skipped)
    mockReaddir.mockResolvedValueOnce([
      { name: 'evaluator', isDirectory: () => true },
    ] as any);
    mockAccess.mockResolvedValueOnce(undefined);

    // Package - not found
    mockReaddir.mockRejectedValueOnce(new Error('not found'));

    const result = await listSkills();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('evaluator');
    expect(result[0].domain).toBe('project');
  });

  it('should skip directories without SKILL.md', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'no-skill-md', isDirectory: () => true },
    ] as any);
    mockAccess.mockRejectedValueOnce(new Error('not found'));

    // Other paths not found
    mockReaddir.mockRejectedValue(new Error('not found'));

    const result = await listSkills();
    expect(result).toHaveLength(0);
  });

  it('should skip non-directory entries', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'file.txt', isDirectory: () => false },
      { name: 'another.md', isDirectory: () => false },
    ] as any);

    // Other paths not found
    mockReaddir.mockRejectedValue(new Error('not found'));

    const result = await listSkills();
    expect(result).toHaveLength(0);
  });

  it('should return empty array when no search paths exist', async () => {
    mockReaddir.mockRejectedValue(new Error('not found'));
    const result = await listSkills();
    expect(result).toHaveLength(0);
  });

  it('should use custom search paths when provided', async () => {
    const customPaths: SkillSearchPath[] = [
      { path: '/custom/skills', domain: 'project', priority: 1 },
    ];
    mockReaddir.mockResolvedValueOnce([
      { name: 'custom-skill', isDirectory: () => true },
    ] as any);
    mockAccess.mockResolvedValueOnce(undefined);

    const result = await listSkills(customPaths);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('custom-skill');
    expect(result[0].domain).toBe('project');
  });
});

describe('skillExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when skill exists', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    const result = await skillExists('evaluator');
    expect(result).toBe(true);
  });

  it('should return false when skill does not exist', async () => {
    mockAccess.mockRejectedValue(new Error('not found'));
    const result = await skillExists('nonexistent');
    expect(result).toBe(false);
  });
});

describe('readSkillContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return skill content when found', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    mockReadFile.mockResolvedValueOnce('# Evaluator Skill\n\nSome content');

    const result = await readSkillContent('evaluator');
    expect(result).toBe('# Evaluator Skill\n\nSome content');
  });

  it('should return null when skill not found', async () => {
    mockAccess.mockRejectedValue(new Error('not found'));
    const result = await readSkillContent('nonexistent');
    expect(result).toBeNull();
  });

  it('should return null when readFile fails', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    mockReadFile.mockRejectedValueOnce(new Error('permission denied'));

    const result = await readSkillContent('evaluator');
    expect(result).toBeNull();
  });

  it('should log error when readFile fails', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    mockReadFile.mockRejectedValueOnce(new Error('permission denied'));

    await readSkillContent('evaluator');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ skillPath: expect.stringContaining('evaluator') }),
      'Failed to read skill content'
    );
  });
});
