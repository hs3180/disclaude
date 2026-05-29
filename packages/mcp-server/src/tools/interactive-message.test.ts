/**
 * Tests for send_interactive_message tool (packages/mcp-server/src/tools/interactive-message.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
  UnixSocketIpcServer: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    getSocketPath: vi.fn(() => '/tmp/test.sock'),
    isRunning: vi.fn(() => true),
  })),
  createInteractiveMessageHandler: vi.fn(() => vi.fn()),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'ipc_unavailable') {return '❌ IPC 服务不可用。';}
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

vi.mock('./callback-manager.js', () => ({
  getMessageSentCallback: vi.fn(),
}));

import {
  send_interactive_message,
  send_interactive,
  registerFeishuHandlers,
  unregisterFeishuHandlers,
  isIpcServerRunning,
  getIpcServerSocketPath,
  startIpcServer,
  stopIpcServer,
} from './interactive-message.js';
import { getIpcClient, UnixSocketIpcServer, createInteractiveMessageHandler } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';

const mockIpcClient = {
  sendInteractive: vi.fn(),
};

describe('send_interactive_message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(getMessageSentCallback).mockReturnValue(null);
  });

  describe('parameter validation - question', () => {
    it('should return error when question is empty', async () => {
      const result = await send_interactive_message({
        question: '', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('question');
    });

    it('should return error when question is whitespace only', async () => {
      const result = await send_interactive_message({
        question: '   ', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('question');
    });

    it('should return error when question is not a string', async () => {
      const result = await send_interactive_message({
        question: 123 as any, options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('question');
    });
  });

  describe('parameter validation - options', () => {
    it('should return error when options is empty array', async () => {
      const result = await send_interactive_message({
        question: 'Q?', options: [], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('options');
    });

    it('should return error when options is not an array', async () => {
      const result = await send_interactive_message({
        question: 'Q?', options: 'not-array' as any, chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('options');
    });

    it('should return error when option text is empty', async () => {
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: '', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('options[0].text');
    });

    it('should return error when option value is empty', async () => {
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: '' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('options[0].value');
    });

    it('should return error when option type is invalid', async () => {
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a', type: 'invalid' as any }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('options[0].type');
    });

    it('should accept valid option types: primary, default, danger', async () => {
      for (const type of ['primary', 'default', 'danger'] as const) {
        mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
        const result = await send_interactive_message({
          question: 'Q?', options: [{ text: 'A', value: 'a', type }], chatId: 'oc_test',
        });
        expect(result.success).toBe(true);
      }
    });

    it('should accept option without type', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('parameter validation - chatId', () => {
    it('should return error when chatId is empty', async () => {
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: '',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId');
    });

    it('should return error when chatId is not a string', async () => {
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: 123 as any,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId');
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('successful send', () => {
    it('should send interactive message successfully', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
      const result = await send_interactive_message({
        question: 'Which option?', options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
        chatId: 'oc_test',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('2 action');
      expect(mockIpcClient.sendInteractive).toHaveBeenCalledWith('oc_test', {
        question: 'Which option?',
        options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
        title: undefined,
        context: undefined,
        threadId: undefined,
        actionPrompts: undefined,
      });
    });

    it('should pass all optional parameters to IPC', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
      await send_interactive_message({
        question: 'Q?',
        options: [{ text: 'OK', value: 'ok', type: 'primary' }],
        chatId: 'oc_test',
        title: 'My Title',
        context: 'Some context',
        parentMessageId: 'parent_123',
        actionPrompts: { ok: 'User chose OK' },
      });
      expect(mockIpcClient.sendInteractive).toHaveBeenCalledWith('oc_test', {
        question: 'Q?',
        options: [{ text: 'OK', value: 'ok', type: 'primary' }],
        title: 'My Title',
        context: 'Some context',
        threadId: 'parent_123',
        actionPrompts: { ok: 'User chose OK' },
      });
    });
  });

  describe('callback invocation', () => {
    it('should invoke message sent callback when set', async () => {
      const callback = vi.fn();
      vi.mocked(getMessageSentCallback).mockReturnValue(callback);
      mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
      await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(callback).toHaveBeenCalledWith('oc_test');
    });

    it('should not throw when callback throws', async () => {
      const callback = vi.fn().mockImplementation(() => { throw new Error('Callback error'); });
      vi.mocked(getMessageSentCallback).mockReturnValue(callback);
      mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC send fails', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({
        success: false, error: 'Send failed', errorType: 'ipc_request_failed',
      });
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Send failed');
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors and return error result', async () => {
      vi.mocked(getIpcClient).mockImplementation(() => { throw new Error('Unexpected'); });
      const result = await send_interactive_message({
        question: 'Q?', options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected');
    });
  });
});

describe('send_interactive alias', () => {
  it('should be the same function as send_interactive_message', () => {
    expect(send_interactive).toBe(send_interactive_message);
  });
});

describe('Feishu handler registration', () => {
  it('should register feishu handlers', () => {
    const handlers = { sendMessage: vi.fn() };
    expect(() => registerFeishuHandlers(handlers as any)).not.toThrow();
  });

  it('should unregister feishu handlers', () => {
    expect(() => unregisterFeishuHandlers()).not.toThrow();
  });
});

describe('IPC server helpers', () => {
  it('should return false when IPC server is not running', () => {
    expect(isIpcServerRunning()).toBe(false);
  });

  it('should return null when IPC server socket path is not available', () => {
    expect(getIpcServerSocketPath()).toBeNull();
  });
});

describe('IPC server lifecycle', () => {
  afterEach(async () => {
    await stopIpcServer();
    unregisterFeishuHandlers();
  });

  describe('startIpcServer', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should create and start a new IPC server', async () => {
      await startIpcServer();

      expect(UnixSocketIpcServer).toHaveBeenCalledTimes(1);
      expect(createInteractiveMessageHandler).toHaveBeenCalledTimes(1);

      const mockInstance = UnixSocketIpcServer.mock.results[0].value;
      expect(mockInstance.start).toHaveBeenCalledTimes(1);

      expect(isIpcServerRunning()).toBe(true);
      expect(getIpcServerSocketPath()).toBe('/tmp/test.sock');
    });

    it('should be idempotent when server already exists', async () => {
      await startIpcServer();
      vi.clearAllMocks();
      await startIpcServer();

      expect(UnixSocketIpcServer).not.toHaveBeenCalled();
    });

    it('should register handlers on first call when provided', async () => {
      const handlers = { sendMessage: vi.fn() } as any;
      await startIpcServer(handlers);

      expect(createInteractiveMessageHandler).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line prefer-destructuring
      const [, container] = createInteractiveMessageHandler.mock.calls[0];
      expect(container.handlers).toBe(handlers);
    });

    it('should update handlers on idempotent call when provided', async () => {
      const handlers1 = { sendMessage: vi.fn() } as any;
      await startIpcServer(handlers1);

      const handlers2 = { sendMessage: vi.fn(), sendCard: vi.fn() } as any;
      await startIpcServer(handlers2);

      expect(UnixSocketIpcServer).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line prefer-destructuring
      const [, container] = createInteractiveMessageHandler.mock.calls[0];
      expect(container.handlers).toBe(handlers2);
    });

    it('should pass no-op callback to createInteractiveMessageHandler', async () => {
      await startIpcServer();

      expect(createInteractiveMessageHandler).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line prefer-destructuring
      const [callback] = createInteractiveMessageHandler.mock.calls[0];
      expect(typeof callback).toBe('function');
      expect(callback()).toBeUndefined();
    });

    it('should reset ipcServer to null on start failure and re-throw', async () => {
      const startError = new Error('Server start failed');
      vi.mocked(UnixSocketIpcServer).mockImplementation(() => ({
        start: vi.fn().mockRejectedValue(startError),
        stop: vi.fn(),
        getSocketPath: vi.fn(() => '/tmp/test.sock'),
        isRunning: vi.fn(() => false),
      }));

      try {
        await expect(startIpcServer()).rejects.toThrow('Server start failed');
        expect(isIpcServerRunning()).toBe(false);
        expect(getIpcServerSocketPath()).toBeNull();
      } finally {
        vi.mocked(UnixSocketIpcServer).mockImplementation(() => ({
          start: vi.fn(),
          stop: vi.fn(),
          getSocketPath: vi.fn(() => '/tmp/test.sock'),
          isRunning: vi.fn(() => true),
        }));
      }
    });

    it('should not register handlers when none are provided', async () => {
      await startIpcServer();

      // eslint-disable-next-line prefer-destructuring
      const [, container] = createInteractiveMessageHandler.mock.calls[0];
      expect(container.handlers).toBeUndefined();
    });
  });

  describe('stopIpcServer', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should stop the running server and clear state', async () => {
      await startIpcServer();

      const mockInstance = UnixSocketIpcServer.mock.results[0].value;
      await stopIpcServer();

      expect(mockInstance.stop).toHaveBeenCalledTimes(1);
      expect(isIpcServerRunning()).toBe(false);
      expect(getIpcServerSocketPath()).toBeNull();
    });

    it('should be a no-op when server is not running', async () => {
      await expect(stopIpcServer()).resolves.toBeUndefined();
    });
  });
});

describe('send_interactive_message edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(getMessageSentCallback).mockReturnValue(null);
  });

  it('should report first invalid option when multiple options are invalid', async () => {
    const result = await send_interactive_message({
      question: 'Q?',
      options: [{ text: '', value: 'a' }, { text: 'B', value: '' }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('options[0].text');
    expect(result.error).not.toContain('options[1]');
  });

  it('should reject whitespace-only option text', async () => {
    const result = await send_interactive_message({
      question: 'Q?',
      options: [{ text: '   ', value: 'a' }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('options[0].text');
  });

  it('should reject whitespace-only option value', async () => {
    const result = await send_interactive_message({
      question: 'Q?',
      options: [{ text: 'A', value: '   ' }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('options[0].value');
  });

  it('should accept option with type explicitly undefined', async () => {
    mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
    const result = await send_interactive_message({
      question: 'Q?',
      options: [{ text: 'A', value: 'a', type: undefined }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(true);
  });

  it('should use fallback error message when IPC result has no error string', async () => {
    mockIpcClient.sendInteractive.mockResolvedValue({
      success: false,
      error: null as any,
      errorType: 'ipc_request_failed',
    });
    const result = await send_interactive_message({
      question: 'Q?',
      options: [{ text: 'A', value: 'a' }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to send interactive message via IPC');
  });

  it('should handle IPC failure with ipc_unavailable error type', async () => {
    mockIpcClient.sendInteractive.mockResolvedValue({
      success: false,
      error: 'Connection lost',
      errorType: 'ipc_unavailable',
    });
    const result = await send_interactive_message({
      question: 'Q?',
      options: [{ text: 'A', value: 'a' }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection lost');
    expect(result.message).toContain('IPC');
  });

  it('should not invoke callback when callback is null', async () => {
    const callback = vi.fn();
    vi.mocked(getMessageSentCallback).mockReturnValue(null);
    mockIpcClient.sendInteractive.mockResolvedValue({ success: true });
    await send_interactive_message({
      question: 'Q?',
      options: [{ text: 'A', value: 'a' }],
      chatId: 'oc_test',
    });
    expect(callback).not.toHaveBeenCalled();
  });
});
