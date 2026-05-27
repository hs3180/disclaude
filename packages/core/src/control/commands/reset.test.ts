/**
 * Unit tests for reset/restart control commands.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 * Issue #3807: /restart now triggers process shutdown instead of agent reset.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleReset, handleRestart } from './reset.js';
import type { ControlHandlerContext } from '../types.js';

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
  it('should call shutdown to restart the entire service process (Issue #3807)', async () => {
    const mockShutdown = vi.fn().mockResolvedValue(undefined);
    const context = createMockContext({ shutdown: mockShutdown });
    const result = await handleRestart({ type: 'restart', chatId: 'chat-456' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('服务正在重启');
    expect(mockShutdown).toHaveBeenCalled();
    // Should NOT call agentPool.reset — that's /reset's job
    expect(context.agentPool.reset).not.toHaveBeenCalled();
  });

  it('should fall back to process.exit(0) when no shutdown handler (Issue #3807)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const context = createMockContext(); // no shutdown
    const result = await handleRestart({ type: 'restart', chatId: 'chat-789' }, context);

    expect(result.success).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('should not call agentPool.reset — /restart is different from /reset', async () => {
    const mockShutdown = vi.fn().mockResolvedValue(undefined);
    const context = createMockContext({ shutdown: mockShutdown });
    await handleRestart({ type: 'restart', chatId: 'chat-999' }, context);

    expect(context.agentPool.reset).not.toHaveBeenCalled();
  });
});
