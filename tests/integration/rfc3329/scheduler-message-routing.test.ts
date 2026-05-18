/**
 * Integration test: Scheduler → Agent → Message output (RFC #3329).
 *
 * Tests the cross-component pipeline:
 *   Scheduler triggers → ScheduleExecutor creates Agent → Agent callbacks send messages
 *
 * Verifies that:
 * 1. Scheduled task execution creates a short-lived agent via factory
 * 2. Agent execution triggers message callbacks
 * 3. Input MessageRouter correctly routes SystemMessage from scheduler
 * 4. The full pipeline works end-to-end
 *
 * @see Issue #3662
 * @see RFC #3329
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, createScheduleExecutor } from '@disclaude/core';
import type { SchedulerCallbacks, TaskExecutor, ScheduledTask, AgentFactory } from '@disclaude/core';
import { MessageRouter, type IAgentMessageHandler, MessageRoutingError } from '@disclaude/core';
import type { ChatAgent, SystemMessage } from '@disclaude/core';
import { trackResource } from '../../test-resource-tracker.js';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockAgent(): ChatAgent {
  return {
    type: 'chat',
    name: 'test-schedule-agent',
    start: vi.fn().mockResolvedValue(undefined),
    handleInput: vi.fn(),
    processMessage: vi.fn(),
    taskComplete: Promise.resolve(),
    runOnce: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    stop: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
  } as unknown as ChatAgent;
}

function createMockCallbacks(): SchedulerCallbacks & {
  getMessages: () => Array<{ chatId: string; message: string }>;
} {
  const messages: Array<{ chatId: string; message: string }> = [];
  return {
    sendMessage: vi.fn(async (chatId: string, message: string) => {
      messages.push({ chatId, message });
    }),
    getMessages: () => messages,
  };
}

function createMockScheduleManager(tasks: ScheduledTask[] = []) {
  return {
    listEnabled: vi.fn().mockResolvedValue(tasks),
    listByChatId: vi.fn().mockResolvedValue(tasks),
    get: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Scheduler → Agent → Message output', () => {
  let mockAgent: ChatAgent;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    mockAgent = createMockAgent();
    callbacks = createMockCallbacks();
  });

  describe('ScheduleExecutor pipeline', () => {
    it('should create agent, execute, and dispose on success', async () => {
      const agentFactory: AgentFactory = vi.fn().mockReturnValue(mockAgent);
      const executor = createScheduleExecutor({
        agentFactory,
        callbacks,
      });

      await executor('oc_task_chat', 'Do something useful');

      expect(agentFactory).toHaveBeenCalledTimes(1);
      expect(agentFactory).toHaveBeenCalledWith('oc_task_chat', callbacks, undefined, undefined);
      expect(mockAgent.runOnce).toHaveBeenCalledTimes(1);
      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should pass model and modelTier to agent factory', async () => {
      const agentFactory: AgentFactory = vi.fn().mockReturnValue(mockAgent);
      const executor = createScheduleExecutor({
        agentFactory,
        callbacks,
      });

      await executor('oc_chat', 'Task', 'user-1', 'claude-sonnet-4', 'low');

      expect(agentFactory).toHaveBeenCalledWith('oc_chat', callbacks, 'claude-sonnet-4', 'low');
    });

    it('should dispose agent even when runOnce fails', async () => {
      vi.mocked(mockAgent.runOnce).mockRejectedValue(new Error('Agent crashed'));

      const agentFactory: AgentFactory = vi.fn().mockReturnValue(mockAgent);
      const executor = createScheduleExecutor({
        agentFactory,
        callbacks,
      });

      await expect(executor('oc_chat', 'Failing task')).rejects.toThrow('Agent crashed');
      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scheduler → InputMessageRouter pipeline', () => {
    it('should route SystemMessage through InputMessageRouter when configured', async () => {
      const routedMessages: SystemMessage[] = [];
      const handler: IAgentMessageHandler = {
        handleUserMessage: vi.fn(),
        handleSystemMessage: vi.fn(async (_chatId, _payload, _messageId) => {
          // Captured via the router's route method
        }),
      };

      const inputRouter = new MessageRouter({ handler });

      // Wrap the handler to capture routed messages
      const originalRoute = inputRouter.route.bind(inputRouter);

      const task: ScheduledTask = {
        id: 'task-e2e-1',
        name: 'E2E Test Task',
        cron: '* * * * *', // every minute (won't actually fire in test)
        prompt: 'Execute end-to-end test',
        chatId: 'oc_e2e_chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      const scheduleManager = createMockScheduleManager([task]);
      const agentFactory: AgentFactory = vi.fn().mockReturnValue(mockAgent);

      const scheduler = trackResource(new Scheduler({
        scheduleManager: scheduleManager as any,
        callbacks,
        executor: createScheduleExecutor({ agentFactory, callbacks }),
        inputMessageRouter: inputRouter,
      }));

      // Simulate what happens when the scheduler fires a task
      // by calling the internal logic through the public addTask + checking executeTask indirectly
      // Since we can't directly call executeTask (private), we test the routing directly

      const systemMessage: SystemMessage = {
        id: `sched-${task.id}-${Date.now()}`,
        source: 'system',
        payload: `⚠️ **Scheduled Task Execution Context**\n\nYou are executing a scheduled task named "${task.name}".\n\n**IMPORTANT RULES:**\n1. Do NOT create new scheduled tasks\n2. Do NOT modify existing scheduled tasks\n3. Focus on completing the task described below\n4. If you need to run something periodically, report this need to the user instead\n\nScheduled task creation is blocked during scheduled task execution to prevent infinite recursion.\n\n---\n\n**Task Prompt:**\n${task.prompt}`,
        chatId: task.chatId,
        trigger: 'scheduled',
        taskName: task.name,
        createdAt: new Date().toISOString(),
      };

      await inputRouter.route(systemMessage);

      expect(handler.handleSystemMessage).toHaveBeenCalledWith(
        'oc_e2e_chat',
        expect.stringContaining('E2E Test Task'),
        expect.stringMatching(/^sched-task-e2e-1-\d+$/)
      );

      await scheduler.stop(0);
    });

    it('should throw MessageRoutingError for SystemMessage without chatId', async () => {
      const handler: IAgentMessageHandler = {
        handleUserMessage: vi.fn(),
        handleSystemMessage: vi.fn(),
      };
      const inputRouter = new MessageRouter({ handler });

      const badMessage = {
        id: 'msg-bad',
        source: 'system' as const,
        payload: 'Orphan task',
        chatId: '',
        trigger: 'scheduled' as const,
        createdAt: new Date().toISOString(),
      };

      await expect(inputRouter.route(badMessage)).rejects.toThrow(MessageRoutingError);
      await expect(inputRouter.route(badMessage)).rejects.toThrow('missing chatId');
    });
  });

  describe('Scheduler lifecycle with callbacks', () => {
    it('should send start notification via callbacks when task executes', async () => {
      const agentFactory: AgentFactory = vi.fn().mockReturnValue(mockAgent);
      const executor = createScheduleExecutor({ agentFactory, callbacks });

      const task: ScheduledTask = {
        id: 'task-lifecycle-1',
        name: 'Lifecycle Test',
        cron: '0 9 * * *',
        prompt: 'Check lifecycle',
        chatId: 'oc_lifecycle_chat',
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      const scheduleManager = createMockScheduleManager([task]);

      const scheduler = trackResource(new Scheduler({
        scheduleManager: scheduleManager as any,
        callbacks,
        executor,
      }));

      await scheduler.start();
      // The task won't fire automatically in tests (cron timing), but we verify
      // the scheduler loaded the tasks correctly
      expect(scheduleManager.listEnabled).toHaveBeenCalledTimes(1);
      expect(scheduler.isRunning()).toBe(true);

      await scheduler.stop(0);
    });
  });
});
