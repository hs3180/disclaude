/**
 * Tests for /passive command handler (Issue #1500)
 */

import { describe, it, expect, vi } from 'vitest';
import { handlePassive } from './passive.js';
import type { ControlHandlerContext } from '../types.js';

/** Create a mock context with a controllable passiveMode */
function createMockContext(enabledInitially = false): ControlHandlerContext {
  let enabled = enabledInitially;
  return {
    agentPool: {
      reset: vi.fn(),
      stop: vi.fn().mockReturnValue(false),
    },
    node: {
      nodeId: 'test-node',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
    },
    passiveMode: {
      isEnabled: vi.fn(() => enabled),
      setEnabled: vi.fn((_: string, val: boolean) => {
        enabled = val;
      }),
    },
  };
}

/**
 * Helper to call handler and unwrap the result (handles both sync and async returns).
 * CommandHandler type allows Promise<ControlResponse> | ControlResponse.
 */
async function callHandler(
  command: Parameters<typeof handlePassive>[0],
  context: Parameters<typeof handlePassive>[1],
) {
  return handlePassive(command, context);
}

describe('handlePassive', () => {
  describe('passiveMode not available', () => {
    it('should return development message when passiveMode is undefined', async () => {
      const context: ControlHandlerContext = {
        agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(false) },
        node: {
          nodeId: 'test',
          getExecNodes: vi.fn().mockReturnValue([]),
          getDebugGroup: vi.fn().mockReturnValue(null),
          clearDebugGroup: vi.fn(),
        },
      };

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat' },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('开发中');
    });
  });

  describe('valid arguments', () => {
    it('should enable passive mode with "on" argument', async () => {
      const context = createMockContext(false);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat', data: { args: 'on' } },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(context.passiveMode!.setEnabled).toHaveBeenCalledWith('test-chat', true);
    });

    it('should disable passive mode with "off" argument', async () => {
      const context = createMockContext(true);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat', data: { args: 'off' } },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(context.passiveMode!.setEnabled).toHaveBeenCalledWith('test-chat', false);
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle from off to on when no argument', async () => {
      const context = createMockContext(false);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat' },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('被动模式已');
      expect(context.passiveMode!.setEnabled).toHaveBeenCalledWith('test-chat', true);
    });

    it('should toggle from on to off when no argument', async () => {
      const context = createMockContext(true);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat' },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('被动模式已');
      expect(context.passiveMode!.setEnabled).toHaveBeenCalledWith('test-chat', false);
    });
  });

  describe('invalid arguments (Issue #1500)', () => {
    it('should reject typo "oon" as invalid argument', async () => {
      const context = createMockContext(false);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat', data: { args: 'oon' } },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(result.message).toContain('/passive [on|off]');
      // Should NOT have called setEnabled (no state change)
      expect(context.passiveMode!.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject "oof" as invalid argument', async () => {
      const context = createMockContext(true);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat', data: { args: 'oof' } },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(context.passiveMode!.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject "yes" as invalid argument', async () => {
      const context = createMockContext(false);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat', data: { args: 'yes' } },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
    });

    it('should reject empty string as invalid argument', async () => {
      const context = createMockContext(false);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat', data: { args: '' } },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
    });

    it('should reject numeric string as invalid argument', async () => {
      const context = createMockContext(false);

      const result = await callHandler(
        { type: 'passive', chatId: 'test-chat', data: { args: '123' } },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
    });
  });
});
