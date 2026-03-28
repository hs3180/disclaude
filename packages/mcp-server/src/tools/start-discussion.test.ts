/**
 * Tests for start_discussion tool (packages/mcp-server/src/tools/start-discussion.ts)
 *
 * Issue #631: Non-blocking discussion initiation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing the module
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((errorType?: string, originalError?: string) => {
    if (errorType === 'ipc_unavailable') return '❌ IPC 服务不可用';
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

vi.mock('./callback-manager.js', () => ({
  getMessageSentCallback: vi.fn(() => null),
}));

import { start_discussion } from './start-discussion.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getMessageSentCallback } from './callback-manager.js';

const mockIpcClient = {
  createChat: vi.fn(),
  sendMessage: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(),
};

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(getMessageSentCallback).mockReturnValue(null);
  });

  describe('validation', () => {
    it('should fail if context is empty', async () => {
      const result = await start_discussion({ context: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('context');
    });

    it('should fail if context is missing', async () => {
      const result = await start_discussion({ context: undefined as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('context');
    });

    it('should fail if context is whitespace only', async () => {
      const result = await start_discussion({ context: '   ' });
      expect(result.success).toBe(false);
    });

    it('should fail if IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await start_discussion({ context: 'Hello' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC');
    });
  });

  describe('with existing chatId', () => {
    it('should send context to existing chat and return success', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({
        success: true,
        messageId: 'om_123',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        context: 'Please review the PR',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing');
      expect(result.message).toContain('oc_existing');
      expect(result.message).toContain('existing');
      expect(mockIpcClient.createChat).not.toHaveBeenCalled();
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_existing', 'Please review the PR');
    });

    it('should fail if sendMessage fails', async () => {
      mockIpcClient.sendMessage.mockResolvedValue({
        success: false,
        error: 'Permission denied',
        errorType: 'ipc_request_failed',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        context: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.chatId).toBe('oc_existing');
      expect(result.error).toContain('Permission denied');
    });
  });

  describe('without chatId (create new chat)', () => {
    it('should create new chat and send context', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        name: 'PR Review',
      });
      mockIpcClient.sendMessage.mockResolvedValue({
        success: true,
        messageId: 'om_456',
      });

      const result = await start_discussion({
        topic: 'PR Review',
        members: ['ou_xxx', 'ou_yyy'],
        context: 'Please review the changes',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
      expect(result.message).toContain('oc_new_chat');
      expect(result.message).toContain('PR Review');
      expect(result.message).toContain('new group');
      expect(mockIpcClient.createChat).toHaveBeenCalledWith('PR Review', undefined, ['ou_xxx', 'ou_yyy']);
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_new_chat', 'Please review the changes');
    });

    it('should create chat with auto-generated name when topic not provided', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_auto',
        name: 'Auto Group',
      });
      mockIpcClient.sendMessage.mockResolvedValue({
        success: true,
        messageId: 'om_789',
      });

      const result = await start_discussion({
        context: 'Discussion without topic',
      });

      expect(result.success).toBe(true);
      expect(mockIpcClient.createChat).toHaveBeenCalledWith(undefined, undefined, undefined);
    });

    it('should fail if createChat fails', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: false,
        error: 'Rate limited',
        errorType: 'ipc_timeout',
      });

      const result = await start_discussion({
        topic: 'Test',
        context: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
      expect(mockIpcClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should fail if createChat succeeds but sendMessage fails', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_partial',
        name: 'Partial',
      });
      mockIpcClient.sendMessage.mockResolvedValue({
        success: false,
        error: 'Send failed',
        errorType: 'ipc_request_failed',
      });

      const result = await start_discussion({
        context: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.chatId).toBe('oc_partial');
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_partial', 'Hello');
    });
  });

  describe('callback invocation', () => {
    it('should invoke message sent callback on success', async () => {
      const callback = vi.fn();
      vi.mocked(getMessageSentCallback).mockReturnValue(callback);
      mockIpcClient.sendMessage.mockResolvedValue({
        success: true,
        messageId: 'om_cb',
      });

      await start_discussion({
        chatId: 'oc_callback',
        context: 'Test callback',
      });

      expect(callback).toHaveBeenCalledWith('oc_callback');
    });

    it('should not throw if callback throws', async () => {
      const callback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      vi.mocked(getMessageSentCallback).mockReturnValue(callback);
      mockIpcClient.sendMessage.mockResolvedValue({
        success: true,
        messageId: 'om_err',
      });

      // Should not throw even though callback throws
      const result = await start_discussion({
        chatId: 'oc_err',
        context: 'Test',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle unexpected errors gracefully', async () => {
      vi.mocked(getIpcClient).mockImplementation(() => {
        throw new Error('Unexpected IPC error');
      });

      const result = await start_discussion({
        context: 'Test error',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected IPC error');
    });
  });
});
