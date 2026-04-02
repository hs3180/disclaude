/**
 * Tests for start_discussion tool (Issue #631).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('./create-chat.js', () => ({
  create_chat: vi.fn(),
}));

vi.mock('./send-message.js', () => ({
  send_text: vi.fn(),
}));

vi.mock('./register-temp-chat.js', () => ({
  register_temp_chat: vi.fn(),
}));

import { start_discussion } from './start-discussion.js';
import { create_chat } from './create-chat.js';
import { send_text } from './send-message.js';
import { register_temp_chat } from './register-temp-chat.js';

const mockCreateChat = vi.mocked(create_chat);
const mockSendText = vi.mocked(send_text);
const mockRegisterTempChat = vi.mocked(register_temp_chat);

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation', () => {
    it('should fail when context is missing', async () => {
      const result = await start_discussion({ context: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('context is required');
    });

    it('should fail when context is not a string', async () => {
      const result = await start_discussion({ context: undefined as unknown as string });
      expect(result.success).toBe(false);
      expect(result.error).toContain('context is required');
    });

    it('should fail when both chatId and members are provided', async () => {
      const result = await start_discussion({
        context: 'test context',
        chatId: 'oc_xxx',
        members: ['ou_a', 'ou_b'],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('mutually exclusive');
    });
  });

  describe('using existing chat (chatId)', () => {
    it('should send context to existing chat and return immediately', async () => {
      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        context: 'Please review the PR #123',
        chatId: 'oc_existing',
        topic: 'PR Review',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing');
      expect(result.message).toContain('used existing');
      expect(mockSendText).toHaveBeenCalledWith({
        text: '## Discussion Topic: PR Review\n\nPlease review the PR #123',
        chatId: 'oc_existing',
      });
      // Should NOT create chat or register temp
      expect(mockCreateChat).not.toHaveBeenCalled();
      expect(mockRegisterTempChat).not.toHaveBeenCalled();
    });

    it('should fail if send_text fails', async () => {
      mockSendText.mockResolvedValue({
        success: false,
        message: '❌ IPC 服务不可用',
        error: 'IPC service unavailable',
      });

      const result = await start_discussion({
        context: 'test',
        chatId: 'oc_existing',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('发送讨论内容失败');
    });
  });

  describe('creating new chat (members)', () => {
    it('should create a new chat, send context, and register temp chat', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        name: 'Topic Discussion',
        message: '✅ Group chat created',
      });

      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      mockRegisterTempChat.mockResolvedValue({
        success: true,
        message: '✅ Temp chat registered',
        chatId: 'oc_new_chat',
      });

      const result = await start_discussion({
        context: 'Should we adopt TypeScript strict mode?',
        topic: 'TypeScript Strict Mode',
        members: ['ou_a', 'ou_b'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
      expect(result.name).toBe('Topic Discussion');
      expect(result.message).toContain('created new');

      // Verify create_chat was called with correct params
      expect(mockCreateChat).toHaveBeenCalledWith({
        name: 'TypeScript Strict Mode',
        description: 'Discussion: TypeScript Strict Mode',
        memberIds: ['ou_a', 'ou_b'],
      });

      // Verify send_text was called with topic-prefixed message
      expect(mockSendText).toHaveBeenCalledWith({
        text: '## Discussion Topic: TypeScript Strict Mode\n\nShould we adopt TypeScript strict mode?',
        chatId: 'oc_new_chat',
      });

      // Verify register_temp_chat was called
      expect(mockRegisterTempChat).toHaveBeenCalledWith({
        chatId: 'oc_new_chat',
        expiresAt: expect.any(String),
        context: { topic: 'TypeScript Strict Mode', source: 'start_discussion' },
      });
    });

    it('should not register temp chat when registerTemp is false', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        name: 'Discussion',
        message: '✅ Group chat created',
      });

      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        context: 'test',
        topic: 'Test Topic',
        members: ['ou_a'],
        registerTemp: false,
      });

      expect(result.success).toBe(true);
      expect(mockRegisterTempChat).not.toHaveBeenCalled();
    });

    it('should send context without topic prefix when no topic is provided', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        message: '✅ Group chat created',
      });

      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      mockRegisterTempChat.mockResolvedValue({
        success: true,
        message: '✅ Temp chat registered',
      });

      await start_discussion({
        context: 'Just a plain message',
        members: ['ou_a'],
      });

      expect(mockSendText).toHaveBeenCalledWith({
        text: 'Just a plain message',
        chatId: 'oc_new_chat',
      });
    });

    it('should fail if create_chat fails', async () => {
      mockCreateChat.mockResolvedValue({
        success: false,
        message: '❌ IPC 服务不可用',
        error: 'IPC service unavailable',
      });

      const result = await start_discussion({
        context: 'test',
        members: ['ou_a'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('创建群聊失败');
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should succeed even if register_temp_chat fails (non-fatal)', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        name: 'Topic',
        message: '✅ Group chat created',
      });

      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      mockRegisterTempChat.mockResolvedValue({
        success: false,
        message: '❌ Registration failed',
        error: 'temp store unavailable',
      });

      const result = await start_discussion({
        context: 'test',
        topic: 'Topic',
        members: ['ou_a'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
    });
  });

  describe('neither chatId nor members', () => {
    it('should create a new chat with auto-generated name when no members or chatId provided', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_auto',
        message: '✅ Group chat created',
      });

      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      mockRegisterTempChat.mockResolvedValue({
        success: true,
        message: '✅ Temp chat registered',
      });

      const result = await start_discussion({
        context: 'Just a message without specifying chat',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_auto');
      expect(mockCreateChat).toHaveBeenCalledWith({
        name: undefined,
        description: 'Discussion: Untitled',
        memberIds: undefined,
      });
    });
  });

  describe('expiresIn parameter', () => {
    it('should pass custom expiresIn to register_temp_chat', async () => {
      mockCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new',
        name: 'Topic',
        message: '✅ Group chat created',
      });

      mockSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      mockRegisterTempChat.mockResolvedValue({
        success: true,
        message: '✅ Temp chat registered',
      });

      const result = await start_discussion({
        context: 'test',
        members: ['ou_a'],
        expiresIn: 48,
      });

      expect(result.success).toBe(true);

      // Verify the expiresAt is approximately 48 hours from now
      const registeredCall = mockRegisterTempChat.mock.calls[0][0];
      const expiresAt = new Date(registeredCall.expiresAt!);
      const now = Date.now();
      const diffHours = (expiresAt.getTime() - now) / (1000 * 60 * 60);
      expect(diffHours).toBeCloseTo(48, 0);
    });
  });
});
