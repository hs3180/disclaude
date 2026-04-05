/**
 * Tests for /help command handler (packages/core/src/control/commands/help.ts)
 *
 * Issue #1617 Phase 2: Tests for command handlers.
 */

import { describe, it, expect } from 'vitest';
import { handleHelp } from './help.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

describe('handleHelp', () => {
  it('should return success: true', () => {
    const response = handleHelp(
      { command: '/help', args: [] } as ControlCommand,
      {} as ControlHandlerContext,
    );

    expect(response.success).toBe(true);
  });

  it('should include command list header', () => {
    const response = handleHelp(
      { command: '/help', args: [] } as ControlCommand,
      {} as ControlHandlerContext,
    );

    expect(response.message).toContain('命令列表');
  });

  it('should list all standard commands', () => {
    const response = handleHelp(
      { command: '/help', args: [] } as ControlCommand,
      {} as ControlHandlerContext,
    );

    const commands = [
      '/help', '/reset', '/stop', '/status',
      '/restart', '/passive', '/list-nodes',
      '/show-debug', '/clear-debug',
    ];

    for (const cmd of commands) {
      expect(response.message).toContain(cmd);
    }
  });

  it('should include descriptions for each command', () => {
    const response = handleHelp(
      { command: '/help', args: [] } as ControlCommand,
      {} as ControlHandlerContext,
    );

    expect(response.message).toContain('帮助信息');
    expect(response.message).toContain('重置当前会话');
    expect(response.message).toContain('停止当前响应');
  });

  it('should return a formatted markdown table', () => {
    const response = handleHelp(
      { command: '/help', args: [] } as ControlCommand,
      {} as ControlHandlerContext,
    );

    // Markdown table format
    expect(response.message).toContain('| 命令 |');
    expect(response.message).toContain('|------|');
    expect(response.message).toContain('| 说明 |');
    expect(response.message).toContain('| 用法 |');
  });
});
