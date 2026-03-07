/**
 * Tests for create_chat MCP tool.
 *
 * @see Issue #393 - Phase 2: Create group chat for PR discussions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create_chat } from './create-chat.js';

// Mock dependencies
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  },
}));

vi.mock('../../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn(() => ({})),
}));

vi.mock('../../platforms/feishu/chat-ops.js', () => ({
  createDiscussionChat: vi.fn(),
}));

import { createDiscussionChat } from '../../platforms/feishu/chat-ops.js';

describe('create_chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a chat with topic and members', async () => {
    const mockCreateDiscussionChat = createDiscussionChat as ReturnType<typeof vi.fn>;
    mockCreateDiscussionChat.mockResolvedValue('oc_new_chat_123');

    const result = await create_chat({
      topic: 'PR #123: Fix bug',
      members: ['ou_user_1', 'ou_user_2'],
    });

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('oc_new_chat_123');
    expect(result.message).toContain('Chat created');
    expect(mockCreateDiscussionChat).toHaveBeenCalledWith(
      expect.anything(),
      {
        topic: 'PR #123: Fix bug',
        members: ['ou_user_1', 'ou_user_2'],
      }
    );
  });

  it('should create a chat with only topic', async () => {
    const mockCreateDiscussionChat = createDiscussionChat as ReturnType<typeof vi.fn>;
    mockCreateDiscussionChat.mockResolvedValue('oc_new_chat_456');

    const result = await create_chat({
      topic: 'Discussion Group',
    });

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('oc_new_chat_456');
    expect(mockCreateDiscussionChat).toHaveBeenCalledWith(
      expect.anything(),
      {
        topic: 'Discussion Group',
        members: undefined,
      }
    );
  });

  it('should create a chat without any parameters', async () => {
    const mockCreateDiscussionChat = createDiscussionChat as ReturnType<typeof vi.fn>;
    mockCreateDiscussionChat.mockResolvedValue('oc_new_chat_789');

    const result = await create_chat({});

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('oc_new_chat_789');
  });

  it('should return error when Feishu credentials not configured', async () => {
    // Re-mock config to return no credentials
    vi.resetModules();
    vi.doMock('../../config/index.js', () => ({
      Config: {
        FEISHU_APP_ID: undefined,
        FEISHU_APP_SECRET: undefined,
      },
    }));

    const { create_chat: createChatNoCreds } = await import('./create-chat.js');

    const result = await createChatNoCreds({ topic: 'Test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Feishu credentials not configured');
  });

  it('should return error when chat creation fails', async () => {
    const mockCreateDiscussionChat = createDiscussionChat as ReturnType<typeof vi.fn>;
    mockCreateDiscussionChat.mockRejectedValue(new Error('API error: permission denied'));

    const result = await create_chat({
      topic: 'Test Chat',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('API error: permission denied');
    expect(result.message).toContain('Failed to create chat');
  });
});
