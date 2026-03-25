/**
 * Tests for Control Handler.
 *
 * Tests command dispatch, error handling, and unknown command handling.
 * @module control/handler.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createControlHandler } from './handler.js';
import type { ControlHandlerContext } from './types.js';

describe('createControlHandler', () => {
  let context: ControlHandlerContext;
  let handler: ReturnType<typeof createControlHandler>;

  beforeEach(() => {
    context = {
      agentPool: {
        reset: vi.fn(),
        stop: vi.fn().mockReturnValue(true),
      },
      node: {
        nodeId: 'node-1',
        getExecNodes: vi.fn().mockReturnValue([]),
        getDebugGroup: vi.fn().mockReturnValue(null),
        clearDebugGroup: vi.fn(),
      },
      passiveMode: {
        isEnabled: vi.fn().mockReturnValue(false),
        setEnabled: vi.fn(),
      },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    };

    handler = createControlHandler(context);
  });

  it('should return error for unknown command type', async () => {
    const result = await handler({ type: 'unknown_command' as any, chatId: 'oc_chat1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown command');
  });

  it('should handle reset command and pass chatId', async () => {
    const result = await handler({ type: 'reset', chatId: 'oc_chat1' });
    expect(result.success).toBe(true);
    expect(context.agentPool.reset).toHaveBeenCalledWith('oc_chat1');
  });

  it('should handle restart command and pass chatId', async () => {
    const result = await handler({ type: 'restart', chatId: 'oc_chat1' });
    expect(result.success).toBe(true);
    expect(context.agentPool.reset).toHaveBeenCalledWith('oc_chat1');
  });

  it('should handle stop command', async () => {
    const result = await handler({ type: 'stop', chatId: 'oc_chat1' });
    expect(result.success).toBe(true);
    expect(context.agentPool.stop).toHaveBeenCalledWith('oc_chat1');
  });

  it('should handle help command', async () => {
    const result = await handler({ type: 'help', chatId: 'oc_chat1' });
    expect(result.success).toBe(true);
  });

  it('should handle status command', async () => {
    const result = await handler({ type: 'status', chatId: 'oc_chat1' });
    expect(result.success).toBe(true);
  });

  it('should handle passive on command', async () => {
    const result = await handler({
      type: 'passive',
      chatId: 'oc_chat1',
      data: { args: ['on'] },
    });
    expect(result.success).toBe(true);
    expect(context.passiveMode?.setEnabled).toHaveBeenCalledWith('oc_chat1', true);
  });

  it('should handle passive off command', async () => {
    const result = await handler({
      type: 'passive',
      chatId: 'oc_chat1',
      data: { args: ['off'] },
    });
    expect(result.success).toBe(true);
    expect(context.passiveMode?.setEnabled).toHaveBeenCalledWith('oc_chat1', false);
  });

  it('should toggle passive mode when no args', async () => {
    context.passiveMode!.isEnabled.mockReturnValue(false);
    const result = await handler({
      type: 'passive',
      chatId: 'oc_chat1',
      data: {},
    });
    expect(result.success).toBe(true);
    expect(context.passiveMode?.setEnabled).toHaveBeenCalledWith('oc_chat1', true);
  });

  it('should return error for invalid passive args', async () => {
    const result = await handler({
      type: 'passive',
      chatId: 'oc_chat1',
      data: { args: ['invalid'] },
    });
    expect(result.success).toBe(false);
  });

  it('should handle list-nodes command', async () => {
    const result = await handler({ type: 'list-nodes', chatId: 'oc_chat1' });
    expect(result.success).toBe(true);
    expect(context.node.getExecNodes).toHaveBeenCalled();
  });
});
