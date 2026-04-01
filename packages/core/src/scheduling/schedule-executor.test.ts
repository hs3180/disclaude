/**
 * Tests for Schedule Executor Factory.
 *
 * Issue #1617 Phase 2/3: Tests for createScheduleExecutor covering
 * agent lifecycle (create → execute → dispose) and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScheduleExecutor, type ScheduleAgent, type ScheduleAgentFactory } from './schedule-executor.js';
import type { SchedulerCallbacks } from './scheduler.js';

function createMockAgent(): ScheduleAgent {
  return {
    executeOnce: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

function createMockCallbacks(): SchedulerCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createScheduleExecutor', () => {
  let agentFactory: ScheduleAgentFactory;
  let callbacks: SchedulerCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
  });

  it('should create a TaskExecutor function', () => {
    agentFactory = vi.fn().mockReturnValue(createMockAgent());
    const executor = createScheduleExecutor({ agentFactory, callbacks });
    expect(typeof executor).toBe('function');
  });

  it('should create agent, execute task, and dispose on success', async () => {
    const mockAgent = createMockAgent();
    agentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({ agentFactory, callbacks });
    await executor('oc_chat_1', 'Do something', 'user_1', 'claude-sonnet');

    expect(agentFactory).toHaveBeenCalledOnce();
    expect(agentFactory).toHaveBeenCalledWith('oc_chat_1', callbacks, 'claude-sonnet');
    expect(mockAgent.executeOnce).toHaveBeenCalledOnce();
    expect(mockAgent.executeOnce).toHaveBeenCalledWith('oc_chat_1', 'Do something', undefined, 'user_1');
    expect(mockAgent.dispose).toHaveBeenCalledOnce();
  });

  it('should dispose agent even when execution fails', async () => {
    const mockAgent = {
      executeOnce: vi.fn().mockRejectedValue(new Error('Execution failed')),
      dispose: vi.fn(),
    };
    agentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({ agentFactory, callbacks });

    await expect(executor('oc_chat_1', 'Do something')).rejects.toThrow('Execution failed');

    expect(mockAgent.dispose).toHaveBeenCalledOnce();
  });

  it('should dispose agent even when dispose throws', async () => {
    const mockAgent = {
      executeOnce: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockImplementation(() => {
        throw new Error('Dispose failed');
      }),
    };
    agentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({ agentFactory, callbacks });

    await expect(executor('oc_chat_1', 'prompt')).rejects.toThrow('Dispose failed');
  });

  it('should pass undefined messageId for scheduled tasks', async () => {
    const mockAgent = createMockAgent();
    agentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({ agentFactory, callbacks });
    await executor('oc_chat_1', 'prompt', 'user_id');

    expect(mockAgent.executeOnce).toHaveBeenCalledWith(
      'oc_chat_1',
      'prompt',
      undefined, // messageId is always undefined for scheduled tasks
      'user_id'
    );
  });

  it('should pass model override to agentFactory', async () => {
    const mockAgent = createMockAgent();
    agentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({ agentFactory, callbacks });
    await executor('oc_chat_1', 'prompt', undefined, 'claude-opus-4');

    expect(agentFactory).toHaveBeenCalledWith('oc_chat_1', callbacks, 'claude-opus-4');
  });

  it('should work without model override', async () => {
    const mockAgent = createMockAgent();
    agentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({ agentFactory, callbacks });
    await executor('oc_chat_1', 'prompt');

    expect(agentFactory).toHaveBeenCalledWith('oc_chat_1', callbacks, undefined);
  });
});
