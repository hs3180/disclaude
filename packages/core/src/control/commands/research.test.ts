/**
 * Tests for /research command handler (packages/core/src/control/commands/research.ts)
 *
 * Issue #1709: 增加 Research 模式
 */

import { describe, it, expect, vi } from 'vitest';
import { handleResearch } from './research.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { ResearchModeManager } from '../../modes/agent-mode.js';

/** Create test control command */
function createCommand(args?: string | string[], chatId = 'test-chat-id'): ControlCommand {
  return {
    type: 'research',
    chatId,
    data: args !== undefined ? { args } : undefined,
  };
}

/** Create test handler context */
function createContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn() },
    node: {
      nodeId: 'test-node',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
    },
    researchMode: new ResearchModeManager(),
    ...overrides,
  };
}

describe('handleResearch', () => {
  describe('researchMode not available', () => {
    it('should return development message when researchMode is undefined', () => {
      const command = createCommand();
      const context = createContext({ researchMode: undefined });

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('开发中');
    });
  });

  describe('enter research mode', () => {
    it('should enter research mode with a topic', () => {
      const command = createCommand('AI Safety');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) { throw new Error('researchMode is required'); }

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('AI Safety');
      expect(result.message).toContain('ai-safety');
      expect(researchMode.isResearchMode('test-chat-id')).toBe(true);
    });

    it('should handle Feishu array args format', () => {
      const command = createCommand(['Machine Learning']);
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) { throw new Error('researchMode is required'); }

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('Machine Learning');
      expect(researchMode.isResearchMode('test-chat-id')).toBe(true);
    });

    it('should trim whitespace from topic', () => {
      const command = createCommand('  AI Safety  ');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) { throw new Error('researchMode is required'); }

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('AI Safety');
    });
  });

  describe('exit research mode', () => {
    it('should exit research mode with "off" argument', () => {
      const command = createCommand('off');
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) { throw new Error('researchMode is required'); }

      // First enter research mode
      researchMode.enterResearch('test-chat-id', 'Test Topic');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已退出');
      expect(researchMode.isResearchMode('test-chat-id')).toBe(false);
    });

    it('should handle Feishu array args format for "off"', () => {
      const command = createCommand(['off']);
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) { throw new Error('researchMode is required'); }

      researchMode.enterResearch('test-chat-id', 'Test Topic');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('已退出');
    });

    it('should show info message when not in research mode', () => {
      const command = createCommand('off');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('不在 Research 模式中');
    });
  });

  describe('show status (no args)', () => {
    it('should show normal mode status when not in research mode', () => {
      const command = createCommand();
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('普通模式');
    });

    it('should show research mode status with topic and duration', () => {
      const command = createCommand();
      const context = createContext();
      const { researchMode } = context;
      if (!researchMode) { throw new Error('researchMode is required'); }

      researchMode.enterResearch('test-chat-id', 'Quantum Computing');

      const result = handleResearch(command, context) as ControlResponse;

      expect(result.success).toBe(true);
      expect(result.message).toContain('活跃中');
      expect(result.message).toContain('Quantum Computing');
    });
  });

  describe('edge cases', () => {
    it('should not treat "on" as a topic name', () => {
      const command = createCommand('on');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      // "on" should be treated as a status query (no topic entered)
      // since it doesn't match the "off" pattern and doesn't satisfy
      // the topic condition (args !== 'on')
      expect(result.success).toBe(true);
      expect(context.researchMode?.isResearchMode('test-chat-id')).toBe(false);
    });

    it('should reject empty topic', () => {
      const command = createCommand('   ');
      const context = createContext();

      const result = handleResearch(command, context) as ControlResponse;

      // Empty/whitespace topic should show status, not try to enter
      expect(result.success).toBe(true);
    });
  });
});
