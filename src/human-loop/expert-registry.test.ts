/**
 * Tests for Expert Registry.
 *
 * @see Issue #532 - Human-in-the-Loop interaction system
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { ExpertRegistry, getExpertRegistry } from './expert-registry.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock js-yaml
vi.mock('js-yaml', () => ({
  load: vi.fn((content: string) => {
    // Simple YAML-like parsing for test data
    if (content.includes('experts:')) {
      return {
        experts: [
          {
            open_id: 'ou_expert_1',
            name: 'Expert One',
            skills: [
              { name: 'React', level: 4 },
              { name: 'TypeScript', level: 5 },
            ],
          },
          {
            open_id: 'ou_expert_2',
            name: 'Expert Two',
            skills: [
              { name: 'Node.js', level: 3 },
              { name: 'Python', level: 4 },
            ],
          },
        ],
      };
    }
    return {};
  }),
  dump: vi.fn(() => 'experts:\n  - open_id: "test"'),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('ExpertRegistry', () => {
  let registry: ExpertRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ExpertRegistry();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('load', () => {
    it('should load experts from config file', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      const result = await registry.load();

      expect(result).toBe(true);
      const experts = await registry.getAll();
      expect(experts.length).toBe(2);
    });

    it('should return empty array when config file does not exist', async () => {
      const mockAccess = vi.mocked(fs.access);
      mockAccess.mockRejectedValue(new Error('File not found'));

      const result = await registry.load();

      expect(result).toBe(true);
      const experts = await registry.getAll();
      expect(experts).toEqual([]);
    });

    it('should return false on parse error', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue(new Error('Read error'));

      const result = await registry.load();

      expect(result).toBe(false);
    });
  });

  describe('findBySkill', () => {
    it('should find experts by skill name (case-insensitive)', async () => {
      // Pre-load the registry
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const experts = await registry.findBySkill('react');

      expect(experts.length).toBe(1);
      expect(experts[0].name).toBe('Expert One');
    });

    it('should filter by minimum level', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const experts = await registry.findBySkill('typescript', 5);

      expect(experts.length).toBe(1);
      expect(experts[0].name).toBe('Expert One');
    });

    it('should return empty array when no match', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const experts = await registry.findBySkill('nonexistent');

      expect(experts).toEqual([]);
    });

    it('should return empty array when level too high', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const experts = await registry.findBySkill('node.js', 5);

      expect(experts).toEqual([]);
    });
  });

  describe('findBestMatch', () => {
    it('should return expert with highest skill level', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const expert = await registry.findBestMatch('typescript');

      expect(expert).toBeDefined();
      expect(expert?.name).toBe('Expert One');
    });

    it('should return undefined when no match', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const expert = await registry.findBestMatch('nonexistent');

      expect(expert).toBeUndefined();
    });
  });

  describe('getByOpenId', () => {
    it('should return expert by open_id', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const expert = await registry.getByOpenId('ou_expert_1');

      expect(expert).toBeDefined();
      expect(expert?.name).toBe('Expert One');
    });

    it('should return undefined for unknown open_id', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      await registry.load();

      const expert = await registry.getByOpenId('ou_unknown');

      expect(expert).toBeUndefined();
    });
  });

  describe('createSample', () => {
    it('should create sample config file', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockMkdir = vi.mocked(fs.mkdir);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockRejectedValue(new Error('File not found'));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await registry.createSample();

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should not overwrite existing file by default', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockResolvedValue(undefined);

      await registry.createSample();

      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('getExpertRegistry singleton', () => {
    it('should return the same instance', () => {
      const instance1 = getExpertRegistry();
      const instance2 = getExpertRegistry();

      expect(instance1).toBe(instance2);
    });
  });

  // Issue #535: Expert registration tests
  describe('register', () => {
    it('should register a new expert', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      const mockWriteFile = vi.mocked(fs.writeFile);
      const mockMkdir = vi.mocked(fs.mkdir);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);

      await registry.load();
      const result = await registry.register('ou_new_expert', 'New Expert');

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should update existing expert name', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      mockWriteFile.mockResolvedValue(undefined);

      await registry.load();
      const result = await registry.register('ou_expert_1', 'Updated Name');

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(false);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should not update if name is same', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      mockWriteFile.mockResolvedValue(undefined);

      await registry.load();
      const result = await registry.register('ou_expert_1', 'Expert One');

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(false);
      // Should not call writeFile since name is same
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('addSkill', () => {
    it('should add a new skill to expert', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      mockWriteFile.mockResolvedValue(undefined);

      await registry.load();
      const result = await registry.addSkill('ou_expert_1', {
        name: 'Vue',
        level: 3,
        tags: ['frontend'],
      });

      expect(result.success).toBe(true);
      expect(result.isUpdate).toBe(false);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should update existing skill', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      mockWriteFile.mockResolvedValue(undefined);

      await registry.load();
      const result = await registry.addSkill('ou_expert_1', {
        name: 'React',
        level: 5,
      });

      expect(result.success).toBe(true);
      expect(result.isUpdate).toBe(true);
    });

    it('should fail if expert not registered', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      await registry.load();
      const result = await registry.addSkill('ou_unknown', {
        name: 'React',
        level: 3,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('还未注册');
    });

    it('should fail if level is invalid', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      await registry.load();
      const result = await registry.addSkill('ou_expert_1', {
        name: 'React',
        level: 6,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('1-5');
    });
  });

  describe('removeSkill', () => {
    it('should remove skill from expert', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      mockWriteFile.mockResolvedValue(undefined);

      await registry.load();
      const result = await registry.removeSkill('ou_expert_1', 'React');

      expect(result.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should fail if skill not found', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      await registry.load();
      const result = await registry.removeSkill('ou_expert_1', 'NonExistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到');
    });

    it('should fail if expert not registered', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      await registry.load();
      const result = await registry.removeSkill('ou_unknown', 'React');

      expect(result.success).toBe(false);
      expect(result.error).toContain('还未注册');
    });
  });

  describe('setAvailability', () => {
    it('should set availability for expert', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);
      const mockWriteFile = vi.mocked(fs.writeFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');
      mockWriteFile.mockResolvedValue(undefined);

      await registry.load();
      const result = await registry.setAvailability('ou_expert_1', {
        schedule: 'weekdays 10:00-18:00',
        timezone: 'Asia/Shanghai',
      });

      expect(result.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should fail if expert not registered', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      await registry.load();
      const result = await registry.setAvailability('ou_unknown', {
        schedule: 'weekdays',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('还未注册');
    });
  });

  describe('getProfile', () => {
    it('should return expert profile', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      await registry.load();
      const profile = await registry.getProfile('ou_expert_1');

      expect(profile).toBeDefined();
      expect(profile?.name).toBe('Expert One');
    });

    it('should return undefined for unregistered user', async () => {
      const mockAccess = vi.mocked(fs.access);
      const mockReadFile = vi.mocked(fs.readFile);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('experts:\n  - open_id: "ou_expert_1"');

      await registry.load();
      const profile = await registry.getProfile('ou_unknown');

      expect(profile).toBeUndefined();
    });
  });
});
