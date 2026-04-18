/**
 * Tests for schedule executor factory.
 *
 * Verifies the createScheduleExecutor factory function:
 * - Creates executor from agent factory and callbacks
 * - Executor creates and disposes agents properly
 * - Error handling and cleanup on failure
 * - Model override passing (Issue #1338)
 *
 * Issue #1617: Phase 2 - scheduling module test coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createScheduleExecutor,
  type TaskAgent,
  type TaskAgentFactory,
} from './schedule-executor.js';
import type { SchedulerCallbacks } from './scheduler.js';

describe('createScheduleExecutor', () => {
  let mockAgent: TaskAgent;
  let mockAgentFactory: TaskAgentFactory;
  let mockCallbacks: SchedulerCallbacks;

  beforeEach(() => {
    mockAgent = {
      executeOnce: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };

    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('basic execution', () => {
    it('should create an executor function', () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      expect(typeof executor).toBe('function');
    });

    it('should create agent via factory when executing', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'Run tests');

      expect(mockAgentFactory).toHaveBeenCalledTimes(1);
      expect(mockAgentFactory).toHaveBeenCalledWith('chat-1', mockCallbacks, undefined);
    });

    it('should call executeOnce with correct arguments', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'Run tests', 'user-42');

      expect(mockAgent.executeOnce).toHaveBeenCalledTimes(1);
      expect(mockAgent.executeOnce).toHaveBeenCalledWith('chat-1', 'Run tests', undefined, 'user-42');
    });

    it('should dispose agent after successful execution', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'Run tests');

      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose agent even when execution fails', async () => {
      vi.mocked(mockAgent.executeOnce).mockRejectedValue(new Error('Execution failed'));

      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await expect(executor('chat-1', 'Run tests')).rejects.toThrow('Execution failed');

      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose agent when executeOnce throws non-Error', async () => {
      vi.mocked(mockAgent.executeOnce).mockRejectedValue('string error');

      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await expect(executor('chat-1', 'Run tests')).rejects.toBe('string error');

      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('model override (Issue #1338)', () => {
    it('should pass model override to agent factory', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'Run tests', 'user-1', 'claude-sonnet-4-20250514');

      expect(mockAgentFactory).toHaveBeenCalledWith('chat-1', mockCallbacks, 'claude-sonnet-4-20250514');
    });

    it('should pass undefined model when not specified', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'Run tests');

      expect(mockAgentFactory).toHaveBeenCalledWith('chat-1', mockCallbacks, undefined);
    });
  });

  describe('multiple executions', () => {
    it('should create a new agent for each execution', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'Task 1');
      await executor('chat-2', 'Task 2');

      expect(mockAgentFactory).toHaveBeenCalledTimes(2);
      expect(mockAgent.dispose).toHaveBeenCalledTimes(2);
    });

    it('should handle sequential executions correctly', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockAgentFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'First');
      await executor('chat-1', 'Second');

      expect(mockAgent.executeOnce).toHaveBeenCalledTimes(2);
    });
  });
});
