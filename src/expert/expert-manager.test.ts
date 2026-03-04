/**
 * Expert Manager Tests.
 *
 * Issue #535: 人类专家注册与技能声明
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ExpertManager, resetExpertManager } from './expert-manager.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
  },
}));

describe('ExpertManager', () => {
  let manager: ExpertManager;
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expert-test-'));
    vi.mocked(await import('../config/index.js')).Config.getWorkspaceDir = vi.fn(() => tempDir);
    resetExpertManager();
    manager = new ExpertManager(tempDir);
  });

  afterEach(async () => {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  describe('registerExpert', () => {
    it('should register a new expert', async () => {
      const expert = await manager.registerExpert('ou_user_123', '张三');

      expect(expert.open_id).toBe('ou_user_123');
      expect(expert.name).toBe('张三');
      expect(expert.skills).toEqual([]);
      expect(expert.createdAt).toBeDefined();
      expect(expert.updatedAt).toBeDefined();
    });

    it('should register expert without name', async () => {
      const expert = await manager.registerExpert('ou_user_456');

      expect(expert.open_id).toBe('ou_user_456');
      expect(expert.name).toBeUndefined();
    });

    it('should update existing expert name', async () => {
      await manager.registerExpert('ou_user_123', '旧名字');
      const expert = await manager.registerExpert('ou_user_123', '新名字');

      expect(expert.name).toBe('新名字');
    });
  });

  describe('getExpert', () => {
    it('should return undefined for non-existent expert', async () => {
      const expert = await manager.getExpert('ou_nonexistent');
      expect(expert).toBeUndefined();
    });

    it('should return expert by open_id', async () => {
      await manager.registerExpert('ou_user_123', '张三');
      const expert = await manager.getExpert('ou_user_123');

      expect(expert).toBeDefined();
      expect(expert?.open_id).toBe('ou_user_123');
      expect(expert?.name).toBe('张三');
    });
  });

  describe('listExperts', () => {
    it('should return empty array when no experts', async () => {
      const experts = await manager.listExperts();
      expect(experts).toEqual([]);
    });

    it('should return all experts', async () => {
      await manager.registerExpert('ou_user_1', '专家1');
      await manager.registerExpert('ou_user_2', '专家2');

      const experts = await manager.listExperts();
      expect(experts).toHaveLength(2);
      expect(experts.map(e => e.open_id).sort()).toEqual(['ou_user_1', 'ou_user_2']);
    });
  });

  describe('addSkill', () => {
    it('should add skill to expert', async () => {
      await manager.registerExpert('ou_user_123');
      const expert = await manager.addSkill('ou_user_123', 'React', 4, ['frontend']);

      expect(expert?.skills).toHaveLength(1);
      expect(expert?.skills[0].name).toBe('React');
      expect(expert?.skills[0].level).toBe(4);
      expect(expert?.skills[0].tags).toEqual(['frontend']);
    });

    it('should add multiple skills', async () => {
      await manager.registerExpert('ou_user_123');
      await manager.addSkill('ou_user_123', 'React', 4);
      const expert = await manager.addSkill('ou_user_123', 'TypeScript', 5);

      expect(expert?.skills).toHaveLength(2);
    });

    it('should update existing skill', async () => {
      await manager.registerExpert('ou_user_123');
      await manager.addSkill('ou_user_123', 'React', 3);
      const expert = await manager.addSkill('ou_user_123', 'React', 5);

      expect(expert?.skills).toHaveLength(1);
      expect(expert?.skills[0].level).toBe(5);
    });

    it('should return undefined for non-existent expert', async () => {
      const expert = await manager.addSkill('ou_nonexistent', 'React', 4);
      expect(expert).toBeUndefined();
    });

    it('should match skill name case-insensitively', async () => {
      await manager.registerExpert('ou_user_123');
      await manager.addSkill('ou_user_123', 'React', 3);
      const expert = await manager.addSkill('ou_user_123', 'REACT', 5);

      expect(expert?.skills).toHaveLength(1);
      expect(expert?.skills[0].name).toBe('REACT');
      expect(expert?.skills[0].level).toBe(5);
    });
  });

  describe('removeSkill', () => {
    it('should remove skill from expert', async () => {
      await manager.registerExpert('ou_user_123');
      await manager.addSkill('ou_user_123', 'React', 4);
      const expert = await manager.removeSkill('ou_user_123', 'React');

      expect(expert?.skills).toHaveLength(0);
    });

    it('should match skill name case-insensitively', async () => {
      await manager.registerExpert('ou_user_123');
      await manager.addSkill('ou_user_123', 'React', 4);
      const expert = await manager.removeSkill('ou_user_123', 'REACT');

      expect(expert?.skills).toHaveLength(0);
    });

    it('should return expert even if skill not found', async () => {
      await manager.registerExpert('ou_user_123');
      await manager.addSkill('ou_user_123', 'React', 4);
      const expert = await manager.removeSkill('ou_user_123', 'Vue');

      // Expert still exists, just skill not removed
      expect(expert).toBeDefined();
      expect(expert?.skills).toHaveLength(1);
    });

    it('should return undefined for non-existent expert', async () => {
      const expert = await manager.removeSkill('ou_nonexistent', 'React');
      expect(expert).toBeUndefined();
    });
  });

  describe('setAvailability', () => {
    it('should set availability for expert', async () => {
      await manager.registerExpert('ou_user_123');
      const expert = await manager.setAvailability('ou_user_123', {
        schedule: 'weekdays 10:00-18:00',
        timezone: 'Asia/Shanghai',
      });

      expect(expert?.availability).toBeDefined();
      expect(expert?.availability?.schedule).toBe('weekdays 10:00-18:00');
      expect(expert?.availability?.timezone).toBe('Asia/Shanghai');
    });

    it('should return undefined for non-existent expert', async () => {
      const expert = await manager.setAvailability('ou_nonexistent', {
        schedule: 'weekdays 10:00-18:00',
      });
      expect(expert).toBeUndefined();
    });
  });

  describe('unregisterExpert', () => {
    it('should unregister expert', async () => {
      await manager.registerExpert('ou_user_123');
      const result = await manager.unregisterExpert('ou_user_123');

      expect(result).toBe(true);
      const expert = await manager.getExpert('ou_user_123');
      expect(expert).toBeUndefined();
    });

    it('should return false for non-existent expert', async () => {
      const result = await manager.unregisterExpert('ou_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should persist data across manager instances', async () => {
      await manager.registerExpert('ou_user_123', '张三');
      await manager.addSkill('ou_user_123', 'React', 4);

      // Create new manager instance
      resetExpertManager();
      const newManager = new ExpertManager(tempDir);
      const expert = await newManager.getExpert('ou_user_123');

      expect(expert).toBeDefined();
      expect(expert?.name).toBe('张三');
      expect(expert?.skills).toHaveLength(1);
      expect(expert?.skills[0].name).toBe('React');
    });
  });
});
