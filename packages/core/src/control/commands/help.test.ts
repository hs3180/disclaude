/**
 * Tests for /help command handler (packages/core/src/control/commands/help.ts)
 *
 * Tests the help command response:
 * - Returns success status
 * - Contains all expected command descriptions
 * - Command list format is consistent
 *
 * Issue #1617: test: 提升单元测试覆盖率至 70%
 */

import { describe, it, expect } from 'vitest';
import { handleHelp } from './help.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(): ControlHandlerContext {
  return {
    agentPool: {
      reset: () => {},
      stop: () => false,
    },
    node: {
      nodeId: 'test-node',
      getExecNodes: () => [],
      getDebugGroup: () => null,
      clearDebugGroup: () => {},
    },
  };
}

describe('handleHelp', () => {
  it('should return success status', () => {
    const result = handleHelp({} as ControlCommand, createMockContext());

    expect(result.success).toBe(true);
  });

  it('should contain help command description', () => {
    const result = handleHelp({} as ControlCommand, createMockContext());

    expect(result.message).toContain('/help');
    expect(result.message).toContain('显示帮助信息');
  });

  it('should contain all expected commands in the help text', () => {
    const result = handleHelp({} as ControlCommand, createMockContext());

    const expectedCommands = [
      '/help',
      '/reset',
      '/stop',
      '/status',
      '/restart',
      '/passive',
      '/list-nodes',
      '/show-debug',
      '/clear-debug',
    ];

    for (const cmd of expectedCommands) {
      expect(result.message).toContain(cmd);
    }
  });

  it('should be formatted as a markdown table', () => {
    const result = handleHelp({} as ControlCommand, createMockContext());

    expect(result.message).toContain('| 命令 | 说明 | 用法 |');
    expect(result.message).toContain('命令列表');
  });

  it('should work regardless of command input', () => {
    const result1 = handleHelp({ type: 'help' } as ControlCommand, createMockContext());
    const result2 = handleHelp({ type: 'reset' } as ControlCommand, createMockContext());

    expect(result1.message).toBe(result2.message);
  });

  it('should work regardless of context', () => {
    const ctx1 = createMockContext();
    const ctx2 = createMockContext();
    ctx2.passiveMode = { isEnabled: () => false, setEnabled: () => {} };

    const result1 = handleHelp({} as ControlCommand, ctx1);
    const result2 = handleHelp({} as ControlCommand, ctx2);

    expect(result1.message).toBe(result2.message);
  });
});
