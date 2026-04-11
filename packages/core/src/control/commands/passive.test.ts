/**
 * Tests for /passive and /trigger command handlers (packages/core/src/control/commands/passive.ts)
 * Issue #2193: /trigger is the new name, /passive is kept as alias
 */

import { describe, it, expect, vi } from 'vitest';
import { handlePassive, handleTrigger } from './passive.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

/** 创建测试用的 control command */
function createCommand(type: 'passive' | 'trigger', args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type,
    chatId,
    data: args !== undefined ? { args } : undefined,
  };
}

/** 创建测试用的 handler context */
function createContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn() },
    node: {
      nodeId: 'test-node',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    triggerMode: {
      isEnabled: vi.fn().mockReturnValue(false),
      setEnabled: vi.fn(),
    },
    ...overrides,
  };
}

describe('handlePassive', () => {
  describe('triggerMode not available', () => {
    it('should return failure when both triggerMode and passiveMode are undefined', () => {
      const command = createCommand('passive');
      const mockWarn = vi.fn();
      const context = createContext({ triggerMode: undefined, passiveMode: undefined, logger: { warn: mockWarn } as unknown as ControlHandlerContext['logger'] });

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('不可用');
      expect(mockWarn).toHaveBeenCalledWith(
        { chatId: 'test-chat-id' },
        '/passive command received but triggerMode is not configured'
      );
    });

    it('should fall back to passiveMode when triggerMode is undefined (Issue #2193 backward compat)', () => {
      const command = createCommand('passive', 'on');
      const mockSetEnabled = vi.fn();
      const context = createContext({
        triggerMode: undefined,
        passiveMode: {
          isEnabled: vi.fn().mockReturnValue(false),
          setEnabled: mockSetEnabled,
        },
      });

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(mockSetEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });
  });

  describe('valid arguments', () => {
    it('should enable passive mode with "on" argument', () => {
      const command = createCommand('passive', 'on');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should disable passive mode with "off" argument', () => {
      const command = createCommand('passive', 'off');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });

    // Issue #1562: Feishu message handler passes args as string[], not string
    it('should enable passive mode when args is passed as array (Feishu format)', () => {
      const command = createCommand('passive', ['on']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should disable passive mode when args is passed as array (Feishu format)', () => {
      const command = createCommand('passive', ['off']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle from off to on when no argument provided', () => {
      const command = createCommand('passive');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.isEnabled = vi.fn().mockReturnValue(false);

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should toggle from on to off when no argument provided', () => {
      const command = createCommand('passive');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.isEnabled = vi.fn().mockReturnValue(true);

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });
  });

  describe('invalid arguments', () => {
    it('should reject typo "oon"', () => {
      const command = createCommand('passive', 'oon');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject typo "oof"', () => {
      const command = createCommand('passive', 'oof');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject random string "yes"', () => {
      const command = createCommand('passive', 'yes');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject numeric string "123"', () => {
      const command = createCommand('passive', '123');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should show usage hint with both /passive and /trigger in error message', () => {
      const command = createCommand('passive', 'invalid');
      const context = createContext();

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.message).toContain('/passive');
      expect(result.message).toContain('/trigger');
    });
  });
});

describe('handleTrigger (Issue #2193)', () => {
  describe('triggerMode not available', () => {
    it('should return failure when both triggerMode and passiveMode are undefined', () => {
      const command = createCommand('trigger');
      const mockWarn = vi.fn();
      const context = createContext({ triggerMode: undefined, passiveMode: undefined, logger: { warn: mockWarn } as unknown as ControlHandlerContext['logger'] });

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('不可用');
      expect(mockWarn).toHaveBeenCalledWith(
        { chatId: 'test-chat-id' },
        '/trigger command received but triggerMode is not configured'
      );
    });
  });

  describe('valid arguments', () => {
    it('should enable trigger mode (mention only) with "on"', () => {
      const command = createCommand('trigger', 'on');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('@触发');
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should disable trigger mode (respond to all) with "off"', () => {
      const command = createCommand('trigger', 'off');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('全响应');
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });

    it('should support array args (Feishu format)', () => {
      const command = createCommand('trigger', ['on']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle to mention-only when currently responding to all', () => {
      const command = createCommand('trigger');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.isEnabled = vi.fn().mockReturnValue(false);

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should toggle to respond-all when currently mention-only', () => {
      const command = createCommand('trigger');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.isEnabled = vi.fn().mockReturnValue(true);

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });
  });

  describe('invalid arguments', () => {
    it('should reject invalid argument', () => {
      const command = createCommand('trigger', 'invalid');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should show /trigger usage hint in error message', () => {
      const command = createCommand('trigger', 'bad');
      const context = createContext();

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.message).toContain('/trigger');
    });
  });
});
