/**
 * Tests for SkillAgentManager.
 *
 * Issue #455: Skill Agent System - Background execution of independent Agent processes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SkillAgentManager,
  getSkillAgentManager,
  resetSkillAgentManager,
  type SkillAgentManagerConfig,
} from './skill-agent-manager.js';
import type { BaseAgentConfig } from './types.js';

// Mock the skills/finder module
vi.mock('../skills/finder.js', () => ({
  listSkills: vi.fn(),
  findSkill: vi.fn(),
}));

// Mock the skill-agent module
vi.mock('./skill-agent.js', () => ({
  SkillAgent: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockImplementation(async function* () {
      yield { content: 'Test result' };
    }),
    executeWithContext: vi.fn().mockImplementation(async function* () {
      yield { content: 'Test result' };
    }),
    dispose: vi.fn(),
  })),
}));

import { listSkills, findSkill } from '../skills/finder.js';

const mockListSkills = vi.mocked(listSkills);
const mockFindSkill = vi.mocked(findSkill);

describe('SkillAgentManager', () => {
  let manager: SkillAgentManager;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  const baseConfig: BaseAgentConfig = {
    apiKey: 'test-api-key',
    model: 'claude-3-5-sonnet-20241022',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSkillAgentManager();

    sendMessageMock = vi.fn().mockResolvedValue(undefined);

    const config: SkillAgentManagerConfig = {
      baseAgentConfig: baseConfig,
      sendMessage: sendMessageMock,
      maxConcurrent: 3,
    };

    manager = new SkillAgentManager(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('discoverSkills', () => {
    it('should return skills from finder', async () => {
      const mockSkills = [
        { name: 'evaluator', path: '/skills/evaluator/SKILL.md', domain: 'package' as const },
        { name: 'executor', path: '/skills/executor/SKILL.md', domain: 'package' as const },
      ];
      mockListSkills.mockResolvedValueOnce(mockSkills);

      const skills = await manager.discoverSkills();

      expect(skills).toEqual(mockSkills);
      expect(mockListSkills).toHaveBeenCalledTimes(1);
    });

    it('should cache skills', async () => {
      const mockSkills = [
        { name: 'evaluator', path: '/skills/evaluator/SKILL.md', domain: 'package' as const },
      ];
      mockListSkills.mockResolvedValueOnce(mockSkills);

      // First call
      await manager.discoverSkills();
      // Second call (should use cache)
      await manager.discoverSkills();

      expect(mockListSkills).toHaveBeenCalledTimes(1);
    });

    it('should force refresh when requested', async () => {
      const mockSkills = [
        { name: 'evaluator', path: '/skills/evaluator/SKILL.md', domain: 'package' as const },
      ];
      mockListSkills.mockResolvedValue(mockSkills);

      // First call
      await manager.discoverSkills();
      // Force refresh
      await manager.discoverSkills(true);

      expect(mockListSkills).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSkill', () => {
    it('should return skill path if found', async () => {
      mockFindSkill.mockResolvedValueOnce('/skills/test/SKILL.md');

      const path = await manager.getSkill('test');

      expect(path).toBe('/skills/test/SKILL.md');
    });

    it('should return null if skill not found', async () => {
      mockFindSkill.mockResolvedValueOnce(null);

      const path = await manager.getSkill('nonexistent');

      expect(path).toBeNull();
    });
  });

  describe('startAgent', () => {
    it('should start an agent successfully', async () => {
      mockFindSkill.mockResolvedValueOnce('/skills/test/SKILL.md');

      const agentId = await manager.startAgent({
        skillName: 'test',
        chatId: 'oc_test',
      });

      expect(agentId).toBeDefined();
      expect(typeof agentId).toBe('string');

      const info = manager.getAgentInfo(agentId);
      expect(info).toBeDefined();
      expect(info?.skillName).toBe('test');
      expect(info?.chatId).toBe('oc_test');
    });

    it('should throw if skill not found', async () => {
      mockFindSkill.mockResolvedValueOnce(null);

      await expect(
        manager.startAgent({
          skillName: 'nonexistent',
          chatId: 'oc_test',
        })
      ).rejects.toThrow('Skill not found: nonexistent');
    });

    it('should throw if max concurrent reached', async () => {
      mockFindSkill.mockResolvedValue('/skills/test/SKILL.md');

      // Start max agents
      await manager.startAgent({ skillName: 'test1', chatId: 'oc_test' });
      await manager.startAgent({ skillName: 'test2', chatId: 'oc_test' });
      await manager.startAgent({ skillName: 'test3', chatId: 'oc_test' });

      // Should throw on 4th
      await expect(
        manager.startAgent({ skillName: 'test4', chatId: 'oc_test' })
      ).rejects.toThrow('Maximum concurrent agents reached');
    });
  });

  describe('stopAgent', () => {
    it('should stop a running agent', async () => {
      mockFindSkill.mockResolvedValueOnce('/skills/test/SKILL.md');

      const agentId = await manager.startAgent({
        skillName: 'test',
        chatId: 'oc_test',
      });

      const stopped = await manager.stopAgent(agentId);
      expect(stopped).toBe(true);
    });

    it('should return false if agent not found', async () => {
      const stopped = await manager.stopAgent('nonexistent');
      expect(stopped).toBe(false);
    });
  });

  describe('getAgentInfo', () => {
    it('should return agent info', async () => {
      mockFindSkill.mockResolvedValueOnce('/skills/test/SKILL.md');

      const agentId = await manager.startAgent({
        skillName: 'test',
        chatId: 'oc_test',
      });

      const info = manager.getAgentInfo(agentId);

      expect(info).toBeDefined();
      expect(info?.id).toBe(agentId);
      expect(info?.skillName).toBe('test');
      expect(info?.status).toBeDefined();
    });

    it('should return undefined for unknown agent', () => {
      const info = manager.getAgentInfo('unknown');
      expect(info).toBeUndefined();
    });
  });

  describe('listRunningAgents', () => {
    it('should list all running agents', async () => {
      mockFindSkill.mockResolvedValue('/skills/test/SKILL.md');

      await manager.startAgent({ skillName: 'test1', chatId: 'oc_test' });
      await manager.startAgent({ skillName: 'test2', chatId: 'oc_test' });

      const agents = manager.listRunningAgents();

      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.skillName)).toContain('test1');
      expect(agents.map((a) => a.skillName)).toContain('test2');
    });

    it('should return empty array if no agents', () => {
      const agents = manager.listRunningAgents();
      expect(agents).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should return correct stats', async () => {
      mockFindSkill.mockResolvedValue('/skills/test/SKILL.md');

      await manager.startAgent({ skillName: 'test1', chatId: 'oc_test' });
      await manager.startAgent({ skillName: 'test2', chatId: 'oc_test' });

      const stats = manager.getStats();

      expect(stats.total).toBe(2);
      expect(stats.maxConcurrent).toBe(3);
    });
  });

  describe('cleanupOldAgents', () => {
    it('should remove old completed agents', async () => {
      mockFindSkill.mockResolvedValue('/skills/test/SKILL.md');

      // Start and complete an agent
      const agentId = await manager.startAgent({
        skillName: 'test',
        chatId: 'oc_test',
      });

      // Manually set agent as completed with old timestamp
      const info = manager.getAgentInfo(agentId);
      if (info) {
        info.status = 'completed';
        info.completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      }

      // Cleanup agents older than 1 hour
      const cleaned = manager.cleanupOldAgents(60 * 60 * 1000);

      expect(cleaned).toBe(1);
      expect(manager.listRunningAgents()).toHaveLength(0);
    });
  });
});

describe('Singleton functions', () => {
  beforeEach(() => {
    resetSkillAgentManager();
  });

  afterEach(() => {
    resetSkillAgentManager();
  });

  it('should throw if getSkillAgentManager called without config', () => {
    // Reset the singleton to null state
    resetSkillAgentManager();
    // Import fresh module to get uninitialized state
    expect(() => {
      getSkillAgentManager(); // Should throw since we just reset
    }).toThrow('SkillAgentManager not initialized');
  });
});
