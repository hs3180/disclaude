/**
 * Tests for command handlers (src/feishu/command-handlers.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleStatusCommand,
  handleHelpCommand,
  isCommand,
  parseCommand,
  executeCommand,
  type CommandHandlerContext,
} from './command-handlers.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('isCommand', () => {
  it('should return true for /status command', () => {
    expect(isCommand('/status')).toBe(true);
  });

  it('should return true for /help command', () => {
    expect(isCommand('/help')).toBe(true);
  });

  it('should return true for /task with arguments', () => {
    expect(isCommand('/task Test task')).toBe(true);
  });

  it('should return false for non-command text', () => {
    expect(isCommand('Hello world')).toBe(false);
  });
});

describe('parseCommand', () => {
  it('should parse command without arguments', () => {
    const result = parseCommand('/status');
    expect(result).toEqual({ command: '/status', args: '' });
  });

  it('should parse command with arguments', () => {
    const result = parseCommand('/task test');
    expect(result).toEqual({ command: '/task', args: 'test' });
  });

  it('should return null for non-command text', () => {
    const result = parseCommand('Hello world');
    expect(result).toBeNull();
  });
});

describe('handleStatusCommand', () => {
  let mockContext: CommandHandlerContext;
  let mockSendMessage: any;

  beforeEach(() => {
    mockSendMessage = vi.fn().mockResolvedValue(undefined);
    mockContext = {
      chatId: 'oc_test123',
      sendMessage: mockSendMessage,
      longTaskManagers: new Map(),
    };
  });

  it('should send status message when no task is running', async () => {
    await handleStatusCommand(mockContext);
    expect(mockSendMessage).toHaveBeenCalledWith(
      'oc_test123',
      expect.stringContaining('No long task')
    );
  });
});

describe('handleHelpCommand', () => {
  let mockContext: CommandHandlerContext;
  let mockSendMessage: any;

  beforeEach(() => {
    mockSendMessage = vi.fn().mockResolvedValue(undefined);
    mockContext = {
      chatId: 'oc_test123',
      sendMessage: mockSendMessage,
      longTaskManagers: new Map(),
    };
  });

  it('should send help message', async () => {
    await handleHelpCommand(mockContext);
    expect(mockSendMessage).toHaveBeenCalled();
  });
});

describe('executeCommand', () => {
  let mockContext: CommandHandlerContext;
  let mockSendMessage: any;

  beforeEach(() => {
    mockSendMessage = vi.fn().mockResolvedValue(undefined);
    mockContext = {
      chatId: 'oc_test123',
      sendMessage: mockSendMessage,
      longTaskManagers: new Map(),
    };
  });

  it('should execute /status command', async () => {
    const result = await executeCommand(mockContext, '/status');
    expect(result).toBe(true);
  });

  it('should return false for non-command', async () => {
    const result = await executeCommand(mockContext, 'Hello');
    expect(result).toBe(false);
  });
});
