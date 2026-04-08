/**
 * Tests for /trigger command handler (packages/core/src/control/commands/passive.ts)
 * Issue #2193: Renamed from /passive to /trigger
 */

import { describe, it, expect, vi } from 'vitest';
import { handlePassive } from './passive.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

/** 创建测试用的 control command */
function createCommand(args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type: 'trigger',
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
      clearDebugGroup: vi.fn(),
    },
    triggerMode: {
      getMode: vi.fn().mockReturnValue('mention'),
      setMode: vi.fn(),
    },
    ...overrides,
  };
}

describe('handlePassive (trigger mode)', () => {
  describe('triggerMode not available', () => {
    it('should return failure with clear message when triggerMode is undefined', () => {
      const command = createCommand();
      const mockWarn = vi.fn();
      const context = createContext({ triggerMode: undefined, logger: { warn: mockWarn } as unknown as ControlHandlerContext['logger'] });

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('不可用');
      expect(mockWarn).toHaveBeenCalledWith(
        { chatId: 'test-chat-id' },
        '/trigger command received but triggerMode is not configured'
      );
    });
  });

  describe('valid arguments (new enum values)', () => {
    it('should set mode to mention with "mention" argument', () => {
      const command = createCommand('mention');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('mention');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set mode to always with "always" argument', () => {
      const command = createCommand('always');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('always');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });
  });

  describe('backward compat (old on/off arguments)', () => {
    it('should set mode to mention with "on" argument', () => {
      const command = createCommand('on');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set mode to always with "off" argument', () => {
      const command = createCommand('off');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should set mode to mention when args is passed as array (Feishu format)', () => {
      const command = createCommand(['on']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set mode to always when args is passed as array (Feishu format)', () => {
      const command = createCommand(['off']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle from mention to always when no argument provided', () => {
      const command = createCommand();
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.getMode = vi.fn().mockReturnValue('mention');

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should toggle from always to mention when no argument provided', () => {
      const command = createCommand();
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.getMode = vi.fn().mockReturnValue('always');

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });
  });

  describe('invalid arguments', () => {
    it('should reject typo "oon"', () => {
      const command = createCommand('oon');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setMode).not.toHaveBeenCalled();
    });

    it('should reject random string "yes"', () => {
      const command = createCommand('yes');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setMode).not.toHaveBeenCalled();
    });

    it('should show usage hint in error message', () => {
      const command = createCommand('invalid');
      const context = createContext();

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.message).toContain('/trigger [mention|always]');
    });
  });
});
