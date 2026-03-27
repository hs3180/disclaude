/**
 * Tests for ScheduleExecutor factory.
 *
 * Tests the createScheduleExecutor function, including:
 * - Agent creation and disposal lifecycle
 * - Executor delegation to agent.executeOnce()
 * - Proper cleanup on success
 * - Proper cleanup on error
 * - Model override passing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScheduleExecutor } from './schedule-executor.js';
import type { ScheduleAgent, ScheduleAgentFactory, ScheduleExecutorOptions } from './schedule-executor.js';
import type { SchedulerCallbacks } from './scheduler.js';

describe('createScheduleExecutor', () => {
  let mockCallbacks: SchedulerCallbacks;
  let mockAgent: ScheduleAgent;
  let mockAgentFactory: ScheduleAgentFactory;
  let executorOptions: ScheduleExecutorOptions;

  beforeEach(() => {
    mockAgent = {
      executeOnce: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };

    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    executorOptions = {
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    };
  });

  describe('basic execution', () => {
    it('should create an executor function', () => {
      const executor = createScheduleExecutor(executorOptions);
      expect(typeof executor).toBe('function');
    });

    it('should create an agent via factory when executing', async () => {
      const executor = createScheduleExecutor(executorOptions);
      await executor('chat-001', 'Test prompt', 'user-123');

      expect(mockAgentFactory).toHaveBeenCalledOnce();
    });

    it('should pass chatId and callbacks to agent factory', async () => {
      const executor = createScheduleExecutor(executorOptions);
      await executor('chat-001', 'Test prompt', 'user-123');

      expect(mockAgentFactory).toHaveBeenCalledWith(
        'chat-001',
        mockCallbacks,
        undefined, // no model override
      );
    });

    it('should call executeOnce on the agent with correct arguments', async () => {
      const executor = createScheduleExecutor(executorOptions);
      await executor('chat-001', 'Test prompt', 'user-123');

      expect(mockAgent.executeOnce).toHaveBeenCalledWith(
        'chat-001',
        'Test prompt',
        undefined, // messageId is always undefined for scheduled tasks
        'user-123',
      );
    });

    it('should dispose the agent after successful execution', async () => {
      const executor = createScheduleExecutor(executorOptions);
      await executor('chat-001', 'Test prompt');

      expect(mockAgent.dispose).toHaveBeenCalledOnce();
    });
  });

  describe('error handling', () => {
    it('should dispose the agent even when executeOnce throws', async () => {
      mockAgent.executeOnce = vi.fn().mockRejectedValue(new Error('Agent failed'));

      const executor = createScheduleExecutor(executorOptions);

      await expect(executor('chat-001', 'Test prompt')).rejects.toThrow('Agent failed');

      expect(mockAgent.dispose).toHaveBeenCalledOnce();
    });

    it('should dispose the agent even when executeOnce rejects with non-Error', async () => {
      mockAgent.executeOnce = vi.fn().mockRejectedValue('string error');

      const executor = createScheduleExecutor(executorOptions);

      await expect(executor('chat-001', 'Test prompt')).rejects.toBe('string error');

      expect(mockAgent.dispose).toHaveBeenCalledOnce();
    });
  });

  describe('model override', () => {
    it('should pass model override to agent factory', async () => {
      const executor = createScheduleExecutor(executorOptions);
      await executor('chat-001', 'Test prompt', 'user-123', 'claude-sonnet-4-20250514');

      expect(mockAgentFactory).toHaveBeenCalledWith(
        'chat-001',
        mockCallbacks,
        'claude-sonnet-4-20250514',
      );
    });

    it('should pass undefined model when not provided', async () => {
      const executor = createScheduleExecutor(executorOptions);
      await executor('chat-001', 'Test prompt');

      expect(mockAgentFactory).toHaveBeenCalledWith(
        'chat-001',
        mockCallbacks,
        undefined,
      );
    });
  });

  describe('multiple executions', () => {
    it('should create a new agent for each execution', async () => {
      const executor = createScheduleExecutor(executorOptions);
      await executor('chat-001', 'Prompt 1');
      await executor('chat-002', 'Prompt 2');

      expect(mockAgentFactory).toHaveBeenCalledTimes(2);
      expect(mockAgent.dispose).toHaveBeenCalledTimes(2);
    });

    it('should create independent agents that do not share state', async () => {
      const callLog: string[] = [];
      const trackingFactory: ScheduleAgentFactory = (chatId, _callbacks, _model) => ({
        executeOnce: vi.fn().mockImplementation(async (cid) => {
          callLog.push(`execute:${cid}`);
        }),
        dispose: vi.fn().mockImplementation(() => {
          callLog.push(`dispose:${chatId}`);
        }),
      });

      const executor = createScheduleExecutor({
        agentFactory: trackingFactory,
        callbacks: mockCallbacks,
      });

      await executor('chat-1', 'Prompt 1');
      await executor('chat-2', 'Prompt 2');

      expect(callLog).toEqual([
        'execute:chat-1',
        'dispose:chat-1',
        'execute:chat-2',
        'dispose:chat-2',
      ]);
    });
  });
});
