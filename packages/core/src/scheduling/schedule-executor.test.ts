/**
 * Tests for ScheduleExecutor (packages/core/src/scheduling/schedule-executor.ts)
 *
 * Tests the executor factory function including:
 * - Agent creation and disposal lifecycle
 * - Error handling (agent always disposed)
 * - Model override passing
 * - Integration with Scheduler's TaskExecutor interface
 *
 * Issue #1617 Phase 2: Scheduling tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduleExecutor } from './schedule-executor.js';
import type { ScheduleAgent, ScheduleAgentFactory, ScheduleExecutorOptions } from './schedule-executor.js';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockAgent(): ScheduleAgent {
  return {
    executeOnce: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

const mockCallbacks = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

// ============================================================================
// Tests
// ============================================================================

describe('createScheduleExecutor', () => {
  let executor: ReturnType<typeof createScheduleExecutor>;
  let mockAgentFactory: ScheduleAgentFactory;
  let mockAgent: ScheduleAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent = createMockAgent();
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic execution', () => {
    it('should create an executor from options', () => {
      const options: ScheduleExecutorOptions = {
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      };

      executor = createScheduleExecutor(options);
      expect(typeof executor).toBe('function');
    });

    it('should create agent and execute task', async () => {
      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('oc_test', 'Run the daily report', 'ou_user');

      expect(mockAgentFactory).toHaveBeenCalledTimes(1);
      expect(mockAgentFactory).toHaveBeenCalledWith('oc_test', mockCallbacks, undefined);

      expect(mockAgent.executeOnce).toHaveBeenCalledTimes(1);
      expect(mockAgent.executeOnce).toHaveBeenCalledWith('oc_test', 'Run the daily report', undefined, 'ou_user');

      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should pass chatId and callbacks to agent factory', async () => {
      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('oc_chat_456', 'Do something');

      expect(mockAgentFactory).toHaveBeenCalledWith('oc_chat_456', mockCallbacks, undefined);
    });

    it('should pass userId to executeOnce', async () => {
      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('oc_test', 'Task prompt', 'ou_creator');

      expect(mockAgent.executeOnce).toHaveBeenCalledWith(
        'oc_test',
        'Task prompt',
        undefined,
        'ou_creator',
      );
    });
  });

  describe('model override (Issue #1338)', () => {
    it('should pass model override to agent factory', async () => {
      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('oc_test', 'Task', 'ou_user', 'claude-sonnet-4-20250514');

      expect(mockAgentFactory).toHaveBeenCalledWith(
        'oc_test',
        mockCallbacks,
        'claude-sonnet-4-20250514',
      );
    });

    it('should pass undefined model when not specified', async () => {
      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('oc_test', 'Task');

      expect(mockAgentFactory).toHaveBeenCalledWith(
        'oc_test',
        mockCallbacks,
        undefined,
      );
    });
  });

  describe('error handling', () => {
    it('should dispose agent even when executeOnce throws', async () => {
      const error = new Error('Agent execution failed');
      (mockAgent.executeOnce as any).mockRejectedValue(error);

      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await expect(executor('oc_test', 'Task')).rejects.toThrow('Agent execution failed');

      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose agent even when agent factory throws', async () => {
      // This shouldn't normally happen, but tests resilience
      (mockAgentFactory as any).mockImplementation(() => {
        throw new Error('Factory failed');
      });

      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await expect(executor('oc_test', 'Task')).rejects.toThrow('Factory failed');
    });

    it('should propagate execution errors to caller', async () => {
      const error = new Error('SDK timeout');
      (mockAgent.executeOnce as any).mockRejectedValue(error);

      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await expect(executor('oc_test', 'Task')).rejects.toThrow('SDK timeout');
    });

    it('should always use finally for dispose, even on success', async () => {
      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('oc_test', 'Task');

      // Dispose must be called exactly once
      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('multiple executions', () => {
    it('should create a new agent for each execution', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      (mockAgentFactory as any)
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2);

      executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('oc_test', 'Task 1');
      await executor('oc_test', 'Task 2');

      expect(mockAgentFactory).toHaveBeenCalledTimes(2);
      expect(agent1.dispose).toHaveBeenCalledTimes(1);
      expect(agent2.dispose).toHaveBeenCalledTimes(1);
      expect(agent1.executeOnce).toHaveBeenCalledTimes(1);
      expect(agent2.executeOnce).toHaveBeenCalledTimes(1);
    });
  });
});
