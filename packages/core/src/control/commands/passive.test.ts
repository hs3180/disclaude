/**
 * Tests for /trigger command handler (packages/core/src/control/commands/passive.ts)
 * Issue #2291: Upgraded to enum-based trigger mode (mention | always)
 */

import { describe, it, expect, vi } from 'vitest';
import { handleTrigger } from './passive.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import type { TriggerMode } from '../../config/types.js';

/** 创建测试用的 control command */
function createCommand(args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type: 'trigger',
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

describe('handleTrigger (Issue #2291)', () => {
  describe('triggerMode not available', () => {
    it('should return failure when both triggerMode and passiveMode are undefined', () => {
      const command = createCommand();
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

    it('should fall back to passiveMode when triggerMode is undefined (backward compat)', () => {
      const command = createCommand('on');
      const mockManager = createModeManagerMock();
      const context = createContext({
        triggerMode: undefined,
        passiveMode: mockManager,
      });

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(mockManager.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });
  });

  describe('legacy arguments (on/off)', () => {
    it('should set mention mode with "on" (on → mention alias)', () => {
      const command = createCommand('on');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('@触发');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set always mode with "off" (off → always alias)', () => {
      const command = createCommand('off');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('全响应');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should support array args (Feishu format)', () => {
      const command = createCommand(['on']);
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
      const command = createCommand('mention');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('@触发');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set always mode with "always"', () => {
      const command = createCommand('always');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('全响应');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should support array args with enum values (Feishu format)', () => {
      const command = createCommand(['always']);
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
      const command = createCommand();
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}
      triggerMode.getMode = vi.fn().mockReturnValue('mention');

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should toggle from always to mention', () => {
      const command = createCommand();
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
      const command = createCommand('invalid');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) {throw new Error('triggerMode is required');}

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
      expect(triggerMode.setMode).not.toHaveBeenCalled();
    });

    it('should show /trigger usage hint in error message', () => {
      const command = createCommand('bad');
      const context = createContext();

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.message).toContain('/trigger');
    });
  });
});
