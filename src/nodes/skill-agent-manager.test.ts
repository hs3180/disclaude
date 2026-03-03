/**
 * Tests for SkillAgentManager.
 *
 * Issue #455: Skill Agent system
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkillAgentManager } from './skill-agent-manager.js';
import type { SkillAgent } from '../agents/types.js';

// Mock dependencies
vi.mock('../agents/index.js', () => ({
  AgentFactory: {
    createSkillAgent: vi.fn(),
  },
}));

vi.mock('../skills/index.js', () => ({
  findSkill: vi.fn(),
  listSkills: vi.fn(),
}));

import { AgentFactory } from '../agents/index.js';
import { findSkill, listSkills } from '../skills/index.js';

/**
 * Create a mock SkillAgent for testing.
 */
function createMockSkillAgent(): SkillAgent {
  return {
    type: 'skill' as const,
    name: 'test-skill',
    execute: vi.fn().mockImplementation(async function* () {
      yield { content: 'Test result' };
    }),
    dispose: vi.fn(),
  };
}

describe('SkillAgentManager', () => {
  let manager: SkillAgentManager;
  let mockCallbacks: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendCard: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
    };

    manager = new SkillAgentManager({
      callbacks: mockCallbacks,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('listAvailableSkills', () => {
    it('should return list of skills', async () => {
      const mockSkills = [
        { name: 'test-skill', path: '/skills/test-skill/SKILL.md', domain: 'workspace' as const },
      ];
      vi.mocked(listSkills).mockResolvedValue(mockSkills);

      const result = await manager.listAvailableSkills();

      expect(result).toEqual(mockSkills);
    });
  });

  describe('skillExists', () => {
    it('should return true if skill exists', async () => {
      vi.mocked(findSkill).mockResolvedValue('/skills/test/SKILL.md');

      const result = await manager.skillExists('test');

      expect(result).toBe(true);
    });

    it('should return false if skill does not exist', async () => {
      vi.mocked(findSkill).mockResolvedValue(null);

      const result = await manager.skillExists('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('start', () => {
    it('should throw error if skill not found', async () => {
      vi.mocked(findSkill).mockResolvedValue(null);

      await expect(manager.start({
        skillName: 'nonexistent',
        chatId: 'test-chat',
      })).rejects.toThrow('Skill not found: nonexistent');
    });

    it('should start skill agent and return agent ID', async () => {
      vi.mocked(findSkill).mockResolvedValue('/skills/test/SKILL.md');
      vi.mocked(AgentFactory.createSkillAgent).mockResolvedValue(createMockSkillAgent());

      const agentId = await manager.start({
        skillName: 'test',
        chatId: 'test-chat',
        input: 'test input',
      });

      expect(agentId).toMatch(/^skill-test-/);
      expect(findSkill).toHaveBeenCalledWith('test');
    });
  });

  describe('list', () => {
    it('should return empty array if no agents running', () => {
      const result = manager.list();

      expect(result).toEqual([]);
    });

    it('should return running agents', async () => {
      vi.mocked(findSkill).mockResolvedValue('/skills/test/SKILL.md');

      const mockAgent = createMockSkillAgent();
      mockAgent.execute = vi.fn().mockImplementation(async function* () {
        // Keep running
        await new Promise(() => {});
      });
      vi.mocked(AgentFactory.createSkillAgent).mockResolvedValue(mockAgent);

      await manager.start({
        skillName: 'test',
        chatId: 'test-chat',
      });

      const agents = manager.list();

      expect(agents).toHaveLength(1);
      expect(agents[0].skillName).toBe('test');
      expect(agents[0].chatId).toBe('test-chat');
      expect(agents[0].status).toBe('running');
    });

    it('should filter by chatId', async () => {
      vi.mocked(findSkill).mockResolvedValue('/skills/test/SKILL.md');

      const mockAgent = createMockSkillAgent();
      mockAgent.execute = vi.fn().mockImplementation(async function* () {
        await new Promise(() => {});
      });
      vi.mocked(AgentFactory.createSkillAgent).mockResolvedValue(mockAgent);

      await manager.start({
        skillName: 'test',
        chatId: 'chat-1',
      });

      await manager.start({
        skillName: 'test',
        chatId: 'chat-2',
      });

      const agents = manager.list('chat-1');

      expect(agents).toHaveLength(1);
      expect(agents[0].chatId).toBe('chat-1');
    });
  });

  describe('stop', () => {
    it('should return false if agent not found', async () => {
      const result = await manager.stop('nonexistent');

      expect(result).toBe(false);
    });

    it('should stop running agent', async () => {
      vi.mocked(findSkill).mockResolvedValue('/skills/test/SKILL.md');

      const mockAgent = createMockSkillAgent();
      mockAgent.execute = vi.fn().mockImplementation(async function* () {
        // Keep running
        await new Promise(() => {});
      });
      vi.mocked(AgentFactory.createSkillAgent).mockResolvedValue(mockAgent);

      const agentId = await manager.start({
        skillName: 'test',
        chatId: 'test-chat',
      });

      const result = await manager.stop(agentId);

      expect(result).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return undefined if agent not found', () => {
      const result = manager.getStatus('nonexistent');

      expect(result).toBeUndefined();
    });

    it('should return agent status', async () => {
      vi.mocked(findSkill).mockResolvedValue('/skills/test/SKILL.md');

      const mockAgent = createMockSkillAgent();
      mockAgent.execute = vi.fn().mockImplementation(async function* () {
        await new Promise(() => {});
      });
      vi.mocked(AgentFactory.createSkillAgent).mockResolvedValue(mockAgent);

      const agentId = await manager.start({
        skillName: 'test',
        chatId: 'test-chat',
      });

      const status = manager.getStatus(agentId);

      expect(status).toBeDefined();
      expect(status?.skillName).toBe('test');
      expect(status?.status).toBe('running');
    });
  });

  describe('cleanup', () => {
    it('should remove old completed agents', async () => {
      vi.mocked(findSkill).mockResolvedValue('/skills/test/SKILL.md');
      vi.mocked(AgentFactory.createSkillAgent).mockResolvedValue(createMockSkillAgent());

      const agentId = await manager.start({
        skillName: 'test',
        chatId: 'test-chat',
      });

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 100));

      // Cleanup with very short max age
      manager.cleanup(1);

      // Wait a bit for cleanup to process
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = manager.getStatus(agentId);

      // Agent should be cleaned up
      expect(status).toBeUndefined();
    });
  });
});
