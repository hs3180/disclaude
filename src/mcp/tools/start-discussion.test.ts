/**
 * Tests for start_discussion tool.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp/tools/start-discussion.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock functions
const mockSendMessage = vi.hoisted(() => vi.fn().mockResolvedValue({
  success: true,
  message: 'Message sent successfully',
}));

const mockCreateDiscussionChat = vi.hoisted(() => vi.fn().mockResolvedValue('oc_test_chat_id'));

const mockRegisterGroup = vi.hoisted(() => vi.fn());

// Mock modules BEFORE importing the module under test
vi.mock('../../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  },
}));

vi.mock('../../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn(() => ({
    im: {
      chat: {
        create: vi.fn().mockResolvedValue({
          data: { chat_id: 'oc_test_chat_id' },
        }),
      },
    },
  })),
}));

vi.mock('../../services/index.js', () => ({
  isLarkClientServiceInitialized: vi.fn(() => false),
  getLarkClientService: vi.fn(),
}));

vi.mock('../../platforms/feishu/chat-ops.js', () => ({
  createDiscussionChat: mockCreateDiscussionChat,
}));

vi.mock('../../platforms/feishu/group-service.js', () => ({
  getGroupService: vi.fn(() => ({
    registerGroup: mockRegisterGroup,
  })),
}));

// Mock send-message module
vi.mock('./send-message.js', () => ({
  send_message: mockSendMessage,
}));

// Import AFTER mocks are set up
import { start_discussion } from './start-discussion.js';

describe('start_discussion', () => {
  beforeEach(() => {
    // Reset mock return values for each test
    mockSendMessage.mockResolvedValue({
      success: true,
      message: 'Message sent successfully',
    });
    mockCreateDiscussionChat.mockResolvedValue('oc_test_chat_id');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('parameter validation', () => {
    it('should return error when topic is missing', async () => {
      const result = await start_discussion({
        topic: '',
        members: ['ou_test'],
        context: 'Test context',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('topic is required');
    });

    it('should return error when context is missing', async () => {
      const result = await start_discussion({
        topic: 'Test Topic',
        members: ['ou_test'],
        context: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('context is required');
    });
  });

  describe('successful discussion creation', () => {
    it('should create discussion with valid parameters', async () => {
      const result = await start_discussion({
        topic: 'API Design Discussion',
        members: ['ou_user1', 'ou_user2'],
        context: 'We need to discuss the new API design.',
      });

      // Debug: log the result if test fails
      if (!result.success) {
        console.log('Test failed with result:', JSON.stringify(result, null, 2));
      }

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_test_chat_id');
      expect(result.message).toContain('离线讨论已启动');
      expect(result.message).toContain('API Design Discussion');
    });

    it('should include member count in success message', async () => {
      const result = await start_discussion({
        topic: 'Test Topic',
        members: ['ou_user1', 'ou_user2', 'ou_user3'],
        context: 'Test context',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('成员数**: 3');
    });

    it('should work with empty members array', async () => {
      const result = await start_discussion({
        topic: 'Solo Discussion',
        members: [],
        context: 'Just me thinking aloud',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('成员数**: 0');
    });
  });

  describe('error handling', () => {
    it('should handle message send failure gracefully', async () => {
      // Mock send_message to fail
      mockSendMessage.mockResolvedValueOnce({
        success: false,
        error: 'Network error',
        message: 'Failed to send',
      });

      const result = await start_discussion({
        topic: 'Test Topic',
        members: ['ou_test'],
        context: 'Test context',
      });

      // Should still return success for group creation
      expect(result.success).toBe(true);
      expect(result.message).toContain('发送上下文失败');
    });
  });
});
