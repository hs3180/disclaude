/**
 * Tests for /help command handler (packages/core/src/control/commands/help.ts)
 */

import { describe, it, expect } from 'vitest';
import { handleHelp } from './help.js';
import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

describe('handleHelp', () => {
  const mockContext = {} as ControlHandlerContext;
  const mockCommand = { type: 'help', args: [] } as ControlCommand;

  it('should return success response', () => {
    const result: ControlResponse = handleHelp(mockCommand, mockContext);
    expect(result.success).toBe(true);
  });

  it('should include command list header', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('命令列表');
  });

  it('should include /help command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/help');
  });

  it('should include /reset command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/reset');
  });

  it('should include /stop command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/stop');
  });

  it('should include /status command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/status');
  });

  it('should include /restart command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/restart');
  });

  it('should include /passive command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/passive');
  });

  it('should include /list-nodes command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/list-nodes');
  });

  it('should include /show-debug command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/show-debug');
  });

  it('should include /clear-debug command', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/clear-debug');
  });

  it('should format output as markdown table', () => {
    const result = handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('| 命令 | 说明 | 用法 |');
    expect(result.message).toContain('|------|------|------|');
  });

  it('should return consistent result regardless of command input', () => {
    const cmd1 = { type: 'help', args: [] } as ControlCommand;
    const cmd2 = { type: 'help', args: ['extra'] } as ControlCommand;
    const result1 = handleHelp(cmd1, mockContext);
    const result2 = handleHelp(cmd2, mockContext);
    expect(result1.message).toBe(result2.message);
  });
});
