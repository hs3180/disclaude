/**
 * Tests for start_discussion tool (packages/mcp-server/src/tools/start-discussion.ts)
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type, error) => `Error: ${type ?? 'unknown'} - ${error ?? 'unknown'}`),
}));

vi.mock('./create-chat.js', () => ({
  create_chat: vi.fn(),
}));

vi.mock('./send-message.js', () => ({
  send_text: vi.fn(),
}));

vi.mock('./register-temp-chat.js', () => ({
  register_temp_chat: vi.fn(),
}));

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { start_discussion } from './start-discussion.js';
import { isIpcAvailable } from './ipc-utils.js';
import { create_chat } from './create-chat.js';
import { send_text } from './send-message.js';
import { register_temp_chat } from './register-temp-chat.js';

const mockedIsIpcAvailable = vi.mocked(isIpcAvailable);
const mockedCreateChat = vi.mocked(create_chat);
const mockedSendText = vi.mocked(send_text);
const mockedRegisterTempChat = vi.mocked(register_temp_chat);

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsIpcAvailable.mockResolvedValue(true);
  });

  // ===========================================================================
  // Validation tests
  // ===========================================================================
  describe('parameter validation', () => {
    it('should fail when context is empty', async () => {
      const result = await start_discussion({ context: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('context is required');
    });

    it('should fail when context is missing', async () => {
      const result = await start_discussion({ context: undefined as unknown as string });
      expect(result.success).toBe(false);
      expect(result.error).toContain('context is required');
    });

    it('should fail when neither chatId nor members/topic provided', async () => {
      const result = await start_discussion({ context: 'some context' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Must provide chatId');
    });

    it('should fail when IPC is unavailable', async () => {
      mockedIsIpcAvailable.mockResolvedValue(false);
      const result = await start_discussion({
        chatId: 'oc_test',
        context: 'test context',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC service unavailable');
    });
  });

  // ===========================================================================
  // Use existing chat (chatId provided)
  // ===========================================================================
  describe('using existing chat', () => {
    it('should send context to existing chat and return immediately', async () => {
      mockedSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        topic: '代码审查',
        context: '请审查 PR #123 的改动。',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing');
      expect(result.topic).toBe('代码审查');

      // Should NOT create a new chat
      expect(mockedCreateChat).not.toHaveBeenCalled();

      // Should send context as message with topic header
      expect(mockedSendText).toHaveBeenCalledWith({
        text: '📋 **讨论主题**: 代码审查\n\n请审查 PR #123 的改动。',
        chatId: 'oc_existing',
      });

      // Should NOT register temp chat (no expiresAt)
      expect(mockedRegisterTempChat).not.toHaveBeenCalled();
    });

    it('should send context without topic header when topic not provided', async () => {
      mockedSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        context: '直接发送的讨论内容',
      });

      expect(result.success).toBe(true);
      expect(mockedSendText).toHaveBeenCalledWith({
        text: '直接发送的讨论内容',
        chatId: 'oc_existing',
      });
    });

    it('should fail when send_text fails', async () => {
      mockedSendText.mockResolvedValue({
        success: false,
        error: 'Chat not found',
        message: '❌ Chat not found',
      });

      const result = await start_discussion({
        chatId: 'oc_nonexistent',
        context: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.chatId).toBe('oc_nonexistent');
      expect(result.error).toContain('Chat not found');
    });
  });

  // ===========================================================================
  // Create new chat (members/topic provided)
  // ===========================================================================
  describe('creating new chat', () => {
    it('should create chat, send context, and return immediately', async () => {
      mockedCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_chat',
        name: '讨论: 代码格式化策略',
        message: '✅ Group chat created',
      });
      mockedSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        topic: '代码格式化策略',
        members: ['ou_abc', 'ou_def'],
        context: '团队需要讨论代码格式化方案。',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
      expect(result.topic).toBe('代码格式化策略');

      // Should create chat with topic as name
      expect(mockedCreateChat).toHaveBeenCalledWith({
        name: '代码格式化策略',
        description: '讨论: 代码格式化策略',
        memberIds: ['ou_abc', 'ou_def'],
      });

      // Should send context to the new chat
      expect(mockedSendText).toHaveBeenCalledWith({
        text: '📋 **讨论主题**: 代码格式化策略\n\n团队需要讨论代码格式化方案。',
        chatId: 'oc_new_chat',
      });
    });

    it('should fail when create_chat fails', async () => {
      mockedCreateChat.mockResolvedValue({
        success: false,
        error: 'Permission denied',
        message: '❌ Permission denied',
      });

      const result = await start_discussion({
        topic: '测试讨论',
        members: ['ou_abc'],
        context: '讨论内容',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
      expect(mockedSendText).not.toHaveBeenCalled();
    });

    it('should work with topic only (no members)', async () => {
      mockedCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_topic_only',
        name: '讨论: 仅主题',
        message: '✅ Group chat created',
      });
      mockedSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });

      const result = await start_discussion({
        topic: '仅主题',
        context: '不需要指定成员的讨论。',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_topic_only');
    });
  });

  // ===========================================================================
  // Lifecycle management (expiresAt)
  // ===========================================================================
  describe('lifecycle management', () => {
    it('should register temp chat when expiresAt is provided (existing chat)', async () => {
      mockedSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });
      mockedRegisterTempChat.mockResolvedValue({
        success: true,
        chatId: 'oc_existing',
        expiresAt: '2026-04-01T10:00:00.000Z',
        message: '✅ Temporary chat registered',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        topic: '临时讨论',
        context: '限时讨论内容',
        expiresAt: '2026-04-01T10:00:00.000Z',
      });

      expect(result.success).toBe(true);
      expect(mockedRegisterTempChat).toHaveBeenCalledWith({
        chatId: 'oc_existing',
        expiresAt: '2026-04-01T10:00:00.000Z',
        context: { topic: '临时讨论', source: 'start_discussion' },
      });
    });

    it('should register temp chat when expiresAt is provided (new chat)', async () => {
      mockedCreateChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new',
        name: '讨论: 新讨论',
        message: '✅ Group chat created',
      });
      mockedSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });
      mockedRegisterTempChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new',
        expiresAt: '2026-04-01T10:00:00.000Z',
        message: '✅ Temporary chat registered',
      });

      const result = await start_discussion({
        topic: '新讨论',
        context: '新讨论内容',
        expiresAt: '2026-04-01T10:00:00.000Z',
      });

      expect(result.success).toBe(true);
      expect(mockedRegisterTempChat).toHaveBeenCalledWith({
        chatId: 'oc_new',
        expiresAt: '2026-04-01T10:00:00.000Z',
        context: { topic: '新讨论', source: 'start_discussion' },
      });
    });

    it('should succeed even if register_temp_chat fails (non-fatal)', async () => {
      mockedSendText.mockResolvedValue({
        success: true,
        message: '✅ Text message sent',
      });
      mockedRegisterTempChat.mockResolvedValue({
        success: false,
        error: 'Registration failed',
        message: '❌ Registration failed',
      });

      const result = await start_discussion({
        chatId: 'oc_existing',
        context: '讨论内容',
        expiresAt: '2026-04-01T10:00:00.000Z',
      });

      // Should still succeed — temp chat registration is non-fatal
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing');
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================
  describe('error handling', () => {
    it('should handle unexpected errors gracefully', async () => {
      mockedSendText.mockImplementation(() => {
        throw new Error('Unexpected failure');
      });

      const result = await start_discussion({
        chatId: 'oc_test',
        context: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected failure');
    });

    it('should handle non-Error exceptions', async () => {
      mockedSendText.mockImplementation(() => {
        throw 'string error';
      });

      const result = await start_discussion({
        chatId: 'oc_test',
        context: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
