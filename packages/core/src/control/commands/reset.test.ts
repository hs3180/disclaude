/**
 * Unit tests for reset/restart control commands.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 * Issue #3807: /restart now triggers process shutdown instead of agent reset.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleReset, handleRestart } from './reset.js';
import type { ControlHandlerContext } from '../types.js';
import type { ControlResponse } from '../../types/channel.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'node-1',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    ...overrides,
  };
}

describe('handleReset', () => {
  it('should reset agent pool for the given chatId (Issue #3570: dispose + recreate)', async () => {
    const context = createMockContext();
    const result = await handleReset({ type: 'reset', chatId: 'chat-123' }, context);

    expect(result.success).toBe(true);
    // reset() now internally calls dispose() to fully recycle the agent
    expect(context.agentPool.reset).toHaveBeenCalledWith('chat-123', undefined);
    expect(result.message).toContain('对话已重置');
  });

  it('should pass skipContext when --no-context flag is set (Issue #3696)', async () => {
    const context = createMockContext();
    const result = await handleReset(
      { type: 'reset', chatId: 'chat-123', data: { skipContext: true } },
      context,
    );

    expect(result.success).toBe(true);
    expect(context.agentPool.reset).toHaveBeenCalledWith('chat-123', true);
    expect(result.message).toContain('历史上下文已跳过');
  });
});

describe('handleRestart', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delay shutdown by 2s to allow response to be sent (Issue #3807)', () => {
    vi.useFakeTimers();
    const mockShutdown = vi.fn().mockResolvedValue(undefined);
    const context = createMockContext({ shutdown: mockShutdown });

    const result = handleRestart({ type: 'restart', chatId: 'chat-456' }, context) as ControlResponse;

    // Response is immediate
    expect(result.success).toBe(true);
    expect(result.message).toContain('服务正在重启');
    // Shutdown NOT called yet — delayed to allow response delivery
    expect(mockShutdown).not.toHaveBeenCalled();

    // After 2s delay, shutdown fires
    vi.advanceTimersByTime(2000);
    expect(mockShutdown).toHaveBeenCalled();
    // Should NOT call agentPool.reset — that's /reset's job
    expect(context.agentPool.reset).not.toHaveBeenCalled();
  });

  it('should fall back to process.exit(0) after 2s when no shutdown handler (Issue #3807)', () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const context = createMockContext(); // no shutdown

    const result = handleRestart({ type: 'restart', chatId: 'chat-789' }, context) as ControlResponse;

    expect(result.success).toBe(true);
    // process.exit NOT called yet
    expect(exitSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it('should not call agentPool.reset — /restart is different from /reset', () => {
    vi.useFakeTimers();
    const mockShutdown = vi.fn().mockResolvedValue(undefined);
    const context = createMockContext({ shutdown: mockShutdown });
    void handleRestart({ type: 'restart', chatId: 'chat-999' }, context);

    expect(context.agentPool.reset).not.toHaveBeenCalled();

    // Advance timers to fire the pending shutdown so it doesn't leak
    vi.advanceTimersByTime(2000);
  });
});
