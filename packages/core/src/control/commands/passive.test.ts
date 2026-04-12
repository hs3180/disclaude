/**
 * Tests for /passive and /trigger command handlers (packages/core/src/control/commands/passive.ts)
 * Issue #2193: /trigger is the new name, /passive is kept as alias
 * Issue #2291: Upgraded to enum-based trigger mode (mention | always)
 */

import { describe, it, expect, vi } from 'vitest';
import { handlePassive, handleTrigger } from './passive.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import type { TriggerMode } from '../../config/types.js';

/** 创建测试用的 control command */
function createCommand(type: 'passive' | 'trigger', args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type,
    chatId,
    data: args !== undefined ? { args } : undefined,
  };
}

/** 创建测试用的 mode manager mock */
function createModeManagerMock(initialMode: TriggerMode = 'mention') {
  let currentMode: TriggerMode = initialMode;
  return {
    getMode: vi.fn((_chatId: string) => currentMode),
    setMode: vi.fn((_chatId: string, mode: TriggerMode) => { currentMode = mode; }),
    isEnabled: vi.fn((_chatId: string) => currentMode === 'mention'),
    setEnabled: vi.fn((_chatId: string, enabled: boolean) => { currentMode = enabled ? 'mention' : 'always'; }),
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
    triggerMode: createModeManagerMock(),
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
      const mockManager = createModeManagerMock();
      const context = createContext({
        triggerMode: undefined,
        passiveMode: mockManager,
      });

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(mockManager.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });
  });

  describe('legacy arguments (on/off)', () => {
    it('should set mention mode with "on" argument (Issue #2291: on → mention alias)', () => {
      const command = createCommand('passive', 'on');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set always mode with "off" argument (Issue #2291: off → always alias)', () => {
      const command = createCommand('passive', 'off');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    // Issue #1562: Feishu message handler passes args as string[], not string
    it('should set mention mode when args is passed as array (Feishu format)', () => {
      const command = createCommand('passive', ['on']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set always mode when args is passed as array (Feishu format)', () => {
      const command = createCommand('passive', ['off']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });
  });

  describe('enum arguments (Issue #2291)', () => {
    it('should set mention mode with "mention" argument', () => {
      const command = createCommand('passive', 'mention');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已开启');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set always mode with "always" argument', () => {
      const command = createCommand('passive', 'always');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已关闭');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle from always to mention when no argument provided', () => {
      const command = createCommand('passive');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      // Default mock returns 'mention', so toggle should go to 'always'
      // But we want to test the other direction: set initial to 'always'
      triggerMode.getMode = vi.fn().mockReturnValue('always');

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should toggle from mention to always when no argument provided', () => {
      const command = createCommand('passive');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.getMode = vi.fn().mockReturnValue('mention');

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
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
      expect(triggerMode.setMode).not.toHaveBeenCalled();
    });

    it('should reject typo "oof"', () => {
      const command = createCommand('passive', 'oof');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setMode).not.toHaveBeenCalled();
    });

    it('should reject random string "yes"', () => {
      const command = createCommand('passive', 'yes');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setMode).not.toHaveBeenCalled();
    });

    it('should reject numeric string "123"', () => {
      const command = createCommand('passive', '123');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handlePassive(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setMode).not.toHaveBeenCalled();
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

describe('handleTrigger (Issue #2193, #2291)', () => {
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

  describe('legacy arguments (on/off)', () => {
    it('should set mention mode with "on" (Issue #2291: on → mention alias)', () => {
      const command = createCommand('trigger', 'on');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('@触发');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set always mode with "off" (Issue #2291: off → always alias)', () => {
      const command = createCommand('trigger', 'off');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('全响应');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should support array args (Feishu format)', () => {
      const command = createCommand('trigger', ['on']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });
  });

  describe('enum arguments (Issue #2291)', () => {
    it('should set mention mode with "mention"', () => {
      const command = createCommand('trigger', 'mention');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('@触发');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set always mode with "always"', () => {
      const command = createCommand('trigger', 'always');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('全响应');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should support array args with enum values (Feishu format)', () => {
      const command = createCommand('trigger', ['always']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('全响应');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle from mention to always', () => {
      const command = createCommand('trigger');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.getMode = vi.fn().mockReturnValue('mention');

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should toggle from always to mention', () => {
      const command = createCommand('trigger');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.getMode = vi.fn().mockReturnValue('always');

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
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
      expect(triggerMode.setMode).not.toHaveBeenCalled();
    });

    it('should show /trigger usage hint in error message', () => {
      const command = createCommand('trigger', 'bad');
      const context = createContext();

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.message).toContain('/trigger');
    });
  });
});
