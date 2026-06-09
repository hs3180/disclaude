/**
 * Tests for TopicNotifier.
 * Issue #4031: Push topic group message notifications to local App.
 */
import { describe, it, expect, vi } from 'vitest';
import { TopicNotifier } from './topic-notifier.js';
import type { FeishuMessageEvent } from '@disclaude/core';

function makeEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    message: {
      message_id: 'om_test123',
      chat_id: 'oc_chat001',
      chat_type: 'topic',
      content: '{"text":"Hello world"}',
      message_type: 'text',
      create_time: 1717920000000,
      parent_id: undefined,
      ...overrides.message,
    },
    sender: {
      sender_id: { open_id: 'ou_sender' },
      ...overrides.sender,
    },
  };
}

describe('TopicNotifier', () => {
  describe('shouldNotify', () => {
    it('returns false when disabled', () => {
      const notifier = new TopicNotifier({ enabled: false });
      expect(notifier.shouldNotify(makeEvent())).toBe(false);
    });

    it('returns false for non-topic messages', () => {
      const notifier = new TopicNotifier({ enabled: true, backends: ['osascript'] });
      const event = makeEvent({ message: { chat_type: 'p2p' } });
      expect(notifier.shouldNotify(event)).toBe(false);
    });

    it('returns true for topic group messages when enabled', () => {
      const notifier = new TopicNotifier({ enabled: true, backends: ['osascript'] });
      expect(notifier.shouldNotify(makeEvent())).toBe(true);
    });

    it('filters by chatIds when configured', () => {
      const notifier = new TopicNotifier({
        enabled: true,
        backends: ['osascript'],
        chatIds: ['oc_chat001'],
      });
      expect(notifier.shouldNotify(makeEvent())).toBe(true);

      const otherChat = makeEvent({ message: { chat_id: 'oc_other' } });
      expect(notifier.shouldNotify(otherChat)).toBe(false);
    });
  });

  describe('buildNotification', () => {
    it('builds notification for root post', () => {
      const notifier = new TopicNotifier();
      const notification = notifier.buildNotification(makeEvent());

      expect(notification.type).toBe('topic_group_message');
      expect(notification.chat_id).toBe('oc_chat001');
      expect(notification.thread_id).toBe('om_test123');
      expect(notification.root_id).toBe('om_test123');
      expect(notification.is_reply).toBe(false);
      expect(notification.content).toBe('Hello world');
      expect(notification.sender.open_id).toBe('ou_sender');
    });

    it('builds notification for reply', () => {
      const notifier = new TopicNotifier();
      const event = makeEvent({ message: { parent_id: 'om_parent' } });
      const notification = notifier.buildNotification(event);

      expect(notification.is_reply).toBe(true);
      expect(notification.root_id).toBe('om_parent');
      expect(notification.thread_id).toBe('om_test123');
    });

    it('extracts text from post content', () => {
      const notifier = new TopicNotifier();
      const event = makeEvent({
        message: {
          content: JSON.stringify({
            content: [[{ text: 'Hello ' }, { text: 'world' }]],
          }),
        },
      });
      const notification = notifier.buildNotification(event);
      expect(notification.content).toBe('Hello  world');
    });

    it('handles non-JSON content gracefully', () => {
      const notifier = new TopicNotifier();
      const event = makeEvent({ message: { content: 'plain text' } });
      const notification = notifier.buildNotification(event);
      expect(notification.content).toBe('plain text');
    });
  });

  describe('notify', () => {
    it('skips when shouldNotify is false', async () => {
      const notifier = new TopicNotifier({ enabled: false });
      await notifier.notify(makeEvent());
      // No error thrown = success
    });

    it('sends webhook notification when configured', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 200 }),
      );

      const notifier = new TopicNotifier({
        enabled: true,
        backends: ['webhook'],
        webhookUrl: 'http://localhost:9999/notify',
      });

      await notifier.notify(makeEvent());

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9999/notify',
        expect.objectContaining({ method: 'POST' }),
      );

      fetchSpy.mockRestore();
    });
  });
});
