/**
 * Unit tests for Schedule Executor Factory.
 *
 * Tests the createScheduleExecutor factory function that creates
 * short-lived agents for scheduled task execution.
 *
 * Issue #1382: Unified executor implementation for Primary Node and Worker Node.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScheduleExecutor, type ScheduleAgent, type ScheduleAgentFactory } from './schedule-executor.js';
import type { SchedulerCallbacks } from './scheduler.js';

describe('Schedule Executor', () => {
  let mockAgent: ScheduleAgent;
  let mockFactory: ScheduleAgentFactory;
  let callbacks: SchedulerCallbacks;

  beforeEach(() => {
    mockAgent = {
      executeOnce: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
    mockFactory = vi.fn().mockReturnValue(mockAgent);
    callbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('createScheduleExecutor', () => {
    it('should return a TaskExecutor function', () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      expect(typeof executor).toBe('function');
    });

    it('should create an agent using the factory when executing', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Run task');

      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(mockFactory).toHaveBeenCalledWith('chat-1', callbacks, undefined);
    });

    it('should call executeOnce on the agent with correct params', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Run this task', 'user-123');

      expect(mockAgent.executeOnce).toHaveBeenCalledTimes(1);
      expect(mockAgent.executeOnce).toHaveBeenCalledWith('chat-1', 'Run this task', undefined, 'user-123');
    });

    it('should pass model override to factory', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Task', 'user-1', 'claude-haiku-4-20250414');

      expect(mockFactory).toHaveBeenCalledWith('chat-1', callbacks, 'claude-haiku-4-20250414');
    });

    it('should dispose the agent after successful execution', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Task');

      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose the agent even when executeOnce throws', async () => {
      mockAgent.executeOnce = vi.fn().mockRejectedValue(new Error('Execution failed'));

      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await expect(executor('chat-1', 'Task')).rejects.toThrow('Execution failed');

      expect(mockAgent.dispose).toHaveBeenCalledTimes(1);
    });

    it('should create a new agent for each execution', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Task 1');
      await executor('chat-1', 'Task 2');

      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect(mockAgent.dispose).toHaveBeenCalledTimes(2);
    });

    it('should handle execution without userId', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Task');

      expect(mockAgent.executeOnce).toHaveBeenCalledWith('chat-1', 'Task', undefined, undefined);
    });

    it('should always pass undefined as messageId to executeOnce', async () => {
      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await executor('chat-1', 'Task', 'user-1');

      // messageId (3rd arg) is always undefined for scheduled tasks
      expect(mockAgent.executeOnce).toHaveBeenCalledWith(
        'chat-1',
        'Task',
        undefined, // messageId
        'user-1'
      );
    });

    it('should propagate execution errors', async () => {
      const error = new Error('Agent SDK error');
      mockAgent.executeOnce = vi.fn().mockRejectedValue(error);

      const executor = createScheduleExecutor({
        agentFactory: mockFactory,
        callbacks,
      });

      await expect(executor('chat-1', 'Task')).rejects.toThrow('Agent SDK error');
    });
  });
});
