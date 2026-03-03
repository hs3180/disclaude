/**
 * Tests for SkillAgentManager.
 *
 * Issue #455: Skill Agent system
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkillAgentManager } from './skill-agent-manager.js';

// Mock the skills finder module
vi.mock('../skills/index.js', () => ({
  findSkill: vi.fn(async (name: string) => {
    if (name === 'test-skill') {
      return '/path/to/skills/test-skill/SKILL.md';
    }
    return null;
  }),
  listSkills: vi.fn(async () => [
    { name: 'test-skill', path: '/path/to/skills/test-skill/SKILL.md', domain: 'package' },
    { name: 'evaluator', path: '/path/to/skills/evaluator/SKILL.md', domain: 'package' },
  ]),
}));

// Mock the AgentFactory
vi.mock('../agents/index.js', () => ({
  AgentFactory: {
    createSkillAgent: vi.fn(async (name: string) => ({
      execute: vi.fn(async function* () {
        yield { type: 'text', content: `Executed skill: ${name}` };
      }),
      executeWithContext: vi.fn(async function* () {
        yield { type: 'text', content: `Executed skill with context: ${name}` };
      }),
    })),
  },
}));

describe('SkillAgentManager', () => {
  let manager: SkillAgentManager;
  let mockCallbacks: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendCard: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCallbacks = {
      sendMessage: vi.fn(async () => {}),
      sendCard: vi.fn(async () => {}),
    };

    manager = new SkillAgentManager({
      callbacks: mockCallbacks,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('listAvailableSkills', () => {
    it('should list all available skills', async () => {
      const skills = await manager.listAvailableSkills();

      expect(skills).toHaveLength(2);
      expect(skills[0].name).toBe('test-skill');
      expect(skills[1].name).toBe('evaluator');
    });
  });

  describe('skillExists', () => {
    it('should return true for existing skill', async () => {
      const exists = await manager.skillExists('test-skill');
      expect(exists).toBe(true);
    });

    it('should return false for non-existing skill', async () => {
      const exists = await manager.skillExists('non-existing-skill');
      expect(exists).toBe(false);
    });
  });

  describe('start', () => {
    it('should start a skill agent and return ID', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'oc_test',
      });

      expect(agentId).toMatch(/^skill-test-skill-/);
    });

    it('should throw error for non-existing skill', async () => {
      await expect(
        manager.start({
          skillName: 'non-existing-skill',
          chatId: 'oc_test',
        })
      ).rejects.toThrow('Skill not found: non-existing-skill');
    });

    it('should track running agent', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'oc_test',
      });

      const agents = manager.list();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(agentId);
      expect(agents[0].skillName).toBe('test-skill');
      expect(agents[0].chatId).toBe('oc_test');
      expect(agents[0].status).toBe('running');
    });

    it('should filter agents by chatId', async () => {
      await manager.start({
        skillName: 'test-skill',
        chatId: 'oc_chat1',
      });

      await manager.start({
        skillName: 'test-skill',
        chatId: 'oc_chat2',
      });

      const chat1Agents = manager.list('oc_chat1');
      expect(chat1Agents).toHaveLength(1);
      expect(chat1Agents[0].chatId).toBe('oc_chat1');

      const chat2Agents = manager.list('oc_chat2');
      expect(chat2Agents).toHaveLength(1);
      expect(chat2Agents[0].chatId).toBe('oc_chat2');
    });
  });

  describe('getStatus', () => {
    it('should return agent status', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'oc_test',
      });

      const status = manager.getStatus(agentId);
      expect(status).toBeDefined();
      expect(status?.id).toBe(agentId);
      expect(status?.skillName).toBe('test-skill');
      expect(status?.status).toBe('running');
    });

    it('should return undefined for non-existing agent', () => {
      const status = manager.getStatus('non-existing-id');
      expect(status).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('should stop a running agent', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'oc_test',
      });

      const stopped = await manager.stop(agentId);
      expect(stopped).toBe(true);
    });

    it('should return false for non-existing agent', async () => {
      const stopped = await manager.stop('non-existing-id');
      expect(stopped).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should remove old completed agents', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'oc_test',
      });

      // Manually set agent as completed with old timestamp
      const agent = manager.getStatus(agentId);
      if (agent) {
        agent.status = 'completed';
        agent.completedAt = new Date(Date.now() - 7200000); // 2 hours ago
      }

      manager.cleanup(3600000); // 1 hour max age

      const status = manager.getStatus(agentId);
      expect(status).toBeUndefined();
    });
  });
});
