/**
 * Tests for FeedbackCommand.
 *
 * Issue #930: /feedback command for quick issue submission
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackCommand } from './feedback-command.js';
import type { CommandContext, CommandServices } from '../types.js';

function createMockServices(): CommandServices {
  return {
    isRunning: () => true,
    getLocalNodeId: () => 'local-node',
    getExecNodes: () => [],
    getChatNodeAssignment: () => undefined,
    switchChatNode: () => false,
    getNode: () => undefined,
    sendCommand: () => Promise.resolve(),
    getFeishuClient: () => null as never,
    createDiscussionChat: () => Promise.resolve('oc_test'),
    createGroup: () => Promise.resolve({ chatId: 'oc_test', name: 'Test', createdAt: Date.now(), initialMembers: [] }),
    addMembers: () => Promise.resolve(),
    removeMembers: () => Promise.resolve(),
    getMembers: () => Promise.resolve([]),
    dissolveChat: () => Promise.resolve(),
    registerGroup: () => {},
    unregisterGroup: () => false,
    listGroups: () => [],
    getBotChats: () => Promise.resolve([]),
    setDebugGroup: () => null,
    getDebugGroup: () => null,
    clearDebugGroup: () => null,
    getChannelStatus: () => 'test: connected',
    listSchedules: () => Promise.resolve([]),
    getSchedule: () => Promise.resolve(undefined),
    enableSchedule: () => Promise.resolve(false),
    disableSchedule: () => Promise.resolve(false),
    runSchedule: () => Promise.resolve(false),
    isScheduleRunning: () => false,
    getScheduleCooldownStatus: () => Promise.resolve({
      isInCooldown: false,
      lastExecutionTime: null,
      cooldownEndsAt: null,
      remainingMs: 0,
    }),
    clearScheduleCooldown: () => Promise.resolve(true),
    startTask: () => Promise.resolve({ id: 'task_test', prompt: 'test', status: 'running', progress: 0, chatId: 'oc_test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    getCurrentTask: () => Promise.resolve(null),
    updateTaskProgress: () => Promise.resolve(),
    pauseTask: () => Promise.resolve(null),
    resumeTask: () => Promise.resolve(null),
    cancelTask: () => Promise.resolve(null),
    completeTask: () => Promise.resolve(null),
    setTaskError: () => Promise.resolve(null),
    listTaskHistory: () => Promise.resolve([]),
    setPassiveMode: () => {},
    getPassiveMode: () => true,
    markAsTopicGroup: () => false,
    isTopicGroup: () => false,
    listTopicGroups: () => [],
  };
}

function createContext(args: string[], services: CommandServices = createMockServices(), rawText?: string): CommandContext {
  return {
    chatId: 'oc_test123',
    userId: 'ou_user123',
    args,
    rawText: rawText ?? `/feedback ${args.join(' ')}`,
    services,
  };
}

describe('FeedbackCommand', () => {
  let command: FeedbackCommand;

  beforeEach(() => {
    command = new FeedbackCommand();
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(command.name).toBe('feedback');
    });

    it('should have skill category', () => {
      expect(command.category).toBe('skill');
    });

    it('should have description', () => {
      expect(command.description).toBe('提交反馈给开发者');
    });

    it('should have usage', () => {
      expect(command.usage).toBe('feedback [反馈内容]');
    });
  });

  describe('execute', () => {
    it('should return help message when no args provided', () => {
      const result = command.execute(createContext([]));

      expect(result.success).toBe(true);
      expect(result.message).toContain('提交反馈');
      expect(result.message).toContain('/feedback <问题描述>');
    });

    it('should return agent prompt when feedback content is provided', () => {
      const result = command.execute(createContext(['这个', '功能', '太难用了'], createMockServices(), '/feedback 这个功能太难用了'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('用户反馈内容');
      expect(result.message).toContain('这个功能太难用了');
      expect(result.message).toContain('gh issue create');
    });

    it('should detect sensitive user IDs', () => {
      const result = command.execute(createContext(['ou_abc123def456'], createMockServices(), '/feedback ou_abc123def456'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('User ID');
    });

    it('should detect sensitive chat IDs', () => {
      const result = command.execute(createContext(['oc_abc123def456'], createMockServices(), '/feedback oc_abc123def456'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('Chat ID');
    });

    it('should detect sensitive message IDs', () => {
      const result = command.execute(createContext(['cli-abc123def456'], createMockServices(), '/feedback cli-abc123def456'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('Message ID');
    });

    it('should detect email addresses', () => {
      const result = command.execute(createContext(['test@example.com'], createMockServices(), '/feedback test@example.com'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('Email');
    });

    it('should detect IP addresses', () => {
      const result = command.execute(createContext(['192.168.1.1'], createMockServices(), '/feedback 192.168.1.1'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('IP Address');
    });

    it('should detect tokens', () => {
      const result = command.execute(createContext(['token=secret123'], createMockServices(), '/feedback token=secret123'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('Token');
    });

    it('should detect API keys', () => {
      const result = command.execute(createContext(['api_key=mykey123'], createMockServices(), '/feedback api_key=mykey123'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('API Key');
    });

    it('should detect passwords', () => {
      const result = command.execute(createContext(['password=mypass'], createMockServices(), '/feedback password=mypass'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('Password');
    });

    it('should detect secrets', () => {
      const result = command.execute(createContext(['secret=hidden'], createMockServices(), '/feedback secret=hidden'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('检测到可能的敏感信息');
      expect(result.message).toContain('Secret');
    });

    it('should include chat ID in agent prompt', () => {
      const result = command.execute(createContext(['test feedback'], createMockServices(), '/feedback test feedback'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('oc_test123');
    });

    it('should include sanitization instructions in agent prompt', () => {
      const result = command.execute(createContext(['test feedback'], createMockServices(), '/feedback test feedback'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('脱敏处理');
    });

    it('should include gh issue create instructions in agent prompt', () => {
      const result = command.execute(createContext(['test feedback'], createMockServices(), '/feedback test feedback'));

      expect(result.success).toBe(true);
      expect(result.message).toContain('gh issue create');
      expect(result.message).toContain('hs3180/disclaude');
    });
  });
});
