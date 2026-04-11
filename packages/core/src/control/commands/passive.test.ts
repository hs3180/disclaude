/**
 * Tests for /passive command handler (packages/core/src/control/commands/passive.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import { handlePassive } from './passive.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

/** 创建测试用的 control command */
function createCommand(args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type: 'passive',
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
    passiveMode: {
      isEnabled: vi.fn().mockReturnValue(false),
      setEnabled: vi.fn(),
    },
    ...overrides,
  };
}

describe('handlePassive', () => {
  describe('passiveMode not available', () => {
    it('should return failure with clear message when passiveMode is undefined', () => {
      const command = createCommand();
      const mockWarn = vi.fn();
      const context = createContext({ passiveMode: undefined, logger: { warn: mockWarn } as unknown as ControlHandlerContext['logger'] });

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('不可用');
      expect(mockWarn).toHaveBeenCalledWith(
        { chatId: 'test-chat-id' },
        '/passive command received but passiveMode is not configured'
      );
    });
  });

  describe('valid arguments', () => {
    it('should enable passive mode with "on" argument', () => {
      const command = createCommand('on');
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(passiveMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should disable passive mode with "off" argument', () => {
      const command = createCommand('off');
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(passiveMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });

    // Issue #1562: Feishu message handler passes args as string[], not string
    it('should enable passive mode when args is passed as array (Feishu format)', () => {
      const command = createCommand(['on']);
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(passiveMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should disable passive mode when args is passed as array (Feishu format)', () => {
      const command = createCommand(['off']);
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(passiveMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle from off to on when no argument provided', () => {
      const command = createCommand();
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}
      passiveMode.isEnabled = vi.fn().mockReturnValue(false);

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(passiveMode.setEnabled).toHaveBeenCalledWith('test-chat-id', true);
    });

    it('should toggle from on to off when no argument provided', () => {
      const command = createCommand();
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}
      passiveMode.isEnabled = vi.fn().mockReturnValue(true);

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(passiveMode.setEnabled).toHaveBeenCalledWith('test-chat-id', false);
    });
  });

  describe('invalid arguments', () => {
    it('should reject typo "oon"', () => {
      const command = createCommand('oon');
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(passiveMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject typo "oof"', () => {
      const command = createCommand('oof');
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(passiveMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject random string "yes"', () => {
      const command = createCommand('yes');
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(passiveMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should reject numeric string "123"', () => {
      const command = createCommand('123');
      const context = createContext();
      const { passiveMode } = context;
      if (!passiveMode) {throw new Error('passiveMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(passiveMode.setEnabled).not.toHaveBeenCalled();
    });

    it('should show usage hint in error message', () => {
      const command = createCommand('invalid');
      const context = createContext();

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.message).toContain('/passive [on|off]');
    });
  });
});
