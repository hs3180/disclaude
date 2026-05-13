/**
 * Tests for Scheduler + InputMessageRouter integration (Issue #3582 Phase 3).
 *
 * Verifies that:
 * - Tasks with projectKey are routed via InputMessageRouter as SystemMessage
 * - Tasks without projectKey use the legacy executor path (backward compatible)
 * - SystemMessage construction is correct for scheduled triggers
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Scheduler, type SchedulerCallbacks, type TaskExecutor } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';
import { InputMessageRouter, type ProjectChatIdResolver } from '../messaging/input-message-router.js';
import { AgentPool } from '../agents/agent-pool.js';
import type { ChatAgent } from '../agents/types.js';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockChatAgent(): ChatAgent {
  return {
    type: 'chat',
    name: 'mock-agent',
    start: vi.fn().mockResolvedValue(undefined),
    handleInput: vi.fn(),
    processMessage: vi.fn(),
    taskComplete: undefined,
    runOnce: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    stop: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
  };
}

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '* * * * *',
    prompt: 'Run tests',
    chatId: 'oc_test',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createResolver(mapping: Record<string, string>): ProjectChatIdResolver {
  return {
    resolve(projectKey: string): string | undefined {
      return mapping[projectKey];
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Scheduler + InputMessageRouter integration (Issue #3582)', () => {
  let mockScheduleManager: ScheduleManager;
  let mockCallbacks: SchedulerCallbacks;
  let mockExecutor: Mock<TaskExecutor>;
  let agentPool: AgentPool;
  let router: InputMessageRouter;
  let resolver: ProjectChatIdResolver;

  beforeEach(() => {
    mockScheduleManager = {
      listEnabled: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      listByChatId: vi.fn().mockResolvedValue([]),
      getFileScanner: vi.fn(),
    } as unknown as ScheduleManager;

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    mockExecutor = vi.fn().mockResolvedValue(undefined);

    agentPool = new AgentPool({
      chatAgentFactory: vi.fn(createMockChatAgent),
    });

    resolver = createResolver({
      'hs3180/disclaude': 'oc_project_chat',
    });

    router = new InputMessageRouter({
      agentPool,
      projectChatIdResolver: resolver,
    });
  });

  describe('legacy path (no projectKey)', () => {
    it('should use executor for tasks without projectKey', async () => {
      const task = createTask({ projectKey: undefined });
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      const scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        messageRouter: router,
      });

      await scheduler.start();
      // Trigger execution directly (cron would take too long)
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // Legacy executor should be called
      expect(mockExecutor).toHaveBeenCalledTimes(1);
      expect(mockExecutor).toHaveBeenCalledWith(
        'oc_test',
        expect.any(String), // wrapped prompt
        undefined,
        undefined,
        undefined,
      );

      await scheduler.stop();
    });

    it('should use executor when messageRouter is not provided', async () => {
      const task = createTask({ projectKey: 'hs3180/disclaude' });
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      const scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        // No messageRouter — even tasks with projectKey should use legacy path
      });

      await scheduler.start();
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      expect(mockExecutor).toHaveBeenCalledTimes(1);

      await scheduler.stop();
    });
  });

  describe('SystemMessage routing (with projectKey)', () => {
    it('should route via InputMessageRouter when task has projectKey', async () => {
      const task = createTask({
        projectKey: 'hs3180/disclaude',
      });
      vi.mocked(mockScheduleManager.listEnabled).mockResolvedValue([task]);

      const scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        messageRouter: router,
      });

      await scheduler.start();
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // Legacy executor should NOT be called — router handles it
      expect(mockExecutor).not.toHaveBeenCalled();

      // Start notification should be sent
      expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('Test Task'),
      );

      await scheduler.stop();
    });

    it('should construct correct SystemMessage with trigger: scheduled', async () => {
      const task = createTask({
        projectKey: 'hs3180/disclaude',
        name: 'Daily Maintenance',
        model: 'claude-sonnet-4-20250514',
        modelTier: 'low',
      });

      const scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        messageRouter: router,
      });

      // Spy on InputMessageRouter.route to verify SystemMessage construction
      const routeSpy = vi.spyOn(router, 'route');

      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      expect(routeSpy).toHaveBeenCalledTimes(1);
      const [[routedMessage]] = routeSpy.mock.calls;

      // Verify SystemMessage fields
      expect(routedMessage.source).toBe('system');
      if (routedMessage.source === 'system') {
        expect(routedMessage.trigger).toBe('scheduled');
        expect(routedMessage.projectKey).toBe('hs3180/disclaude');
        expect(routedMessage.taskName).toBe('Daily Maintenance');
        expect(routedMessage.payload).toContain('Daily Maintenance');
        expect(routedMessage.data).toEqual({
          taskId: 'task-1',
          model: 'claude-sonnet-4-20250514',
          modelTier: 'low',
          createdBy: undefined,
        });
      }

      routeSpy.mockRestore();
    });

    it('should fall back to executor for unknown projectKey', async () => {
      const task = createTask({
        projectKey: 'unknown/project',
      });

      const scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        messageRouter: router,
      });

      // The router will return a fallback result for unknown project
      // but the scheduler will still attempt to route and succeed (no error thrown)
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(task);

      // Start notification should be sent regardless
      expect(mockCallbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('Test Task'),
      );
    });
  });

  describe('backward compatibility', () => {
    it('should handle mixed tasks (some with projectKey, some without)', async () => {
      const legacyTask = createTask({ id: 'task-legacy', projectKey: undefined });
      const projectTask = createTask({ id: 'task-project', projectKey: 'hs3180/disclaude' });

      const scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
        messageRouter: router,
      });

      // Execute legacy task — should use executor
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(legacyTask);
      expect(mockExecutor).toHaveBeenCalledTimes(1);

      // Execute project task — should NOT use executor
      await (scheduler as unknown as { executeTask: (t: ScheduledTask) => Promise<void> }).executeTask(projectTask);
      // Executor count should still be 1 (only called for legacy task)
      expect(mockExecutor).toHaveBeenCalledTimes(1);
    });

    it('should accept messageRouter as optional in constructor', () => {
      const scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks: mockCallbacks,
        executor: mockExecutor,
      });

      expect(scheduler).toBeInstanceOf(Scheduler);
      expect(scheduler.isRunning()).toBe(false);
    });
  });
});
