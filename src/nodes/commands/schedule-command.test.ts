/**
 * Tests for ScheduleCommand.
 *
 * Issue #469: 定时任务控制指令
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScheduleCommand } from './builtin-commands.js';
import type { CommandContext, CommandServices } from './types.js';

describe('ScheduleCommand', () => {
  let command: ScheduleCommand;
  let mockServices: CommandServices;
  let mockContext: CommandContext;

  beforeEach(() => {
    command = new ScheduleCommand();

    mockServices = {
      isRunning: vi.fn(() => true),
      getLocalNodeId: vi.fn(() => 'test-node'),
      getExecNodes: vi.fn(() => []),
      getChatNodeAssignment: vi.fn(),
      switchChatNode: vi.fn(),
      getNode: vi.fn(),
      sendCommand: vi.fn(),
      getFeishuClient: vi.fn(),
      createDiscussionChat: vi.fn(),
      addMembers: vi.fn(),
      removeMembers: vi.fn(),
      getMembers: vi.fn(),
      dissolveChat: vi.fn(),
      registerGroup: vi.fn(),
      unregisterGroup: vi.fn(),
      listGroups: vi.fn(() => []),
      setDebugGroup: vi.fn(),
      getDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn(),
      getChannelStatus: vi.fn(() => 'ok'),
      // Schedule management methods
      listSchedules: vi.fn(),
      getSchedule: vi.fn(),
      toggleSchedule: vi.fn(),
      triggerSchedule: vi.fn(),
    };

    mockContext = {
      chatId: 'oc_test_chat',
      userId: 'ou_test_user',
      args: [],
      rawText: '',
      services: mockServices,
    };
  });

  describe('metadata', () => {
    it('should have correct name and category', () => {
      expect(command.name).toBe('schedule');
      expect(command.category).toBe('schedule');
      expect(command.description).toBe('定时任务管理');
    });
  });

  describe('help', () => {
    it('should show help when no subcommand', async () => {
      const result = await command.execute({ ...mockContext, args: [] });

      expect(result.success).toBe(true);
      expect(result.message).toContain('定时任务管理指令');
      expect(result.message).toContain('list');
      expect(result.message).toContain('status');
      expect(result.message).toContain('enable');
      expect(result.message).toContain('disable');
      expect(result.message).toContain('run');
    });
  });

  describe('list', () => {
    it('should list schedules for current chat', async () => {
      vi.mocked(mockServices.listSchedules).mockResolvedValue([
        { id: 'schedule-task1', name: 'Task 1', cron: '0 9 * * *', enabled: true },
        { id: 'schedule-task2', name: 'Task 2', cron: '0 18 * * *', enabled: false },
      ]);

      const result = await command.execute({ ...mockContext, args: ['list'] });

      expect(result.success).toBe(true);
      expect(result.message).toContain('定时任务列表');
      expect(result.message).toContain('schedule-task1');
      expect(result.message).toContain('schedule-task2');
      expect(mockServices.listSchedules).toHaveBeenCalledWith('oc_test_chat');
    });

    it('should show empty message when no schedules', async () => {
      vi.mocked(mockServices.listSchedules).mockResolvedValue([]);

      const result = await command.execute({ ...mockContext, args: ['list'] });

      expect(result.success).toBe(true);
      expect(result.message).toContain('没有定时任务');
    });
  });

  describe('status', () => {
    it('should show schedule status', async () => {
      vi.mocked(mockServices.getSchedule).mockResolvedValue({
        id: 'schedule-task1',
        name: 'Task 1',
        cron: '0 9 * * *',
        enabled: true,
        chatId: 'oc_test_chat',
        prompt: 'This is a test prompt',
        blocking: true,
        isRunning: false,
      });

      const result = await command.execute({ ...mockContext, args: ['status', 'schedule-task1'] });

      expect(result.success).toBe(true);
      expect(result.message).toContain('定时任务详情');
      expect(result.message).toContain('schedule-task1');
      expect(result.message).toContain('Task 1');
      expect(result.message).toContain('已启用');
      expect(mockServices.getSchedule).toHaveBeenCalledWith('schedule-task1');
    });

    it('should return error when task not found', async () => {
      vi.mocked(mockServices.getSchedule).mockResolvedValue(undefined);

      const result = await command.execute({ ...mockContext, args: ['status', 'schedule-notexist'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('should return error when no task id provided', async () => {
      const result = await command.execute({ ...mockContext, args: ['status'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定任务ID');
    });
  });

  describe('enable', () => {
    it('should enable a schedule', async () => {
      vi.mocked(mockServices.toggleSchedule).mockResolvedValue(true);

      const result = await command.execute({ ...mockContext, args: ['enable', 'schedule-task1'] });

      expect(result.success).toBe(true);
      expect(result.message).toContain('已启用');
      expect(mockServices.toggleSchedule).toHaveBeenCalledWith('schedule-task1', true);
    });

    it('should return error when toggle fails', async () => {
      vi.mocked(mockServices.toggleSchedule).mockResolvedValue(false);

      const result = await command.execute({ ...mockContext, args: ['enable', 'schedule-notexist'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在或操作失败');
    });
  });

  describe('disable', () => {
    it('should disable a schedule', async () => {
      vi.mocked(mockServices.toggleSchedule).mockResolvedValue(true);

      const result = await command.execute({ ...mockContext, args: ['disable', 'schedule-task1'] });

      expect(result.success).toBe(true);
      expect(result.message).toContain('已禁用');
      expect(mockServices.toggleSchedule).toHaveBeenCalledWith('schedule-task1', false);
    });
  });

  describe('run', () => {
    it('should trigger a schedule', async () => {
      vi.mocked(mockServices.triggerSchedule).mockResolvedValue(true);

      const result = await command.execute({ ...mockContext, args: ['run', 'schedule-task1'] });

      expect(result.success).toBe(true);
      expect(result.message).toContain('已触发');
      expect(mockServices.triggerSchedule).toHaveBeenCalledWith('schedule-task1');
    });

    it('should return error when trigger fails', async () => {
      vi.mocked(mockServices.triggerSchedule).mockResolvedValue(false);

      const result = await command.execute({ ...mockContext, args: ['run', 'schedule-notexist'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在或触发失败');
    });
  });

  describe('invalid subcommand', () => {
    it('should return error for unknown subcommand', async () => {
      const result = await command.execute({ ...mockContext, args: ['invalid'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('未知的子命令');
    });
  });
});
