import { describe, it, expect, vi } from 'vitest';
import { handleTrigger } from './trigger.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

function createCommand(args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type: 'trigger',
    chatId,
    data: args !== undefined ? { args } : undefined,
  };
}

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

describe('handleTrigger', () => {
  describe('triggerMode not available', () => {
    it('should return failure when triggerMode is undefined', () => {
      const command = createCommand();
      const mockWarn = vi.fn();
      const context = createContext({ triggerMode: undefined, logger: { warn: mockWarn } as unknown as ControlHandlerContext['logger'] });

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
    it('should set mode to mention with "mention" argument', () => {
      const command = createCommand('mention');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) { throw new Error('triggerMode is required'); }

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('mention');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });

    it('should set mode to always with "always" argument', () => {
      const command = createCommand('always');
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) { throw new Error('triggerMode is required'); }

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('always');
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    // Issue #1562: Feishu message handler passes args as string[], not string
    it('should handle args passed as array (Feishu format)', () => {
      const command = createCommand(['always']);
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) { throw new Error('triggerMode is required'); }

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });
  });

  describe('no argument (toggle)', () => {
    it('should toggle from mention to always', () => {
      const command = createCommand();
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) { throw new Error('triggerMode is required'); }
      triggerMode.getMode = vi.fn().mockReturnValue('mention');

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'always');
    });

    it('should toggle from always to mention', () => {
      const command = createCommand();
      const context = createContext();
      const { triggerMode } = context;
      if (!triggerMode) { throw new Error('triggerMode is required'); }
      triggerMode.getMode = vi.fn().mockReturnValue('always');

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(triggerMode.setMode).toHaveBeenCalledWith('test-chat-id', 'mention');
    });
  });

  describe('invalid arguments', () => {
    it('should reject "on"', () => {
      const command = createCommand('on');
      const context = createContext();

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
    });

    it('should reject "off"', () => {
      const command = createCommand('off');
      const context = createContext();

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.success).toBe(false);
      expect(result.message).toContain('无效参数');
    });

    it('should show usage hint in error message', () => {
      const command = createCommand('invalid');
      const context = createContext();

      const result = handleTrigger(command, context) as ControlResponse;

      expect(result.message).toContain('/trigger [mention|always]');
    });
  });
});
