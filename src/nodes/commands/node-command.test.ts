/**
 * Tests for NodeCommand.
 *
 * Issue #541: 节点管理指令 - 便捷的节点操作命令
 */

import { describe, it, expect } from 'vitest';
import { NodeCommand } from './builtin-commands.js';
import type { CommandContext, CommandServices } from './types.js';

describe('NodeCommand', () => {
  const command = new NodeCommand();

  // Mock services for testing
  const mockServices: CommandServices = {
    isRunning: () => true,
    getLocalNodeId: () => 'test-local-node',
    getExecNodes: () => [],
    getChatNodeAssignment: () => undefined,
    switchChatNode: () => false,
    getNode: () => undefined,
    sendCommand: () => Promise.resolve(),
    getFeishuClient: () => null as unknown as ReturnType<CommandServices['getFeishuClient']>,
    createDiscussionChat: () => Promise.resolve('test-chat-id'),
    addMembers: () => Promise.resolve(),
    removeMembers: () => Promise.resolve(),
    getMembers: () => Promise.resolve([]),
    dissolveChat: () => Promise.resolve(),
    registerGroup: () => {},
    unregisterGroup: () => false,
    listGroups: () => [],
    setDebugGroup: () => null,
    getDebugGroup: () => null,
    clearDebugGroup: () => null,
    getChannelStatus: () => 'test: ok',
    // Schedule management (Issue #469)
    listSchedules: () => Promise.resolve([]),
    getSchedule: () => Promise.resolve(undefined),
    enableSchedule: () => Promise.resolve(false),
    disableSchedule: () => Promise.resolve(false),
    runSchedule: () => Promise.resolve(false),
    isScheduleRunning: () => false,
    // Task management methods (Issue #468)
    startTask: () => Promise.resolve({ id: 'task_test', prompt: 'test', status: 'running', progress: 0, chatId: 'oc_test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    getCurrentTask: () => Promise.resolve(null),
    updateTaskProgress: () => Promise.resolve(),
    pauseTask: () => Promise.resolve(null),
    resumeTask: () => Promise.resolve(null),
    cancelTask: () => Promise.resolve(null),
    completeTask: () => Promise.resolve(null),
    setTaskError: () => Promise.resolve(null),
    listTaskHistory: () => Promise.resolve([]),
    // Passive mode management (Issue #601)
    setPassiveMode: () => {},
    getPassiveMode: () => false,
  };

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(command.name).toBe('node');
    });

    it('should have node category', () => {
      expect(command.category).toBe('node');
    });

    it('should have description', () => {
      expect(command.description).toBe('节点管理指令');
    });

    it('should have usage', () => {
      expect(command.usage).toBe('node <list|status|info|switch|auto>');
    });
  });

  describe('execute', () => {
    const createTestContext = (args: string[]): CommandContext => ({
      chatId: 'test-chat-id',
      args,
      rawText: `/node ${args.join(' ')}`,
      services: mockServices,
    });

    describe('no args - help', () => {
      it('should show help when no args provided', () => {
        const result = command.execute(createTestContext([]));

        expect(result.success).toBe(true);
        expect(result.message).toContain('节点管理指令');
        expect(result.message).toContain('list');
        expect(result.message).toContain('status');
        expect(result.message).toContain('info');
        expect(result.message).toContain('switch');
        expect(result.message).toContain('auto');
      });
    });

    describe('invalid subcommand', () => {
      it('should return error for unknown subcommand', () => {
        const result = command.execute(createTestContext(['unknown']));

        expect(result.success).toBe(false);
        expect(result.error).toContain('未知的子命令');
        expect(result.error).toContain('unknown');
      });
    });

    describe('list subcommand', () => {
      it('should return success for list subcommand', () => {
        const result = command.execute(createTestContext(['list']));

        expect(result.success).toBe(true);
        expect(result.message).toBe('🔄 **节点命令执行中...**');
        expect(result.data).toEqual({
          subcommand: 'list',
          nodeArgs: [],
        });
      });
    });

    describe('status subcommand', () => {
      it('should return success for status subcommand', () => {
        const result = command.execute(createTestContext(['status']));

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          subcommand: 'status',
          nodeArgs: [],
        });
      });

      it('should pass node-id to status subcommand', () => {
        const result = command.execute(createTestContext(['status', 'node-123']));

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          subcommand: 'status',
          nodeArgs: ['node-123'],
        });
      });
    });

    describe('info subcommand', () => {
      it('should return success for info subcommand', () => {
        const result = command.execute(createTestContext(['info']));

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          subcommand: 'info',
          nodeArgs: [],
        });
      });
    });

    describe('switch subcommand', () => {
      it('should return success for switch subcommand', () => {
        const result = command.execute(createTestContext(['switch', 'node-456']));

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          subcommand: 'switch',
          nodeArgs: ['node-456'],
        });
      });

      it('should return success for switch without node-id', () => {
        const result = command.execute(createTestContext(['switch']));

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          subcommand: 'switch',
          nodeArgs: [],
        });
      });
    });

    describe('auto subcommand', () => {
      it('should return success for auto subcommand', () => {
        const result = command.execute(createTestContext(['auto']));

        expect(result.success).toBe(true);
        expect(result.data).toEqual({
          subcommand: 'auto',
          nodeArgs: [],
        });
      });
    });

    describe('case insensitivity', () => {
      it('should handle uppercase subcommands', () => {
        const result = command.execute(createTestContext(['LIST']));

        expect(result.success).toBe(true);
        expect(result.data?.subcommand).toBe('list');
      });

      it('should handle mixed case subcommands', () => {
        const result = command.execute(createTestContext(['StAtUs']));

        expect(result.success).toBe(true);
        expect(result.data?.subcommand).toBe('status');
      });
    });
  });
});
