import { describe, it, expect, vi } from 'vitest';
import { handleStop } from './stop.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import type { ControlCommand } from '../../types/channel.js';

describe('handleStop', () => {
  const createMockContext = (overrides: Partial<ControlHandlerContext> = {}): ControlHandlerContext => ({
    agentPool: {
      reset: vi.fn(),
      stop: vi.fn(),
    },
    node: {
      nodeId: 'test-node',
      getDebugGroup: vi.fn(() => null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    ...overrides,
  });

  it('should stop active query and return success message', () => {
    const context = createMockContext({
      agentPool: {
        reset: vi.fn(),
        stop: vi.fn(() => true),
      },
    });

    const command: ControlCommand = {
      type: 'stop',
      chatId: 'test-chat-id',
    };

    const handler: CommandHandler = handleStop;
    const result = handler(command, context);

    // handleStop returns ControlResponse synchronously
    if (result instanceof Promise) {
      throw new Error('Expected synchronous result');
    }

    expect(result.success).toBe(true);
    expect(result.message).toContain('已停止当前响应');
    expect(context.agentPool.stop).toHaveBeenCalledWith('test-chat-id');
  });

  it('should return info message when no active query', () => {
    const context = createMockContext({
      agentPool: {
        reset: vi.fn(),
        stop: vi.fn(() => false),
      },
    });

    const command: ControlCommand = {
      type: 'stop',
      chatId: 'test-chat-id',
    };

    const handler: CommandHandler = handleStop;
    const result = handler(command, context);

    if (result instanceof Promise) {
      throw new Error('Expected synchronous result');
    }

    expect(result.success).toBe(true);
    expect(result.message).toContain('没有正在进行的响应');
    expect(context.agentPool.stop).toHaveBeenCalledWith('test-chat-id');
  });

  it('should preserve session state (not call reset)', () => {
    const context = createMockContext({
      agentPool: {
        reset: vi.fn(),
        stop: vi.fn(() => true),
      },
    });

    const command: ControlCommand = {
      type: 'stop',
      chatId: 'test-chat-id',
    };

    void handleStop(command, context);

    expect(context.agentPool.reset).not.toHaveBeenCalled();
  });

  it('should stop the thread slot when threadRootId is set (Issue #4587 part 3)', () => {
    const stopThread = vi.fn(() => true);
    const context = createMockContext({
      agentPool: {
        reset: vi.fn(),
        stop: vi.fn(() => false),
        stopThread,
      },
    });

    const result = handleStop({ type: 'stop', chatId: 'test-chat-id', threadRootId: 'om_root' }, context);

    if (result instanceof Promise) {
      throw new Error('Expected synchronous result');
    }

    expect(result.success).toBe(true);
    expect(result.message).toContain('已停止当前响应');
    expect(stopThread).toHaveBeenCalledWith('test-chat-id', 'om_root');
    // The chat-scoped agent must NOT be stopped
    expect(context.agentPool.stop).not.toHaveBeenCalled();
  });

  it('should fall back to chat-scoped stop when stopThread is unavailable (Issue #4587 part 3)', () => {
    const context = createMockContext({
      agentPool: {
        reset: vi.fn(),
        stop: vi.fn(() => true),
        // no stopThread — a pre-part-3 pool implementation
      },
    });

    const result = handleStop({ type: 'stop', chatId: 'test-chat-id', threadRootId: 'om_root' }, context);

    if (result instanceof Promise) {
      throw new Error('Expected synchronous result');
    }

    expect(result.success).toBe(true);
    expect(context.agentPool.stop).toHaveBeenCalledWith('test-chat-id');
  });
});

describe('getHandler for stop command', () => {
  it('should return handleStop for type "stop"', async () => {
    const { getHandler } = await import('./index.js');
    const handler = getHandler('stop');
    expect(handler).toBeDefined();
    expect(handler).toBe((await import('./stop.js')).handleStop);
  });
});
