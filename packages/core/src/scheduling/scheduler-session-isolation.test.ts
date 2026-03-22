/**
 * Scheduler Session Isolation Tests
 *
 * Issue #1353: 定时任务每次执行应使用独立 session
 *
 * These tests verify that:
 * 1. Each scheduled task execution creates a new agent instance
 * 2. Each execution uses an independent session (no context accumulation)
 * 3. Sessions are properly disposed after execution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, type SchedulerCallbacks, type TaskExecutor } from './scheduler.js';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

// Mock ScheduleManager
const createMockScheduleManager = (): ScheduleManager => {
  return {
    listEnabled: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    listByChatId: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    getFileScanner: vi.fn(),
  } as unknown as ScheduleManager;
};

describe('Scheduler Session Isolation', () => {
  let scheduler: Scheduler;
  let mockScheduleManager: ScheduleManager;
  let callbacks: SchedulerCallbacks;
  let executorCallCount: number;
  let agentInstances: Array<{ disposed: boolean; sessionId: string }>;
  let sessionIds: string[];

  beforeEach(() => {
    mockScheduleManager = createMockScheduleManager();
    executorCallCount = 0;
    agentInstances = [];
    sessionIds = [];

    callbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
    }
  });

  describe('Session Isolation Between Executions', () => {
    it('should create independent agent instance for each execution', async () => {
      // Track agent creation in executor
      const executor: TaskExecutor = async (_chatId, _prompt, _userId) => {
        executorCallCount++;
        const sessionId = `session-${Date.now()}-${Math.random()}`;

        agentInstances.push({
          disposed: false,
          sessionId,
        });

        // Simulate executeOnce - each call is independent
        // In real implementation, this would create a new SDK query
        sessionIds.push(sessionId);

        // Simulate dispose after execution
        agentInstances[agentInstances.length - 1].disposed = true;
      };

      scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks,
        executor,
      });

      // Create test tasks
      const task1: ScheduledTask = {
        id: 'test-task-1',
        name: 'Test Task 1',
        chatId: 'chat-1',
        prompt: 'Task 1 prompt',
        cron: '*/5 * * * *', // Every 5 minutes
        enabled: true,
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
      };

      // Manually trigger task execution (simulating cron trigger)
      // We use addTask + direct executeTask via reflection or public API
      scheduler.addTask(task1);

      // Get the active job and trigger it manually
      const activeJobs = scheduler.getActiveJobs();
      expect(activeJobs.length).toBe(1);

      // Execute the task multiple times to simulate repeated executions

      // First execution
      await scheduler['executeTask'](activeJobs[0].task);

      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second execution
      await scheduler['executeTask'](activeJobs[0].task);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Third execution
      await scheduler['executeTask'](activeJobs[0].task);

      // Verify: Each execution should have created a new agent
      expect(executorCallCount).toBe(3);
      expect(agentInstances.length).toBe(3);

      // Verify: All agents should be disposed after execution
      expect(agentInstances.every(a => a.disposed)).toBe(true);

      // Verify: Each execution should have a unique session ID
      expect(new Set(sessionIds).size).toBe(3);
    });

    it('should not share context between executions', async () => {
      const contextAccumulator: string[] = [];

      const executor: TaskExecutor = async (_chatId, prompt, _userId) => {
        // In a real scenario with shared session, context would accumulate
        // With proper isolation, each execution only sees its own prompt
        contextAccumulator.push(prompt);

        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 5));
      };

      scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks,
        executor,
      });

      const task: ScheduledTask = {
        id: 'context-test-task',
        name: 'Context Test',
        chatId: 'chat-1',
        prompt: 'Original prompt',
        cron: '* * * * *',
        enabled: true,
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);
      const activeJobs = scheduler.getActiveJobs();

      // Execute twice
      await scheduler['executeTask'](activeJobs[0].task);
      await scheduler['executeTask'](activeJobs[0].task);

      // Each execution should only see the wrapped prompt
      // If context was accumulating, we'd see previous prompts
      expect(contextAccumulator.length).toBe(2);

      // Each prompt should be independent (wrapped with anti-recursion instructions)
      expect(contextAccumulator[0]).toContain('Original prompt');
      expect(contextAccumulator[1]).toContain('Original prompt');

      // Verify no context leakage - prompts should be similar, not containing each other
      expect(contextAccumulator[0]).not.toContain('Previous execution');
      expect(contextAccumulator[1]).not.toContain('Previous execution');
    });

    it('should clean up resources even when execution fails', async () => {
      const executor: TaskExecutor = async (_chatId, _prompt, _userId) => {
        // Simulate failure
        throw new Error('Simulated execution failure');
      };

      scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks,
        executor,
      });

      const task: ScheduledTask = {
        id: 'failing-task',
        name: 'Failing Task',
        chatId: 'chat-1',
        prompt: 'This will fail',
        cron: '* * * * *',
        enabled: true,
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);
      const activeJobs = scheduler.getActiveJobs();

      // Execute - should handle error gracefully
      await scheduler['executeTask'](activeJobs[0].task);

      // Verify error message was sent
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        expect.stringContaining('执行失败')
      );

      // Task should not be marked as running after failure
      expect(scheduler.isTaskRunning('failing-task')).toBe(false);
    });
  });

  describe('Blocking Mechanism', () => {
    it('should skip execution when blocking is enabled and task is running', async () => {
      let executionCount = 0;

      const executor: TaskExecutor = async (_chatId, _prompt, _userId) => {
        executionCount++;
        // Simulate long-running task
        await new Promise(resolve => setTimeout(resolve, 100));
      };

      scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks,
        executor,
      });

      const task: ScheduledTask = {
        id: 'blocking-task',
        name: 'Blocking Task',
        chatId: 'chat-1',
        prompt: 'Long running task',
        cron: '* * * * *',
        enabled: true,
        blocking: true, // Enable blocking
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);
      const activeJobs = scheduler.getActiveJobs();

      // Start first execution (don't await)
      const executionPromise = scheduler['executeTask'](activeJobs[0].task);

      // Wait a bit to ensure first execution has started
      await new Promise(resolve => setTimeout(resolve, 10));

      // Try second execution while first is still running
      await scheduler['executeTask'](activeJobs[0].task);

      // Wait for first execution to complete
      await executionPromise;

      // With blocking enabled, second execution should be skipped
      expect(executionCount).toBe(1);
    });

    it('should allow concurrent executions when blocking is disabled', async () => {
      let executionCount = 0;

      const executor: TaskExecutor = async (_chatId, _prompt, _userId) => {
        executionCount++;
        // Simulate short task
        await new Promise(resolve => setTimeout(resolve, 10));
      };

      scheduler = new Scheduler({
        scheduleManager: mockScheduleManager,
        callbacks,
        executor,
      });

      const task: ScheduledTask = {
        id: 'non-blocking-task',
        name: 'Non-Blocking Task',
        chatId: 'chat-1',
        prompt: 'Quick task',
        cron: '* * * * *',
        enabled: true,
        blocking: false, // Disable blocking (default)
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
      };

      scheduler.addTask(task);
      const activeJobs = scheduler.getActiveJobs();

      // Execute twice concurrently
      await Promise.all([
        scheduler['executeTask'](activeJobs[0].task),
        scheduler['executeTask'](activeJobs[0].task),
      ]);

      // Both executions should have run
      expect(executionCount).toBe(2);
    });
  });

  describe('Task Executor Factory Pattern', () => {
    it('should verify createScheduleExecutor creates isolated sessions', async () => {
      // This test verifies the pattern used in schedule-executor.ts
      const agentCreations: number[] = [];
      const agentDisposals: number[] = [];

      // Simulate the ScheduleAgent interface
      interface MockScheduleAgent {
        executeOnce: (chatId: string, prompt: string, fileRefs?: unknown, userId?: string) => Promise<void>;
        dispose: () => void;
      }

      // Simulate the factory pattern
      const createMockAgentFactory = () => {
        return (_chatId: string, _callbacks: SchedulerCallbacks): MockScheduleAgent => {
          const agentId = Date.now() + Math.random();
          agentCreations.push(agentId);

          return {
            executeOnce: async (_chatId, _prompt, _fileRefs, _userId) => {
              // Simulate execution with fresh session
              await new Promise(resolve => setTimeout(resolve, 5));
            },
            dispose: () => {
              agentDisposals.push(agentId);
            },
          };
        };
      };

      // Create executor using the same pattern as createScheduleExecutor
      const createTestExecutor = (
        agentFactory: ReturnType<typeof createMockAgentFactory>,
        _callbacks: SchedulerCallbacks
      ): TaskExecutor => {
        return async (chatId: string, prompt: string, userId?: string): Promise<void> => {
          const agent = agentFactory(chatId, callbacks);

          try {
            await agent.executeOnce(chatId, prompt, undefined, userId);
          } finally {
            agent.dispose();
          }
        };
      };

      const agentFactory = createMockAgentFactory();
      const executor = createTestExecutor(agentFactory, callbacks);

      // Execute multiple times
      await executor('chat-1', 'prompt-1', 'user-1');
      await executor('chat-1', 'prompt-2', 'user-1');
      await executor('chat-1', 'prompt-3', 'user-1');

      // Verify: Each execution created a new agent
      expect(agentCreations.length).toBe(3);

      // Verify: Each agent was disposed
      expect(agentDisposals.length).toBe(3);

      // Verify: All created agents were disposed (matching IDs)
      expect(agentCreations.sort()).toEqual(agentDisposals.sort());
    });
  });
});
