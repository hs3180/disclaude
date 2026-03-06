/**
 * Tests for SkillCommand.
 *
 * Issue #455: Skill Agent System - Background execution of independent Agent processes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillCommand } from './skill-command.js';
import type { CommandContext, CommandServices } from '../types.js';

describe('SkillCommand', () => {
  let command: SkillCommand;
  let mockServices: CommandServices;
  let mockContext: CommandContext;

  beforeEach(() => {
    command = new SkillCommand();

    mockServices = {
      isRunning: vi.fn(() => true),
      getLocalNodeId: vi.fn(() => 'node-1'),
      getExecNodes: vi.fn(() => []),
      getChatNodeAssignment: vi.fn(),
      switchChatNode: vi.fn(),
      getNode: vi.fn(),
      sendCommand: vi.fn(),
      getFeishuClient: vi.fn(),
      createDiscussionChat: vi.fn(),
      createGroup: vi.fn(),
      addMembers: vi.fn(),
      removeMembers: vi.fn(),
      getMembers: vi.fn(),
      dissolveChat: vi.fn(),
      registerGroup: vi.fn(),
      unregisterGroup: vi.fn(),
      listGroups: vi.fn(() => []),
      getBotChats: vi.fn(),
      setDebugGroup: vi.fn(),
      getDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn(),
      getChannelStatus: vi.fn(() => 'OK'),
      listSchedules: vi.fn(),
      getSchedule: vi.fn(),
      enableSchedule: vi.fn(),
      disableSchedule: vi.fn(),
      runSchedule: vi.fn(),
      isScheduleRunning: vi.fn(),
      startTask: vi.fn(),
      getCurrentTask: vi.fn(),
      updateTaskProgress: vi.fn(),
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      cancelTask: vi.fn(),
      completeTask: vi.fn(),
      setTaskError: vi.fn(),
      listTaskHistory: vi.fn(),
      setPassiveMode: vi.fn(),
      getPassiveMode: vi.fn(),
      markAsTopicGroup: vi.fn(),
      isTopicGroup: vi.fn(),
      listTopicGroups: vi.fn(),
      // Skill Agent methods
      listSkills: vi.fn(),
      startSkillAgent: vi.fn(),
      stopSkillAgent: vi.fn(),
      getSkillAgentInfo: vi.fn(),
      listSkillAgents: vi.fn(),
    };

    mockContext = {
      chatId: 'oc_test',
      args: [],
      rawText: '/skill',
      services: mockServices,
    };
  });

  describe('metadata', () => {
    it('should have correct name and category', () => {
      expect(command.name).toBe('skill');
      expect(command.category).toBe('skill');
      expect(command.description).toContain('Skill Agents');
    });
  });

  describe('execute', () => {
    it('should return error if no subcommand', async () => {
      mockContext.args = [];

      const result = await command.execute(mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定子命令');
    });

    it('should return error for unknown subcommand', async () => {
      mockContext.args = ['unknown'];

      const result = await command.execute(mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('未知子命令');
    });
  });

  describe('list', () => {
    it('should list available skills', async () => {
      mockContext.args = ['list'];
      vi.mocked(mockServices.listSkills!).mockResolvedValueOnce([
        { name: 'evaluator', path: '/skills/evaluator/SKILL.md', domain: 'package' },
        { name: 'executor', path: '/skills/executor/SKILL.md', domain: 'package' },
      ]);
      vi.mocked(mockServices.listSkillAgents!).mockReturnValue([]);

      const result = await command.execute(mockContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('evaluator');
      expect(result.message).toContain('executor');
    });

    it('should show running agents', async () => {
      mockContext.args = ['list'];
      vi.mocked(mockServices.listSkills!).mockResolvedValueOnce([]);
      vi.mocked(mockServices.listSkillAgents!).mockReturnValue([
        {
          id: 'test-agent-id',
          skillName: 'test-skill',
          status: 'running',
          chatId: 'oc_test',
          startedAt: new Date(),
          abortController: new AbortController(),
        },
      ]);

      const result = await command.execute(mockContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('test-skill');
      expect(result.message).toContain('running');
    });
  });

  describe('run', () => {
    it('should return error if no skill name', async () => {
      mockContext.args = ['run'];

      const result = await command.execute(mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定要运行的技能名称');
    });

    it('should start skill agent', async () => {
      mockContext.args = ['run', 'test-skill', 'some', 'input'];
      vi.mocked(mockServices.startSkillAgent!).mockResolvedValueOnce('new-agent-id');

      const result = await command.execute(mockContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Skill Agent 已启动');
      expect(result.message).toContain('test-skill');
      expect(mockServices.startSkillAgent).toHaveBeenCalledWith({
        skillName: 'test-skill',
        chatId: 'oc_test',
        input: 'some input',
      });
    });

    it('should handle start failure', async () => {
      mockContext.args = ['run', 'test-skill'];
      vi.mocked(mockServices.startSkillAgent!).mockRejectedValueOnce(
        new Error('Skill not found')
      );

      const result = await command.execute(mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Skill not found');
    });
  });

  describe('stop', () => {
    it('should return error if no agent id', async () => {
      mockContext.args = ['stop'];

      const result = await command.execute(mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定要停止的 Agent ID');
    });

    it('should stop agent', async () => {
      mockContext.args = ['stop', 'test-agent-id'];
      vi.mocked(mockServices.stopSkillAgent!).mockResolvedValueOnce(true);

      const result = await command.execute(mockContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('已停止');
    });

    it('should handle stop failure', async () => {
      mockContext.args = ['stop', 'nonexistent-id'];
      vi.mocked(mockServices.stopSkillAgent!).mockResolvedValueOnce(false);

      const result = await command.execute(mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('无法停止 Agent');
    });
  });

  describe('status', () => {
    it('should show all running agents if no id', async () => {
      mockContext.args = ['status'];
      vi.mocked(mockServices.listSkillAgents!).mockReturnValue([
        {
          id: 'agent-1',
          skillName: 'skill-1',
          status: 'running',
          chatId: 'oc_test',
          startedAt: new Date(),
          abortController: new AbortController(),
        },
      ]);

      const result = await command.execute(mockContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('skill-1');
    });

    it('should show specific agent status', async () => {
      mockContext.args = ['status', 'agent-1'];
      vi.mocked(mockServices.getSkillAgentInfo!).mockReturnValue({
        id: 'agent-1',
        skillName: 'test-skill',
        status: 'running',
        chatId: 'oc_test',
        startedAt: new Date(),
        abortController: new AbortController(),
      });

      const result = await command.execute(mockContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('test-skill');
      expect(result.message).toContain('running');
    });

    it('should handle agent not found', async () => {
      mockContext.args = ['status', 'nonexistent'];
      vi.mocked(mockServices.getSkillAgentInfo!).mockReturnValue(undefined);

      const result = await command.execute(mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到 Agent');
    });
  });
});
