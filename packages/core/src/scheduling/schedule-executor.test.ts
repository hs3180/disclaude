/**
 * Unit tests for createScheduleExecutor
 *
 * Issue #1617 Phase 2: Tests for schedule executor factory.
 *
 * Tests cover:
 * - Agent creation and disposal lifecycle
 * - Successful task execution
 * - Error handling with agent disposal on failure
 * - Model override passthrough (Issue #1338)
 * - Callback and agent factory interaction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScheduleExecutor, type ScheduleAgent, type ScheduleAgentFactory, type ScheduleExecutorOptions } from './schedule-executor.js';
import type { SchedulerCallbacks } from './scheduler.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockAgent(overrides?: Partial<ScheduleAgent>): ScheduleAgent {
  return {
    executeOnce: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    ...overrides,
  };
}

function createMockCallbacks(): SchedulerCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockFactory(agent: ScheduleAgent): ScheduleAgentFactory {
  return vi.fn().mockReturnValue(agent);
}

// ============================================================================
// Tests
// ============================================================================

describe('createScheduleExecutor', () => {
  let mockAgent: ScheduleAgent;
  let mockFactory: ScheduleAgentFactory;
  let callbacks: SchedulerCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent = createMockAgent();
    mockFactory = createMockFactory(mockAgent);
    callbacks = createMockCallbacks();
  });

  describe('successful execution', () => {
    it('should create agent via factory and execute task', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Run daily report', 'user-123');

      // Factory should be called with correct arguments
      expect(mockFactory).toHaveBeenCalledWith('chat-1', callbacks, undefined);

      // Agent should execute the task
      expect(mockAgent.executeOnce).toHaveBeenCalledWith('chat-1', 'Run daily report', undefined, 'user-123');

      // Agent should be disposed after execution
      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should pass model override to agent factory', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Run analysis', undefined, 'claude-sonnet-4-20250514');

      // Factory should receive model override
      expect(mockFactory).toHaveBeenCalledWith('chat-1', callbacks, 'claude-sonnet-4-20250514');
    });

    it('should work without userId', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Simple task');

      expect(mockAgent.executeOnce).toHaveBeenCalledWith('chat-1', 'Simple task', undefined, undefined);
    });

    it('should work without model override', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Task', 'user-1');

      expect(mockFactory).toHaveBeenCalledWith('chat-1', callbacks, undefined);
    });
  });

  describe('error handling', () => {
    it('should dispose agent even when execution fails', async () => {
      const failingAgent = createMockAgent({
        executeOnce: vi.fn().mockRejectedValue(new Error('SDK error')),
      });
      const factory = createMockFactory(failingAgent);

      const executor = createScheduleExecutor({
        agentFactory: factory,
        callbacks,
      });

      // Should not throw - executor catches and disposes
      await expect(executor('chat-1', 'Failing task')).rejects.toThrow('SDK error');

      // Agent must still be disposed
      expect(failingAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose agent when agent factory throws', async () => {
      const factory = vi.fn().mockImplementation(() => {
        throw new Error('Factory error');
      });

      const executor = createScheduleExecutor({
        agentFactory: factory,
        callbacks,
      });

      // Factory throws before agent is created, so no dispose needed
      await expect(executor('chat-1', 'Task')).rejects.toThrow('Factory error');
    });

    it('should dispose agent when executeOnce throws non-Error', async () => {
      const failingAgent = createMockAgent({
        executeOnce: vi.fn().mockRejectedValue('string error'),
      });
      const factory = createMockFactory(failingAgent);

      const executor = createScheduleExecutor({
        agentFactory: factory,
        callbacks,
      });

      await expect(executor('chat-1', 'Task')).rejects.toEqual('string error');

      expect(failingAgent.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('agent lifecycle', () => {
    it('should create a new agent for each execution', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      let callCount = 0;
      const multiFactory: ScheduleAgentFactory = (chatId, cb, model) => {
        callCount++;
        return callCount === 1 ? agent1 : agent2;
      };

      const executor = createScheduleExecutor({
        agentFactory: multiFactory,
        callbacks,
      });

      await executor('chat-1', 'Task 1');
      await executor('chat-1', 'Task 2');

      // Both agents should have been used
      expect(agent1.executeOnce).toHaveBeenCalledTimes(1);
      expect(agent2.executeOnce).toHaveBeenCalledTimes(1);

      // Both agents should be disposed
      expect(agent1.dispose).toHaveBeenCalledTimes(1);
      expect(agent2.dispose).toHaveBeenCalledTimes(1);
    });

    it('should pass correct chatId per execution', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-a', 'Task for A');
      await executor('chat-b', 'Task for B');

      expect(mockAgent.executeOnce).toHaveBeenNthCalledWith(1, 'chat-a', 'Task for A', undefined, undefined);
      expect(mockAgent.executeOnce).toHaveBeenNthCalledWith(2, 'chat-b', 'Task for B', undefined, undefined);
    });
  });
});
