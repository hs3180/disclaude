/**
 * Unit tests for ScheduleExecutor (schedule-executor.ts)
 *
 * Tests the createScheduleExecutor factory function:
 * - Agent lifecycle: create -> execute -> dispose
 * - Error handling: dispose even on failure
 * - Model override passthrough
 * - Callback passthrough to agent factory
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createScheduleExecutor,
  type ScheduleAgent,
  type ScheduleAgentFactory,
  type SchedulerCallbacks,
} from './schedule-executor.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockCallbacks(): SchedulerCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAgent(overrides: Partial<ScheduleAgent> = {}): ScheduleAgent {
  return {
    executeOnce: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createScheduleExecutor', () => {
  let mockAgentFactory: ScheduleAgentFactory;
  let mockCallbacks: SchedulerCallbacks;

  beforeEach(() => {
    mockCallbacks = createMockCallbacks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a TaskExecutor function', () => {
    mockAgentFactory = vi.fn().mockReturnValue(createMockAgent());

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    expect(typeof executor).toBe('function');
  });

  it('should create agent via factory and execute the task', async () => {
    const mockAgent = createMockAgent();
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_test', 'Do something', 'user_123');

    // Factory should be called with chatId, callbacks, and model (undefined)
    expect(mockAgentFactory).toHaveBeenCalledWith('oc_test', mockCallbacks, undefined);

    // Agent should execute with correct parameters
    expect(mockAgent.executeOnce).toHaveBeenCalledWith(
      'oc_test',
      'Do something',
      undefined,
      'user_123'
    );
  });

  it('should always dispose agent after successful execution', async () => {
    const mockAgent = createMockAgent();
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_test', 'prompt');

    expect(mockAgent.dispose).toHaveBeenCalledOnce();
  });

  it('should always dispose agent even when execution throws', async () => {
    const mockAgent = createMockAgent({
      executeOnce: vi.fn().mockRejectedValue(new Error('Agent crashed')),
    });
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await expect(executor('oc_test', 'prompt')).rejects.toThrow('Agent crashed');

    // Dispose should still be called
    expect(mockAgent.dispose).toHaveBeenCalledOnce();
  });

  it('should pass model override to agent factory', async () => {
    const mockAgent = createMockAgent();
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_test', 'prompt', 'user_1', 'claude-sonnet-4-20250514');

    expect(mockAgentFactory).toHaveBeenCalledWith(
      'oc_test',
      mockCallbacks,
      'claude-sonnet-4-20250514'
    );
  });

  it('should pass userId correctly to executeOnce', async () => {
    const mockAgent = createMockAgent();
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_chat', 'test prompt', 'ou_user456');

    expect(mockAgent.executeOnce).toHaveBeenCalledWith(
      'oc_chat',
      'test prompt',
      undefined,  // messageId is always undefined for scheduled tasks
      'ou_user456'
    );
  });

  it('should handle execution without userId', async () => {
    const mockAgent = createMockAgent();
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_chat', 'test prompt');

    expect(mockAgent.executeOnce).toHaveBeenCalledWith(
      'oc_chat',
      'test prompt',
      undefined,
      undefined
    );
  });

  it('should create new agent for each execution', async () => {
    const mockAgent1 = createMockAgent();
    const mockAgent2 = createMockAgent();
    let callCount = 0;
    mockAgentFactory = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? mockAgent1 : mockAgent2;
    });

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await executor('oc_test', 'prompt1');
    await executor('oc_test', 'prompt2');

    expect(mockAgentFactory).toHaveBeenCalledTimes(2);
    expect(mockAgent1.dispose).toHaveBeenCalledOnce();
    expect(mockAgent2.dispose).toHaveBeenCalledOnce();
  });

  it('should dispose agent even when dispose itself throws', async () => {
    const mockAgent = createMockAgent({
      executeOnce: vi.fn().mockRejectedValue(new Error('Execution error')),
      dispose: vi.fn().mockImplementation(() => {
        throw new Error('Dispose error');
      }),
    });
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    // In try/finally, the finally block error overrides the try block error
    await expect(executor('oc_test', 'prompt')).rejects.toThrow('Dispose error');
    // Verify dispose was still called
    expect(mockAgent.dispose).toHaveBeenCalledOnce();
  });

  it('should propagate agent execution errors', async () => {
    const mockAgent = createMockAgent({
      executeOnce: vi.fn().mockRejectedValue(new Error('Task failed')),
    });
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await expect(executor('oc_test', 'prompt')).rejects.toThrow('Task failed');
  });

  it('should handle non-Error rejections from executeOnce', async () => {
    const mockAgent = createMockAgent({
      executeOnce: vi.fn().mockRejectedValue('string error'),
    });
    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);

    const executor = createScheduleExecutor({
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
    });

    await expect(executor('oc_test', 'prompt')).rejects.toEqual('string error');
  });
});
