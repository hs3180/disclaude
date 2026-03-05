/**
 * Tests for ScheduleCommand.
 *
 * Issue #469: 定时任务控制指令 - schedule 管理
 */

import { describe, it, expect } from 'vitest';
import { ScheduleCommand } from './builtin-commands.js';
import type { CommandContext, CommandServices, ScheduleTaskInfo } from './types.js';

describe('ScheduleCommand', () => {
  const command = new ScheduleCommand();

  // Mock schedule data
  const mockTasks: ScheduleTaskInfo[] = [
    {
      id: 'schedule-daily-report',
      name: 'daily-report',
      cron: '0 9 * * *',
      enabled: true,
      isScheduled: true,
      isRunning: false,
      chatId: 'oc_test',
      createdAt: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'schedule-weekly-summary',
      name: 'weekly-summary',
      cron: '0 9 * * 1',
      enabled: false,
      isScheduled: false,
      isRunning: false,
      chatId: 'oc_test',
      createdAt: '2026-03-01T00:00:00.000Z',
    },
  ];

  // Mock services for testing
  const createMockServices = (tasks: ScheduleTaskInfo[] = mockTasks): CommandServices => ({
    isRunning: () => true,
    getLocalNodeId: () => 'test-node',
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
    // Group creation (Issue #692)
    createGroup: () => Promise.resolve({ chatId: 'oc_test', name: 'Test Group', createdAt: Date.now(), initialMembers: [] }),
    getBotChats: () => Promise.resolve([]),
    setDebugGroup: () => null,
    getDebugGroup: () => null,
    clearDebugGroup: () => null,
    getChannelStatus: () => 'test: ok',
    // Schedule management
    listSchedules: () => Promise.resolve(tasks),
    getSchedule: (nameOrId: string) => Promise.resolve(
      tasks.find(t => t.id === nameOrId || t.id === `schedule-${nameOrId}` || t.name === nameOrId)
    ),
    enableSchedule: () => Promise.resolve(true),
    disableSchedule: () => Promise.resolve(true),
    runSchedule: () => Promise.resolve(true),
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
    // Credit management (Issue #538)
    createCreditAccount: () => ({ agentId: 'test', balance: 0, dailyLimit: 100, usedToday: 0, lastResetAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }),
    getCreditAccount: () => undefined,
    hasCreditAccount: () => false,
    rechargeCredits: () => undefined,
    setCreditDailyLimit: () => undefined,
    listCreditAccounts: () => [],
  });

  const createContext = (args: string[], services: CommandServices = createMockServices()): CommandContext => ({
    chatId: 'oc_test',
    userId: 'ou_test',
    args,
    rawText: args.join(' '),
    services,
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(command.name).toBe('schedule');
    });

    it('should have schedule category', () => {
      expect(command.category).toBe('schedule');
    });

    it('should have description', () => {
      expect(command.description).toBe('定时任务管理');
    });

    it('should have usage', () => {
      expect(command.usage).toBe('schedule <list|status|enable|disable|run>');
    });
  });

  describe('help', () => {
    it('should show help when no args provided', async () => {
      const result = await command.execute(createContext([]));

      expect(result.success).toBe(true);
      expect(result.message).toContain('定时任务管理');
      expect(result.message).toContain('list');
      expect(result.message).toContain('status');
      expect(result.message).toContain('enable');
      expect(result.message).toContain('disable');
      expect(result.message).toContain('run');
    });

    it('should show error for invalid subcommand', async () => {
      const result = await command.execute(createContext(['invalid']));

      expect(result.success).toBe(false);
      expect(result.error).toContain('未知的子命令');
    });
  });

  describe('list', () => {
    it('should list all scheduled tasks', async () => {
      const result = await command.execute(createContext(['list']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('定时任务列表');
      expect(result.message).toContain('daily-report');
      expect(result.message).toContain('weekly-summary');
    });

    it('should show empty message when no tasks', async () => {
      const result = await command.execute(createContext(['list'], createMockServices([])));

      expect(result.success).toBe(true);
      expect(result.message).toContain('暂无定时任务');
    });

    it('should show task status icons', async () => {
      const result = await command.execute(createContext(['list']));

      expect(result.success).toBe(true);
      // Enabled and scheduled task should show ✅
      expect(result.message).toContain('✅');
      // Disabled task should show ❌
      expect(result.message).toContain('❌');
    });
  });

  describe('status', () => {
    it('should require task name', async () => {
      const result = await command.execute(createContext(['status']));

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定任务名称');
    });

    it('should show task status by name', async () => {
      const result = await command.execute(createContext(['status', 'daily-report']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('任务详情');
      expect(result.message).toContain('daily-report');
      expect(result.message).toContain('0 9 * * *');
    });

    it('should show task status by ID', async () => {
      const result = await command.execute(createContext(['status', 'schedule-daily-report']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('daily-report');
    });

    it('should show error when task not found', async () => {
      const result = await command.execute(createContext(['status', 'nonexistent']));

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到任务');
    });
  });

  describe('enable', () => {
    it('should require task name', async () => {
      const result = await command.execute(createContext(['enable']));

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定任务名称');
    });

    it('should enable task', async () => {
      const result = await command.execute(createContext(['enable', 'weekly-summary']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('任务已启用');
    });

    it('should show error when enable fails', async () => {
      const services = createMockServices();
      services.enableSchedule = () => Promise.resolve(false);

      const result = await command.execute(createContext(['enable', 'daily-report'], services));

      expect(result.success).toBe(false);
      expect(result.error).toContain('启用任务失败');
    });
  });

  describe('disable', () => {
    it('should require task name', async () => {
      const result = await command.execute(createContext(['disable']));

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定任务名称');
    });

    it('should disable task', async () => {
      const result = await command.execute(createContext(['disable', 'daily-report']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('任务已禁用');
    });

    it('should show error when disable fails', async () => {
      const services = createMockServices();
      services.disableSchedule = () => Promise.resolve(false);

      const result = await command.execute(createContext(['disable', 'weekly-summary'], services));

      expect(result.success).toBe(false);
      expect(result.error).toContain('禁用任务失败');
    });
  });

  describe('run', () => {
    it('should require task name', async () => {
      const result = await command.execute(createContext(['run']));

      expect(result.success).toBe(false);
      expect(result.error).toContain('请指定任务名称');
    });

    it('should trigger task', async () => {
      const result = await command.execute(createContext(['run', 'daily-report']));

      expect(result.success).toBe(true);
      expect(result.message).toContain('任务已触发');
    });

    it('should show error when task not found', async () => {
      const result = await command.execute(createContext(['run', 'nonexistent']));

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到任务');
    });

    it('should show error when task is already running', async () => {
      const services = createMockServices([{
        ...mockTasks[0],
        isRunning: true,
      }]);

      const result = await command.execute(createContext(['run', 'daily-report'], services));

      expect(result.success).toBe(false);
      expect(result.error).toContain('正在执行中');
    });

    it('should show error when trigger fails', async () => {
      const services = createMockServices();
      services.runSchedule = () => Promise.resolve(false);

      const result = await command.execute(createContext(['run', 'daily-report'], services));

      expect(result.success).toBe(false);
      expect(result.error).toContain('触发任务失败');
    });
  });
});
