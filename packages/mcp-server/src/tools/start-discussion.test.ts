/**
 * Tests for start_discussion tool (packages/mcp-server/src/tools/start-discussion.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('./create-chat.js', () => ({
  create_chat: vi.fn(),
}));

vi.mock('./send-message.js', () => ({
  send_text: vi.fn(),
}));

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { start_discussion } from './start-discussion.js';
import { create_chat } from './create-chat.js';
import { send_text } from './send-message.js';

const mockCreateChat = vi.mocked(create_chat);
const mockSendText = vi.mocked(send_text);

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('with existing chatId', () => {
    it('should send context to existing chat and return success', async () => {
      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        chatId: 'oc_existing_chat',
        context: 'Let us discuss the deployment strategy',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing_chat');
      expect(mockCreateChat).not.toHaveBeenCalled();
      expect(mockSendText).toHaveBeenCalledWith({
        chatId: 'oc_existing_chat',
        text: 'Let us discuss the deployment strategy',
      });
    });

    it('should return failure when send_text fails', async () => {
      mockSendText.mockResolvedValue({
        success: false,
        error: 'IPC timeout',
        message: '❌ IPC 请求超时',
      });

      const result = await start_discussion({
        chatId: 'oc_existing_chat',
        context: 'Discussion topic',
      });

      expect(result.success).toBe(false);
      expect(result.chatId).toBe('oc_existing_chat');
      expect(result.error).toBe('IPC timeout');
    });
  });

  describe('with new chat creation', () => {
    it('should create a new chat and send context', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        name: 'Deployment Discussion',
        message: '✅ Group chat created',
      });
      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        context: 'Let us discuss the deployment strategy',
        topic: 'Deployment Discussion',
        members: ['ou_user1', 'ou_user2'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
      expect(mockCreateChat).toHaveBeenCalledWith({
        name: 'Deployment Discussion',
        memberIds: ['ou_user1', 'ou_user2'],
      });
      expect(mockSendText).toHaveBeenCalledWith({
        chatId: 'oc_new_chat',
        text: 'Let us discuss the deployment strategy',
      });
    });

    it('should create chat with topic as name when provided', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_topic_chat',
        name: 'Bug Triage',
        message: '✅ Group chat created',
      });
      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        context: 'We need to triage the bugs from last sprint',
        topic: 'Bug Triage',
      });

      expect(result.success).toBe(true);
      expect(mockCreateChat).toHaveBeenCalledWith({
        name: 'Bug Triage',
        memberIds: undefined,
      });
    });

    it('should return failure when create_chat fails', async () => {
      mockCreateChat.mockResolvedValue({
        success: false,
        error: 'Permission denied',
        message: '❌ 没有权限创建群聊',
      });

      const result = await start_discussion({
        context: 'Discussion topic',
        topic: 'Test Topic',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should not send context if chat creation fails', async () => {
      mockCreateChat.mockResolvedValue({
        success: false,
        error: 'Network error',
        message: '❌ 网络错误',
      });

      await start_discussion({
        context: 'Some context',
        members: ['ou_user1'],
      });

      expect(mockSendText).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should return failure when context is empty', async () => {
      const result = await start_discussion({
        context: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('context is required');
      expect(mockCreateChat).not.toHaveBeenCalled();
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should prefer chatId over members when both provided', async () => {
      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        members: ['ou_user1'],
        context: 'Discussion context',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing');
      expect(mockCreateChat).not.toHaveBeenCalled();
      expect(mockSendText).toHaveBeenCalledWith({
        chatId: 'oc_existing',
        text: 'Discussion context',
      });
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors from send_text', async () => {
      mockSendText.mockRejectedValue(new Error('Unexpected failure'));

      const result = await start_discussion({
        chatId: 'oc_chat',
        context: 'Some context',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected failure');
    });

    it('should catch unexpected errors from create_chat', async () => {
      mockCreateChat.mockRejectedValue(new Error('Unexpected create failure'));

      const result = await start_discussion({
        context: 'Some context',
        topic: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected create failure');
    });
  });
});
