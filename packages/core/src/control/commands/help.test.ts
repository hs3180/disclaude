/**
 * Tests for /help command handler (packages/core/src/control/commands/help.ts)
 */

import { describe, it, expect } from 'vitest';
import { handleHelp } from './help.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

describe('handleHelp', () => {
  const mockContext = {} as ControlHandlerContext;
  const mockCommand: ControlCommand = { type: 'help', chatId: 'test-chat' };

  it('should return success response', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.success).toBe(true);
  });

  it('should include command list header', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('命令列表');
  });

  it('should include /help command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/help');
  });

  it('should include /reset command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/reset');
  });

  it('should include /stop command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/stop');
  });

  it('should include /status command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/status');
  });

  it('should include /restart command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/restart');
  });

  it('should include /passive command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/passive');
  });

  it('should include /list-nodes command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/list-nodes');
  });

  it('should include /debug command', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('/debug');
  });

  it('should format output as markdown table', async () => {
    const result = await handleHelp(mockCommand, mockContext);
    expect(result.message).toContain('| 命令 | 说明 | 用法 |');
    expect(result.message).toContain('|------|------|------|');
  });

  it('should return consistent result regardless of command data', async () => {
    const cmd1: ControlCommand = { type: 'help', chatId: 'test-chat' };
    const cmd2: ControlCommand = { type: 'help', chatId: 'test-chat', data: { extra: true } };
    const result1 = await handleHelp(cmd1, mockContext);
    const result2 = await handleHelp(cmd2, mockContext);
    expect(result1.message).toBe(result2.message);
  });
});
