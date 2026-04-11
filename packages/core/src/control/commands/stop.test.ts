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
      getExecNodes: vi.fn(() => []),
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
});

describe('getHandler for stop command', () => {
  it('should return handleStop for type "stop"', async () => {
    const { getHandler } = await import('./index.js');
    const handler = getHandler('stop');
    expect(handler).toBeDefined();
    expect(handler).toBe((await import('./stop.js')).handleStop);
  });
});
