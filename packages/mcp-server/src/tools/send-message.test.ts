/**
 * Tests for send_text tool (packages/mcp-server/src/tools/send-message.ts)
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
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'ipc_unavailable') {return '❌ IPC 服务不可用。';}
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

vi.mock('./callback-manager.js', () => ({
  invokeMessageSentCallback: vi.fn(),
  setMessageSentCallback: vi.fn(),
  getMessageSentCallback: vi.fn(),
}));

import { send_text } from './send-message.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';
import { invokeMessageSentCallback } from './callback-manager.js';

const mockIpcClient = {
  sendMessage: vi.fn(),
};

describe('send_text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('parameter validation', () => {
    it('should return error when text is empty', async () => {
      const result = await send_text({ text: '', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('text is required');
    });

    it('should return error when chatId is empty', async () => {
      const result = await send_text({ text: 'hello', chatId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });
  });

  describe('credential validation', () => {
    it('should return error when appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: 'secret' });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials not configured');
    });

    it('should return error when appSecret is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app-id', appSecret: undefined });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials not configured');
    });

    it('should return error when both credentials are missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: undefined });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials not configured');
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('successful send', () => {
    it('should send text message successfully', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_123' });
      const result = await send_text({ text: 'hello world', chatId: 'oc_test' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('sent');
      expect(invokeMessageSentCallback).toHaveBeenCalledWith('oc_test');
    });

    it('should pass parentMessageId to IPC', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_123' });
      await send_text({ text: 'reply', chatId: 'oc_test', parentMessageId: 'parent_456' });
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_test', 'reply', 'parent_456');
    });

    it('should not pass parentMessageId when undefined', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_123' });
      await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_test', 'hello', undefined);
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC send fails', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({ success: false, error: 'Connection lost', errorType: 'ipc_request_failed' });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection lost');
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors and return error result', async () => {
      vi.mocked(getIpcClient).mockImplementation(() => { throw new Error('Unexpected error'); });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected error');
    });

    it('should handle non-Error objects in catch', async () => {
      // eslint-disable-next-line no-throw-literal
      vi.mocked(getIpcClient).mockImplementation(() => { throw 'string error'; });
      const result = await send_text({ text: 'hello', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown error');
    });
  });
});
