/**
 * Tests for start_discussion tool.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * @module mcp/tools/start-discussion.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  start_discussion,
  registerDiscussionCallback,
  getDiscussionCallback,
  unregisterDiscussionCallback,
  cleanupExpiredDiscussionCallbacks,
} from './start-discussion.js';
import * as chatOps from '../../platforms/feishu/chat-ops.js';
import * as sendMessageModule from './send-message.js';

// Mock dependencies
vi.mock('../../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn(() => ({})),
}));

vi.mock('../../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  },
}));

vi.mock('../../platforms/feishu/chat-ops.js', () => ({
  createDiscussionChat: vi.fn(),
}));

vi.mock('./send-message.js', () => ({
  send_message: vi.fn(),
  getMessageSentCallback: vi.fn(() => null),
}));

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should fail without topic', async () => {
      const result = await start_discussion({
        topic: '',
        message: 'Test message',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('topic is required');
    });

    it('should fail without message', async () => {
      const result = await start_discussion({
        topic: 'Test topic',
        message: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('message is required');
    });
  });

  describe('with existing chatId', () => {
    it('should send message to existing chat', async () => {
      vi.mocked(sendMessageModule.send_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
      });

      const result = await start_discussion({
        topic: 'Test discussion',
        message: 'Hello everyone!',
        chatId: 'oc_test_chat',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_test_chat');
      expect(result.isNewGroup).toBeFalsy();
      expect(result.message).toContain('现有群中发起');
    });

    it('should handle message send failure', async () => {
      vi.mocked(sendMessageModule.send_message).mockResolvedValue({
        success: false,
        message: 'Send failed',
        error: 'Network error',
      });

      const result = await start_discussion({
        topic: 'Test discussion',
        message: 'Hello everyone!',
        chatId: 'oc_test_chat',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('creating new group', () => {
    it('should create new group and send message', async () => {
      vi.mocked(chatOps.createDiscussionChat).mockResolvedValue('oc_new_chat');
      vi.mocked(sendMessageModule.send_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
      });

      const result = await start_discussion({
        topic: 'New Discussion',
        message: 'Let us discuss this topic',
        members: ['ou_user1', 'ou_user2'],
        creatorId: 'ou_creator',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_chat');
      expect(result.isNewGroup).toBe(true);
      expect(result.groupInfo).toBeDefined();
      expect(result.groupInfo?.name).toBe('New Discussion');
      expect(result.message).toContain('已创建');

      // Verify createDiscussionChat was called with correct params
      expect(chatOps.createDiscussionChat).toHaveBeenCalledWith(
        expect.anything(),
        { topic: 'New Discussion', members: ['ou_user1', 'ou_user2'] },
        'ou_creator'
      );
    });

    it('should handle group creation failure', async () => {
      vi.mocked(chatOps.createDiscussionChat).mockRejectedValue(new Error('API error'));

      const result = await start_discussion({
        topic: 'Failed Discussion',
        message: 'This will fail',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });

    it('should register group as topic group when isTopicGroup is true', async () => {
      vi.mocked(chatOps.createDiscussionChat).mockResolvedValue('oc_topic_chat');
      vi.mocked(sendMessageModule.send_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
      });

      const result = await start_discussion({
        topic: 'Topic Group',
        message: 'Topic group message',
        isTopicGroup: true,
      });

      expect(result.success).toBe(true);
      expect(result.groupInfo?.isTopicGroup).toBe(true);
    });
  });
});

describe('Discussion callback management', () => {
  beforeEach(() => {
    // Clear all callbacks before each test
    cleanupExpiredDiscussionCallbacks();
  });

  describe('registerDiscussionCallback', () => {
    it('should register callback for chat', () => {
      const callback = vi.fn();
      registerDiscussionCallback('oc_test', callback, 'test-context');

      const registered = getDiscussionCallback('oc_test');
      expect(registered).toBeDefined();
      expect(registered?.callback).toBe(callback);
      expect(registered?.context).toBe('test-context');
    });

    it('should overwrite existing callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      registerDiscussionCallback('oc_test', callback1);
      registerDiscussionCallback('oc_test', callback2, 'new-context');

      const registered = getDiscussionCallback('oc_test');
      expect(registered?.callback).toBe(callback2);
      expect(registered?.context).toBe('new-context');
    });
  });

  describe('getDiscussionCallback', () => {
    it('should return undefined for unregistered chat', () => {
      const result = getDiscussionCallback('oc_nonexistent');
      expect(result).toBeUndefined();
    });

    it('should return callback for registered chat', () => {
      const callback = vi.fn();
      registerDiscussionCallback('oc_test', callback);

      const result = getDiscussionCallback('oc_test');
      expect(result?.callback).toBe(callback);
    });
  });

  describe('unregisterDiscussionCallback', () => {
    it('should remove registered callback', () => {
      const callback = vi.fn();
      registerDiscussionCallback('oc_test', callback);

      const removed = unregisterDiscussionCallback('oc_test');
      expect(removed).toBe(true);

      const result = getDiscussionCallback('oc_test');
      expect(result).toBeUndefined();
    });

    it('should return false for non-existent callback', () => {
      const removed = unregisterDiscussionCallback('oc_nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('cleanupExpiredDiscussionCallbacks', () => {
    it('should not remove recent callbacks', () => {
      const callback = vi.fn();
      registerDiscussionCallback('oc_test', callback);

      const cleaned = cleanupExpiredDiscussionCallbacks();
      expect(cleaned).toBe(0);

      const result = getDiscussionCallback('oc_test');
      expect(result).toBeDefined();
    });
  });
});
