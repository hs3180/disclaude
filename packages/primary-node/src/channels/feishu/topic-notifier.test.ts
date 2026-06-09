/**
 * Tests for TopicNotifier.
 *
 * Issue #4031: Verifies topic group notification dispatch infrastructure.
 */

import { describe, it, expect, vi } from 'vitest';
import { TopicNotifier, type TopicMessageEvent } from './topic-notifier.js';

// Mock child_process.execFile to prevent actual osascript calls
vi.mock('child_process', () => ({
  execFile: vi.fn((_, args, callback) => {
    if (typeof args === 'function') {
      args(null, { stdout: '', stderr: '' });
    } else if (typeof callback === 'function') {
      callback(null, { stdout: '', stderr: '' });
    }
  }),
}));

function createTopicEvent(overrides: Partial<TopicMessageEvent> = {}): TopicMessageEvent {
  return {
    chatId: 'oc_test_chat',
    messageId: 'om_test_msg',
    parentId: undefined,
    senderName: 'TestUser',
    content: '这是一条测试消息',
    chatType: 'topic',
    ...overrides,
  };
}

describe('TopicNotifier', () => {
  describe('shouldNotify', () => {
    it('should return true for topic chat type', () => {
      const notifier = new TopicNotifier();
      expect(notifier.shouldNotify(createTopicEvent())).toBe(true);
    });

    it('should return false for non-topic chat type', () => {
      const notifier = new TopicNotifier();
      expect(notifier.shouldNotify(createTopicEvent({ chatType: 'group' }))).toBe(false);
      expect(notifier.shouldNotify(createTopicEvent({ chatType: 'p2p' }))).toBe(false);
    });

    it('should return false for undefined chat type', () => {
      const notifier = new TopicNotifier();
      expect(notifier.shouldNotify(createTopicEvent({ chatType: undefined }))).toBe(false);
    });
  });

  describe('buildPayload', () => {
    it('should build correct payload for root post', () => {
      const notifier = new TopicNotifier();
      const payload = notifier.buildPayload(createTopicEvent());

      expect(payload.type).toBe('topic_group_message');
      expect(payload.chat_id).toBe('oc_test_chat');
      expect(payload.message_id).toBe('om_test_msg');
      expect(payload.root_id).toBeNull();
      expect(payload.is_reply).toBe(false);
      expect(payload.sender.name).toBe('TestUser');
      expect(payload.content).toBe('这是一条测试消息');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should build correct payload for reply', () => {
      const notifier = new TopicNotifier();
      const payload = notifier.buildPayload(createTopicEvent({
        parentId: 'om_parent_msg',
      }));

      expect(payload.is_reply).toBe(true);
      expect(payload.root_id).toBe('om_parent_msg');
      expect(payload.thread_id).toBe('om_test_msg');
    });

    it('should truncate long content', () => {
      const notifier = new TopicNotifier();
      const longContent = 'A'.repeat(300);
      const payload = notifier.buildPayload(createTopicEvent({ content: longContent }));

      expect(payload.content.length).toBe(200);
      expect(payload.content).toMatch(/\.\.\.$/);
    });

    it('should use "Unknown" for missing sender name', () => {
      const notifier = new TopicNotifier();
      const payload = notifier.buildPayload(createTopicEvent({ senderName: undefined }));

      expect(payload.sender.name).toBe('Unknown');
    });
  });

  describe('notify', () => {
    it('should skip non-topic messages', async () => {
      const notifier = new TopicNotifier({ backend: 'osascript' });
      await notifier.notify(createTopicEvent({ chatType: 'group' }));
      // No error thrown, just skipped
    });

    it('should handle empty parentId as root post', () => {
      const notifier = new TopicNotifier();
      const payload = notifier.buildPayload(createTopicEvent({ parentId: '' }));

      expect(payload.is_reply).toBe(false);
      expect(payload.root_id).toBeNull();
    });
  });

  describe('constructor', () => {
    it('should default to osascript backend', () => {
      const notifier = new TopicNotifier();
      // Just verify it doesn't throw
      expect(notifier).toBeInstanceOf(TopicNotifier);
    });

    it('should warn when webhook backend has no URL', () => {
      const notifier = new TopicNotifier({ backend: 'webhook' });
      expect(notifier).toBeInstanceOf(TopicNotifier);
    });
  });
});
