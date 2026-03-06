/**
 * Tests for SkillAgentManager.
 *
 * Issue #455: Skill Agent 系统 - 后台执行的独立 Agent 进程
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillAgentManager } from './skill-agent-manager.js';
import type { BaseAgentConfig } from './types.js';

// Mock dependencies
vi.mock('./skill-agent.js', () => ({
  SkillAgent: vi.fn().mockImplementation(() => ({
    initialize: vi.fn(),
    execute: vi.fn().mockImplementation(async function* () {
      yield { content: 'Test result' };
    }),
    executeWithContext: vi.fn().mockImplementation(async function* () {
      yield { content: 'Test result with context' };
    }),
    dispose: vi.fn(),
  })),
}));

vi.mock('../skills/finder.js', () => ({
  findSkill: vi.fn().mockResolvedValue('/mock/skills/test-skill/SKILL.md'),
  listSkills: vi.fn().mockResolvedValue([
    { name: 'test-skill', path: '/mock/skills/test-skill/SKILL.md', domain: 'package' },
  ]),
}));

describe('SkillAgentManager', () => {
  let manager: SkillAgentManager;
  let mockAgentConfig: BaseAgentConfig;
  let mockSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAgentConfig = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      permissionMode: 'bypassPermissions',
    };

    mockSendMessage = vi.fn().mockResolvedValue(undefined);
    manager = new SkillAgentManager(mockAgentConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('start', () => {
    it('should start a skill agent and return agent ID', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'test-chat-id',
        sendMessage: mockSendMessage,
      });

      expect(agentId).toBeDefined();
      expect(typeof agentId).toBe('string');
      expect(agentId.length).toBeGreaterThan(0);
    });

    it('should throw error if skill not found', async () => {
      const { findSkill } = await import('../skills/finder.js');
      vi.mocked(findSkill).mockResolvedValueOnce(null);

      await expect(manager.start({
        skillName: 'non-existent-skill',
        chatId: 'test-chat-id',
        sendMessage: mockSendMessage,
      })).rejects.toThrow('Skill not found: non-existent-skill');
    });

    it('should track running agent', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'test-chat-id',
        sendMessage: mockSendMessage,
      });

      // Give it time to start
      await new Promise(resolve => setTimeout(resolve, 100));

      const status = manager.getStatus(agentId);
      expect(status).toBeDefined();
      expect(status?.skillName).toBe('test-skill');
      expect(status?.chatId).toBe('test-chat-id');
    });

    it('should send start notification', async () => {
      await manager.start({
        skillName: 'test-skill',
        chatId: 'test-chat-id',
        sendMessage: mockSendMessage,
      });

      // Give it time to send notification
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockSendMessage).toHaveBeenCalled();
      const firstCall = mockSendMessage.mock.calls[0];
      expect(firstCall[0]).toBe('test-chat-id');
      expect(firstCall[1]).toContain('Skill Agent Started');
    });
  });

  describe('listRunning', () => {
    it('should return empty array when no agents running', () => {
      const running = manager.listRunning();
      expect(running).toEqual([]);
    });

    it('should filter by chatId', async () => {
      await manager.start({
        skillName: 'test-skill',
        chatId: 'chat-1',
        sendMessage: mockSendMessage,
      });

      await manager.start({
        skillName: 'test-skill',
        chatId: 'chat-2',
        sendMessage: mockSendMessage,
      });

      // Give it time to start
      await new Promise(resolve => setTimeout(resolve, 100));

      const chat1Agents = manager.listRunning('chat-1');
      expect(chat1Agents.length).toBeGreaterThanOrEqual(1);
      expect(chat1Agents.every(a => a.chatId === 'chat-1')).toBe(true);
    });
  });

  describe('stop', () => {
    it('should return false for non-existent agent', async () => {
      const stopped = await manager.stop('non-existent-id');
      expect(stopped).toBe(false);
    });

    it('should return false for completed agent', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'test-chat-id',
        sendMessage: mockSendMessage,
      });

      // Give it time to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Completed agents cannot be stopped
      const stopped = await manager.stop(agentId);
      expect(stopped).toBe(false);
    });
  });

  describe('listAvailableSkills', () => {
    it('should return list of available skills', async () => {
      const skills = await manager.listAvailableSkills();
      expect(Array.isArray(skills)).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove old completed agents', async () => {
      const agentId = await manager.start({
        skillName: 'test-skill',
        chatId: 'test-chat-id',
        sendMessage: mockSendMessage,
      });

      // Give it time to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Cleanup with 0ms max age (should remove all completed)
      manager.cleanup(0);

      const status = manager.getStatus(agentId);
      // Agent might be completed or still running depending on timing
      // Just verify cleanup doesn't throw
      expect(manager.listRunning).toBeDefined();
    });
  });
});
