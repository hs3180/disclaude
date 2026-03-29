/**
 * Unit tests for start_discussion tool.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp-server/tools/start-discussion.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core before importing the module
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

// Mock ipc-utils
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type: string, error?: string) => `Error [${type}]: ${error ?? 'unknown'}`),
}));

import { start_discussion } from './start-discussion.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  createChat: vi.fn(),
  sendMessage: vi.fn(),
  registerTempChat: vi.fn(),
};

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('validation', () => {
    it('should return error when context is empty', async () => {
      const result = await start_discussion({ context: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('context is required');
    });

    it('should return error when context is missing', async () => {
      const result = await start_discussion({ context: undefined as any });
      expect(result.success).toBe(false);
      expect(result.error).toBe('context is required');
    });
  });

  describe('IPC unavailable', () => {
    it('should return error when IPC is not available', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await start_discussion({ context: 'test context' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('create new chat flow', () => {
    it('should create chat, send context, and register temp chat', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        name: '讨论: test topic',
      });
      mockIpcClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_123' });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        expiresAt: '2026-03-31T10:00:00.000Z',
      });

      const result = await start_discussion({
        context: '用户反复修正同一个指令',
        topic: '需求讨论',
        memberIds: ['ou_xxx'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
      expect(result.expiresAt).toBe('2026-03-31T10:00:00.000Z');
      expect(result.message).toContain('oc_new_chat');

      // Verify IPC calls
      expect(mockIpcClient.createChat).toHaveBeenCalledWith(
        '需求讨论',
        undefined,
        ['ou_xxx']
      );
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_new_chat', '用户反复修正同一个指令');
      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_new_chat',
        undefined,
        undefined,
        { source: 'start_discussion', topic: '需求讨论' }
      );
    });

    it('should use context prefix as group name when topic not provided', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
      });
      mockIpcClient.sendMessage.mockResolvedValue({ success: true });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      await start_discussion({ context: 'This is a longer context message for testing' });

      // Chat name is truncated to 30 chars with "讨论: " prefix + "..."
      expect(mockIpcClient.createChat).toHaveBeenCalledWith(
        '讨论: This is a longer context messa...',
        undefined,
        undefined
      );
    });

    it('should pass expiresAt and creatorChatId to registerTempChat', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
      });
      mockIpcClient.sendMessage.mockResolvedValue({ success: true });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true,
        expiresAt: '2026-04-01T00:00:00.000Z',
      });

      const result = await start_discussion({
        context: 'test',
        expiresAt: '2026-04-01T00:00:00.000Z',
        creatorChatId: 'oc_origin',
      });

      expect(result.expiresAt).toBe('2026-04-01T00:00:00.000Z');
      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_new_chat',
        '2026-04-01T00:00:00.000Z',
        'oc_origin',
        expect.any(Object)
      );
    });
  });

  describe('use existing chat flow', () => {
    it('should skip chat creation when chatId is provided', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({ success: true, messageId: 'msg_456' });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true,
        expiresAt: '2026-03-31T10:00:00.000Z',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        context: '需要讨论的问题',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing');
      expect(mockIpcClient.createChat).not.toHaveBeenCalled();
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_existing', '需要讨论的问题');
      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_existing',
        undefined,
        undefined,
        { source: 'start_discussion', topic: undefined }
      );
    });
  });

  describe('error handling', () => {
    it('should return error when createChat fails', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: false,
        error: 'Permission denied',
        errorType: 'ipc_request_failed',
      });

      const result = await start_discussion({ context: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
      expect(mockIpcClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should return error when sendMessage fails', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
      });
      mockIpcClient.sendMessage.mockResolvedValue({
        success: false,
        error: 'Chat not found',
        errorType: 'ipc_request_failed',
      });

      const result = await start_discussion({ context: 'test' });
      expect(result.success).toBe(false);
      expect(result.chatId).toBe('oc_new_chat');
      expect(result.error).toBe('Chat not found');
      expect(mockIpcClient.registerTempChat).not.toHaveBeenCalled();
    });

    it('should succeed even when registerTempChat fails (non-fatal)', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
      });
      mockIpcClient.sendMessage.mockResolvedValue({ success: true });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: false,
        error: 'Already registered',
      });

      const result = await start_discussion({ context: 'test' });
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
    });

    it('should handle unexpected exceptions', async () => {
      mockIpcClient.createChat.mockRejectedValue(new Error('Connection reset'));

      const result = await start_discussion({ context: 'test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection reset');
    });
  });

  describe('with existing chat and registerTempChat failure', () => {
    it('should still return success when using existing chat and register fails', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({ success: true });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: false,
        error: 'Storage error',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        context: 'test context',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing');
    });
  });
});
