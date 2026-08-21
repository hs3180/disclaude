/**
 * Tests for send_interactive_message tool (packages/mcp-server/src/tools/interactive-message.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
// Issue #4129: sendInteractive is now a standalone function exported from @disclaude/core.
// The production code calls sendInteractive(client, ...) — mock it to delegate to the
// same spy as the legacy client.sendInteractive(...) instance method so existing
// test assertions (mockIpcClient.sendInteractive) keep working unchanged.
const { mockIpcClient, mockSendInteractive, mockGetRestIpcClient } = vi.hoisted(() => {
  const mockSendInteractive = vi.fn();
  const mockIpcClient = { sendInteractive: mockSendInteractive };
  const mockGetRestIpcClient = vi.fn().mockReturnValue(mockIpcClient);
  return { mockIpcClient, mockSendInteractive, mockGetRestIpcClient };
});

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  // Standalone facade function (Issue #4129). Production calls sendInteractive(client, chatId, params).
  // Drop the leading client arg so the spy sees (chatId, params), matching the
  // legacy client.sendInteractive(chatId, params) assertions in this suite.
  sendInteractive: (_client: unknown, ...rest: unknown[]) => mockSendInteractive(...rest),
}));

vi.mock('./ipc-utils.js', () => ({
  // Issue #4280 (Phase 3, part 3): REST client factory — returns the shared mock.
  getRestIpcClient: () => mockGetRestIpcClient(),
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'ipc_unavailable') {return '❌ IPC 服务不可用。';}
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

vi.mock('./callback-manager.js', () => ({
  getMessageSentCallback: vi.fn(),
}));

// Issue #4280 (part 4): the IPC-server lifecycle exports
// (startIpcServer/stopIpcServer/isIpcServerRunning/getIpcServerSocketPath/
// registerFeishuHandlers/unregisterFeishuHandlers) and their tests are gone
// with the mcp-server's own UnixSocketIpcServer.
import {
  send_interactive_message,
  send_interactive,
} from './interactive-message.js';
import { isIpcAvailable } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';

describe('send_interactive_message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRestIpcClient.mockReturnValue(mockIpcClient);
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
      mockGetRestIpcClient.mockImplementation(() => { throw new Error('Unexpected'); });
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

describe('send_interactive_message edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRestIpcClient.mockReturnValue(mockIpcClient);
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
