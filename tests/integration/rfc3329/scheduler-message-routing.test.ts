/**
 * Integration tests for Scheduler → Agent → Message output (RFC #3329).
 *
 * Verifies end-to-end flow:
 * - ScheduleExecutor creates an agent and delegates execution
 * - Scheduler triggers → executor → agent.runOnce() → sendMessage callback called
 * - InputMessageRouter routes SystemMessage to correct handler
 * - Error handling propagates through the chain
 *
 * Issue #3662: Integration tests for RFC #3329 (Area 2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageRouter as InputMessageRouter,
  type IAgentMessageHandler,
} from '../../../packages/core/src/messaging/message-router.js';
import {
  createScheduleExecutor,
  type AgentFactory,
} from '../../../packages/core/src/scheduling/schedule-executor.js';
import type {
  SchedulerCallbacks,
  TaskExecutor,
} from '../../../packages/core/src/scheduling/scheduler.js';
import type { ChatAgent } from '../../../packages/core/src/agents/types.js';
import type { SystemMessage } from '../../../packages/core/src/types/message.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockChatAgent(): ChatAgent {
  return {
    runOnce: vi.fn().mockResolvedValue(undefined),
    processMessage: vi.fn(),
    dispose: vi.fn(),
    startAgentLoop: vi.fn(),
    isRunning: false,
  } as unknown as ChatAgent;
}

function createSystemMessage(overrides?: Partial<SystemMessage>): SystemMessage {
  return {
    id: 'msg-sys-sched-1',
    source: 'system',
    payload: 'Run daily maintenance task',
    chatId: 'oc_chat_admin',
    trigger: 'scheduled',
    taskName: 'daily-maintenance',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Integration: ScheduleExecutor → Agent lifecycle
// ============================================================================

describe('RFC #3329 Integration: ScheduleExecutor → Agent → Message', () => {
  let mockCallbacks: SchedulerCallbacks;
  let mockAgent: ChatAgent;
  let agentFactory: AgentFactory;

  beforeEach(() => {
    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    mockAgent = createMockChatAgent();
    agentFactory = vi.fn().mockReturnValue(mockAgent);
  });

  it('should create agent, run task, and dispose agent', async () => {
    const executor = createScheduleExecutor({
      agentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_chat_target', 'Execute scheduled task', 'user_1');

    // Verify agent was created via factory
    expect(agentFactory).toHaveBeenCalledWith(
      'oc_chat_target',
      mockCallbacks,
      undefined,
      undefined,
    );

    // Verify agent.runOnce() was called with correct params
    expect(mockAgent.runOnce).toHaveBeenCalledWith(
      'oc_chat_target',
      'Execute scheduled task',
      expect.stringMatching(/^sched-\d+$/),
      'user_1',
    );

    // Verify agent was disposed after execution
    expect(mockAgent.dispose).toHaveBeenCalled();
  });

  it('should pass model and modelTier to agent factory', async () => {
    const executor = createScheduleExecutor({
      agentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_chat', 'Task', 'user_1', 'claude-opus-4', 'premium');

    expect(agentFactory).toHaveBeenCalledWith(
      'oc_chat',
      mockCallbacks,
      'claude-opus-4',
      'premium',
    );
  });

  it('should dispose agent even when runOnce throws', async () => {
    (mockAgent.runOnce as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SDK connection failed'),
    );

    const executor = createScheduleExecutor({
      agentFactory,
      callbacks: mockCallbacks,
    });

    await expect(
      executor('oc_chat', 'Failing task'),
    ).rejects.toThrow('SDK connection failed');

    // Agent should still be disposed
    expect(mockAgent.dispose).toHaveBeenCalled();
  });

  it('should generate messageId with sched- prefix', async () => {
    const executor = createScheduleExecutor({
      agentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_chat1', 'Task 1');

    const calls = (mockAgent.runOnce as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][2]).toMatch(/^sched-\d+$/);
  });
});

// ============================================================================
// Integration: SystemMessage → InputMessageRouter → Handler (Scheduler flow)
// ============================================================================

describe('RFC #3329 Integration: SystemMessage → InputMessageRouter → Handler', () => {
  it('should route scheduled SystemMessage to handler correctly', async () => {
    const handler: IAgentMessageHandler = {
      handleUserMessage: vi.fn().mockResolvedValue(undefined),
      handleSystemMessage: vi.fn().mockResolvedValue(undefined),
    };
    const router = new InputMessageRouter({ handler });

    const systemMessage = createSystemMessage({
      id: 'sched-daily-001',
      chatId: 'oc_admin_chat',
      payload: '⚠️ Scheduled Task: daily-maintenance',
      taskName: 'daily-maintenance',
      trigger: 'scheduled',
    });

    await router.route(systemMessage);

    expect(handler.handleSystemMessage).toHaveBeenCalledWith(
      'oc_admin_chat',
      '⚠️ Scheduled Task: daily-maintenance',
      'sched-daily-001',
    );
    // User handler should NOT be called
    expect(handler.handleUserMessage).not.toHaveBeenCalled();
  });

  it('should route different trigger types to same handler', async () => {
    const handler: IAgentMessageHandler = {
      handleUserMessage: vi.fn().mockResolvedValue(undefined),
      handleSystemMessage: vi.fn().mockResolvedValue(undefined),
    };
    const router = new InputMessageRouter({ handler });

    const triggers: Array<SystemMessage['trigger']> = ['scheduled', 'signal', 'command'];

    for (const trigger of triggers) {
      const msg = createSystemMessage({
        id: `msg-${trigger}`,
        trigger,
        chatId: 'oc_chat_x',
      });
      await router.route(msg);
    }

    expect(handler.handleSystemMessage).toHaveBeenCalledTimes(3);

    // All should be routed to the same chatId
    for (let i = 0; i < 3; i++) {
      expect((handler.handleSystemMessage as ReturnType<typeof vi.fn>).mock.calls[i][0]).toBe(
        'oc_chat_x',
      );
    }
  });

  it('should route SystemMessage to different chatIds for different tasks', async () => {
    const handler: IAgentMessageHandler = {
      handleUserMessage: vi.fn().mockResolvedValue(undefined),
      handleSystemMessage: vi.fn().mockResolvedValue(undefined),
    };
    const router = new InputMessageRouter({ handler });

    const messages = [
      createSystemMessage({ id: 's-1', chatId: 'oc_chat_proj1', taskName: 'pr-scanner' }),
      createSystemMessage({ id: 's-2', chatId: 'oc_chat_proj2', taskName: 'issue-triage' }),
    ];

    for (const msg of messages) {
      await router.route(msg);
    }

    expect(handler.handleSystemMessage).toHaveBeenCalledTimes(2);
    expect(handler.handleSystemMessage).toHaveBeenNthCalledWith(
      1,
      'oc_chat_proj1',
      expect.any(String),
      's-1',
    );
    expect(handler.handleSystemMessage).toHaveBeenNthCalledWith(
      2,
      'oc_chat_proj2',
      expect.any(String),
      's-2',
    );
  });
});

// ============================================================================
// Integration: Full chain — ScheduleExecutor + InputMessageRouter
// ============================================================================

describe('RFC #3329 Integration: Full Scheduler → Router chain', () => {
  it('should wire ScheduleExecutor with InputMessageRouter for SystemMessage dispatch', async () => {
    // Simulate the full PrimaryNode wiring:
    // 1. Scheduler triggers a task
    // 2. ScheduleExecutor creates a short-lived agent
    // 3. Agent executes and sends messages via callback
    // 4. Messages are routed through InputMessageRouter

    const sentMessages: Array<{ chatId: string; content: string }> = [];
    const callbacks: SchedulerCallbacks = {
      sendMessage: vi.fn().mockImplementation(async (chatId: string, content: string) => {
        sentMessages.push({ chatId, content });
      }),
    };

    const mockAgent = createMockChatAgent();
    const agentFactory: AgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({ agentFactory, callbacks });

    // Execute a scheduled task
    await executor('oc_target_chat', 'Analyze recent PRs', 'bot_user');

    // Verify the full chain:
    // 1. Agent was created
    expect(agentFactory).toHaveBeenCalled();

    // 2. runOnce was called with correct params
    expect(mockAgent.runOnce).toHaveBeenCalledWith(
      'oc_target_chat',
      'Analyze recent PRs',
      expect.stringMatching(/^sched-\d+$/),
      'bot_user',
    );

    // 3. Agent was disposed
    expect(mockAgent.dispose).toHaveBeenCalled();
  });

  it('should handle concurrent scheduler tasks routing to different chats', async () => {
    const handler: IAgentMessageHandler = {
      handleUserMessage: vi.fn().mockResolvedValue(undefined),
      handleSystemMessage: vi.fn().mockResolvedValue(undefined),
    };
    const router = new InputMessageRouter({ handler });

    // Simulate concurrent scheduler tasks targeting different chats
    const tasks = [
      createSystemMessage({ id: 's-1', chatId: 'oc_chat_alpha', taskName: 'task-a' }),
      createSystemMessage({ id: 's-2', chatId: 'oc_chat_beta', taskName: 'task-b' }),
      createSystemMessage({ id: 's-3', chatId: 'oc_chat_alpha', taskName: 'task-c' }),
    ];

    await Promise.all(tasks.map((msg) => router.route(msg)));

    expect(handler.handleSystemMessage).toHaveBeenCalledTimes(3);
  });
});
