/**
 * Tests for start_discussion tool.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp/tools/start-discussion.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../platforms/feishu/group-service.js', () => ({
  getGroupService: () => ({
    createGroup: vi.fn(async () => ({
      chatId: 'oc_new_chat_id',
      name: 'Test Discussion',
      createdAt: Date.now(),
      initialMembers: [],
    })),
  }),
}));

vi.mock('../utils/feishu-api.js', () => ({
  sendMessageToFeishu: vi.fn(async () => {}),
}));

vi.mock('../../ipc/unix-socket-client.js', () => ({
  getIpcClient: () => ({
    feishuSendMessage: vi.fn(async () => ({
      success: true,
      messageId: 'msg_123',
    })),
  }),
}));

vi.mock('fs', () => ({
  existsSync: () => false, // IPC not available, use direct client
}));

import { start_discussion, formatDiscussionPrompt } from './start-discussion.js';

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should fail when context is missing', async () => {
      const result = await start_discussion({
        context: '',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('context is required');
    });

    it('should succeed with valid context', async () => {
      const result = await start_discussion({
        context: 'Test discussion context',
        topic: 'Test Topic',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat_id');
    });
  });

  describe('group creation', () => {
    it('should create new group when members are provided', async () => {
      const result = await start_discussion({
        members: ['ou_user1', 'ou_user2'],
        topic: 'API Integration',
        context: 'We need to discuss the authentication flow',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat_id');
      expect(result.message).toContain('讨论已发起');
      expect(result.message).toContain('API Integration');
    });

    it('should use existing chat when chatId is provided', async () => {
      const result = await start_discussion({
        chatId: 'oc_existing_chat',
        context: 'Following up on previous discussion',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing_chat');
    });

    it('should prefer existing chatId over members', async () => {
      const result = await start_discussion({
        chatId: 'oc_existing_chat',
        members: ['ou_user1'],
        context: 'Test context',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing_chat');
    });
  });

  describe('return value', () => {
    it('should return chatId in success message', async () => {
      const result = await start_discussion({
        members: ['ou_user1'],
        context: 'Test context',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBeDefined();
      expect(result.message).toContain('oc_new_chat_id');
    });

    it('should include topic in success message when provided', async () => {
      const result = await start_discussion({
        members: ['ou_user1'],
        topic: 'Custom Topic',
        context: 'Test context',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Custom Topic');
    });
  });
});
