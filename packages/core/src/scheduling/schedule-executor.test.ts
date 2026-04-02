/**
 * Tests for Schedule Executor (packages/core/src/scheduling/schedule-executor.ts)
 *
 * Issue #1617 Phase 2: Tests for the executor factory that creates short-lived
 * agents for scheduled task execution. Covers agent lifecycle, error handling,
 * and model override passing.
 */

import { describe, it, expect, vi } from 'vitest';
import { createScheduleExecutor } from './schedule-executor.js';
import type { ScheduleAgent, ScheduleAgentFactory } from './schedule-executor.js';
import type { SchedulerCallbacks } from './scheduler.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock ScheduleAgent. */
function createMockAgent(shouldFail = false): ScheduleAgent {
  return {
    executeOnce: vi.fn().mockImplementation(async (_chatId, _prompt, _messageId, _userId) => {
      if (shouldFail) {
        throw new Error('Agent execution failed');
      }
    }),
    dispose: vi.fn(),
  };
}

/** Create mock callbacks. */
function createMockCallbacks(): SchedulerCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock agent factory that returns the given agent. */
function createMockFactory(agent: ScheduleAgent): ScheduleAgentFactory {
  return vi.fn().mockReturnValue(agent);
}

// ============================================================================
// Tests
// ============================================================================

describe('createScheduleExecutor', () => {
  // -------------------------------------------------------------------------
  // Factory function
  // -------------------------------------------------------------------------
  describe('factory function', () => {
    it('should return a TaskExecutor function', () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      expect(typeof executorFn).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // Agent lifecycle
  // -------------------------------------------------------------------------
  describe('agent lifecycle', () => {
    it('should create an agent via the factory on each execution', async () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);
      const callbacks = createMockCallbacks();

      const executorFn = createScheduleExecutor({ agentFactory: factory, callbacks });

      await executorFn('oc_chat1', 'Do something');

      expect(factory).toHaveBeenCalledExactlyOnceWith('oc_chat1', callbacks, undefined);
    });

    it('should pass model override to the factory', async () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);
      const callbacks = createMockCallbacks();

      const executorFn = createScheduleExecutor({ agentFactory: factory, callbacks });

      await executorFn('oc_chat1', 'Do something', 'ou_user123', 'claude-opus-4-20250514');

      expect(factory).toHaveBeenCalledWith('oc_chat1', callbacks, 'claude-opus-4-20250514');
    });

    it('should call agent.executeOnce with correct arguments', async () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      await executorFn('oc_chat1', 'Run this task', 'ou_user456');

      expect(agent.executeOnce).toHaveBeenCalledExactlyOnceWith(
        'oc_chat1',
        'Run this task',
        undefined, // messageId is always undefined for scheduled tasks
        'ou_user456'
      );
    });

    it('should dispose the agent after successful execution', async () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      await executorFn('oc_chat1', 'Task prompt');

      expect(agent.dispose).toHaveBeenCalledOnce();
    });

    it('should always dispose the agent even if execution fails', async () => {
      const agent = createMockAgent(true); // Will fail
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      await expect(executorFn('oc_chat1', 'Failing task')).rejects.toThrow('Agent execution failed');
      expect(agent.dispose).toHaveBeenCalledOnce();
    });

    it('should dispose the agent even if executeOnce throws a non-Error', async () => {
      const agent: ScheduleAgent = {
        executeOnce: vi.fn().mockRejectedValue('string error'),
        dispose: vi.fn(),
      };
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      await expect(executorFn('oc_chat1', 'Task')).rejects.toEqual('string error');
      expect(agent.dispose).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple executions
  // -------------------------------------------------------------------------
  describe('multiple executions', () => {
    it('should create a new agent for each execution', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      const factory = vi.fn()
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      await executorFn('oc_chat1', 'Task 1');
      await executorFn('oc_chat2', 'Task 2');

      expect(factory).toHaveBeenCalledTimes(2);
      expect(agent1.dispose).toHaveBeenCalledOnce();
      expect(agent2.dispose).toHaveBeenCalledOnce();
    });

    it('should dispose each agent independently', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent(true); // Will fail
      const factory = vi.fn()
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      // First succeeds
      await executorFn('oc_chat1', 'Success task');
      expect(agent1.dispose).toHaveBeenCalledOnce();
      expect(agent2.dispose).not.toHaveBeenCalled();

      // Second fails
      await expect(executorFn('oc_chat2', 'Fail task')).rejects.toThrow();
      expect(agent2.dispose).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Argument passing
  // -------------------------------------------------------------------------
  describe('argument passing', () => {
    it('should pass userId to executeOnce', async () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      await executorFn('oc_chat1', 'Task', 'ou_creator');

      expect(agent.executeOnce).toHaveBeenCalledWith(
        'oc_chat1',
        'Task',
        undefined,
        'ou_creator'
      );
    });

    it('should handle undefined userId', async () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      await executorFn('oc_chat1', 'Task');

      expect(agent.executeOnce).toHaveBeenCalledWith(
        'oc_chat1',
        'Task',
        undefined,
        undefined
      );
    });

    it('should pass the wrapped prompt from scheduler to executeOnce', async () => {
      const agent = createMockAgent();
      const factory = createMockFactory(agent);

      const executorFn = createScheduleExecutor({
        agentFactory: factory,
        callbacks: createMockCallbacks(),
      });

      const wrappedPrompt = `⚠️ **Scheduled Task Execution Context**

You are executing a scheduled task named "Daily Report".

**IMPORTANT RULES:**
1. Do NOT create new scheduled tasks
2. Do NOT modify existing scheduled tasks
3. Focus on completing the task described below
4. If you need to run something periodically, report this need to the user instead

Scheduled task creation is blocked during scheduled task execution to prevent infinite recursion.

---

**Task Prompt:**
Generate daily summary report`;

      await executorFn('oc_chat1', wrappedPrompt, 'ou_user');

      expect(agent.executeOnce).toHaveBeenCalledWith(
        'oc_chat1',
        wrappedPrompt,
        undefined,
        'ou_user'
      );
    });
  });
});
