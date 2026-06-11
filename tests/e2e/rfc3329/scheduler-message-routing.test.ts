/**
 * Integration test: Scheduler → InputMessageRouter → Handler chain.
 *
 * Tests the cross-component flow:
 *   Scheduler.executeTask() → SystemMessage → InputMessageRouter.route() → IAgentMessageHandler
 *
 * Verifies that when a scheduled task triggers with inputMessageRouter configured,
 * it correctly builds a SystemMessage and routes it through the MessageRouter
 * to the IAgentMessageHandler.
 *
 * Uses fireOnTick() for deterministic test execution (no cron timing dependency).
 *
 * @see Issue #3662 — category 2
 * @see RFC #3329 — Message — Unified Agent Input Abstraction
 * @see Issue #3582 — Phase 3: Scheduler → InputMessageRouter wiring
 * @see Issue #3901 — Unified routing via InputMessageRouter
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Scheduler,
  type SchedulerCallbacks,
  type ScheduledTask,
  MessageRouter,
  type IAgentMessageHandler,
} from '@disclaude/core';
import type { ScheduleManager } from '@disclaude/core';

/**
 * Create a minimal ScheduledTask with defaults.
 */
function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'test-task',
    name: 'Test Task',
    cron: '* * * * *',
    prompt: 'Run tests',
    chatId: 'oc_test',
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock ScheduleManager that returns a predefined task list.
 */
function createMockScheduleManager(tasks: ScheduledTask[]): ScheduleManager {
  return {
    list: vi.fn().mockResolvedValue(tasks),
    listEnabled: vi.fn().mockResolvedValue(tasks.filter((t) => t.enabled)),
    get: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(tasks.find((t) => t.id === id) ?? null)
    ),
    add: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(tasks),
  } as unknown as ScheduleManager;
}

describe('Scheduler → InputMessageRouter → Handler (RFC #3329)', () => {
  let scheduler: Scheduler;

  afterEach(async () => {
    if (scheduler) {
      await scheduler.stop();
    }
  });

  /** Helper: fire a cron job and wait for async side-effects */
  function fireJob() {
    const jobs = scheduler.getActiveJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    void jobs[0].job.fireOnTick();
  }

  it('should route scheduled task through InputMessageRouter as SystemMessage', async () => {
    const handlerCalls: Array<{ chatId: string; payload: string; messageId: string }> = [];
    const handler: IAgentMessageHandler = {
      handleUserMessage: vi.fn(),
      handleSystemMessage: vi.fn().mockImplementation(async (chatId, payload, messageId) => {
        handlerCalls.push({ chatId, payload, messageId });
      }),
    };
    const router = new MessageRouter({ handler });

    const task = createTask({
      id: 'router-task',
      name: 'Daily Report',
      prompt: 'Generate daily report',
      chatId: 'oc_routed_chat',
    });

    scheduler = new Scheduler({
      scheduleManager: createMockScheduleManager([task]),
      callbacks: { sendMessage: vi.fn() },
      inputMessageRouter: router,
    });

    await scheduler.start();

    // Manually fire the cron job
    fireJob();

    // Wait for async handler call
    await vi.waitFor(() => {
      expect(handlerCalls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    expect(handlerCalls[0].chatId).toBe('oc_routed_chat');
    expect(handlerCalls[0].payload).toContain('Generate daily report');
    expect(typeof handlerCalls[0].messageId).toBe('string');
  });

  it('should send start notification before routing through MessageRouter', async () => {
    const handler: IAgentMessageHandler = {
      handleUserMessage: vi.fn(),
      handleSystemMessage: vi.fn(),
    };
    const router = new MessageRouter({ handler });

    const sentMessages: Array<{ chatId: string; message: string }> = [];
    const callbacks: SchedulerCallbacks = {
      sendMessage: vi.fn().mockImplementation(async (chatId, message) => {
        sentMessages.push({ chatId, message });
      }),
    };

    const task = createTask({ id: 'notify-task', name: 'Notify Test' });

    scheduler = new Scheduler({
      scheduleManager: createMockScheduleManager([task]),
      callbacks,
      inputMessageRouter: router,
    });

    await scheduler.start();
    fireJob();

    await vi.waitFor(() => {
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    // First message should be the start notification
    expect(sentMessages[0].chatId).toBe('oc_test');
    expect(sentMessages[0].message).toContain('Notify Test');
    expect(sentMessages[0].message).toContain('开始执行');
  });

  it('should pass correct SystemMessage metadata through MessageRouter', async () => {
    const handlerCalls: Array<{ chatId: string; payload: string; messageId: string }> = [];
    const handler: IAgentMessageHandler = {
      handleUserMessage: vi.fn(),
      handleSystemMessage: vi.fn().mockImplementation(async (chatId, payload, messageId) => {
        handlerCalls.push({ chatId, payload, messageId });
      }),
    };
    const router = new MessageRouter({ handler });

    // Route a system message directly (simulating what Scheduler does internally)
    await router.route({
      id: 'sched-test-123',
      source: 'system',
      payload: 'Test scheduled prompt',
      chatId: 'oc_metadata_chat',
      trigger: 'scheduled',
      taskName: 'Metadata Test',
      modelTier: 'low',
      data: { taskId: 'task-xyz', custom: 'value' },
      createdAt: new Date().toISOString(),
    });

    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]).toEqual({
      chatId: 'oc_metadata_chat',
      payload: 'Test scheduled prompt',
      messageId: 'sched-test-123',
    });
  });
});
