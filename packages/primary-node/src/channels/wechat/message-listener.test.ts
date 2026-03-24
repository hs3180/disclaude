/**
 * Tests for WeChatMessageListener.
 *
 * Uses real async primitives (no fake timers) to avoid infinite microtask chains
 * when the mock getUpdates resolves immediately.
 *
 * @module channels/wechat/message-listener.test
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WeChatMessageListener } from './message-listener.js';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatGetUpdatesResponse, WeChatRawMessage } from './types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Yield to the event loop (process microtasks + one tick of the macrotask queue).
 * More reliable than `await vi.advanceTimersByTimeAsync(0)` for flushing
 * promise chains that don't involve timers.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Create a mock WeChatApiClient with controllable getUpdates behavior. */
function createMockClient(getUpdatesFn?: (params?: { cursor?: string; signal?: AbortSignal }) => Promise<WeChatGetUpdatesResponse>) {
  return {
    getUpdates: (getUpdatesFn ?? vi.fn().mockResolvedValue({ msg_list: [] })) as (
      params?: { cursor?: string; signal?: AbortSignal }
    ) => Promise<WeChatGetUpdatesResponse>,
    hasToken: vi.fn().mockReturnValue(true),
  } as unknown as WeChatApiClient;
}

/** Create a minimal raw WeChat message for testing. */
function createRawMessage(overrides: Partial<WeChatRawMessage> = {}): WeChatRawMessage {
  return {
    msg_id: 'msg-001',
    from_user_id: 'user-123',
    to_user_id: 'bot-456',
    item_list: [{ type: 1, text_item: { text: 'Hello' } }],
    create_time: 1700000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WeChatMessageListener', () => {
  let messages: Array<{ messageId: string; content: string; chatId: string }>;
  let errors: Error[];

  beforeEach(() => {
    messages = [];
    errors = [];
  });

  describe('start / stop lifecycle', () => {
    it('should start and stop without errors', async () => {
      const client = createMockClient(async () => {
        return new Promise<WeChatGetUpdatesResponse>(() => {}); // hang
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async () => {},
      });

      await listener.start();
      expect(listener.isRunning()).toBe(true);

      listener.stop();
      expect(listener.isRunning()).toBe(false);
    });

    it('should be idempotent on start', async () => {
      const client = createMockClient(async () => new Promise(() => {}));
      const listener = new WeChatMessageListener(client, {
        onMessage: async () => {},
      });

      await listener.start();
      await listener.start(); // Second call should be a no-op

      expect(listener.isRunning()).toBe(true);
      listener.stop();
    });

    it('should be idempotent on stop', () => {
      const client = createMockClient();
      const listener = new WeChatMessageListener(client, {
        onMessage: async () => {},
      });

      listener.stop();
      listener.stop(); // Second call should be a no-op
      expect(listener.isRunning()).toBe(false);
    });
  });

  describe('message processing', () => {
    it('should forward parsed text messages to onMessage', async () => {
      const rawMsg = createRawMessage();
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {}); // hang after first
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async (msg) => {
          messages.push({
            messageId: msg.messageId,
            content: msg.content,
            chatId: msg.chatId,
          });
        },
      });

      await listener.start();
      await yieldToEventLoop(); // Let the first poll complete

      listener.stop();

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        messageId: 'msg-001',
        content: 'Hello',
        chatId: 'user-123',
      });
    });

    it('should deduplicate messages with the same msg_id', async () => {
      const rawMsg = createRawMessage();
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount <= 2) return { msg_list: [rawMsg] }; // Same message twice
        return new Promise<WeChatGetUpdatesResponse>(() => {}); // hang after
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async (msg) => {
          messages.push({ messageId: msg.messageId, content: msg.content, chatId: msg.chatId });
        },
      });

      await listener.start();
      await yieldToEventLoop();
      await yieldToEventLoop();

      listener.stop();

      // Only one message should be forwarded (second was deduplicated)
      expect(messages).toHaveLength(1);
    });

    it('should skip messages without msg_id', async () => {
      const rawMsg = createRawMessage({ msg_id: undefined });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async (msg) => {
          messages.push({ messageId: msg.messageId, content: msg.content, chatId: msg.chatId });
        },
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(messages).toHaveLength(0);
    });

    it('should skip messages without item_list', async () => {
      const rawMsg = createRawMessage({ item_list: [] });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async (msg) => {
          messages.push({ messageId: msg.messageId, content: msg.content, chatId: msg.chatId });
        },
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(messages).toHaveLength(0);
    });

    it('should parse image messages correctly', async () => {
      const rawMsg = createRawMessage({
        msg_id: 'msg-img-001',
        item_list: [{ type: 2, image_item: { image_key: 'img-key-123' } }],
      });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async (msg) => {
          messages.push({
            messageId: msg.messageId,
            content: msg.content,
            chatId: msg.chatId,
          });
        },
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('img-key-123');
    });

    it('should parse file messages correctly', async () => {
      const rawMsg = createRawMessage({
        msg_id: 'msg-file-001',
        item_list: [{ type: 3, file_item: { file_key: 'file-key', file_name: 'doc.pdf' } }],
      });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async (msg) => {
          messages.push({
            messageId: msg.messageId,
            content: msg.content,
            chatId: msg.chatId,
          });
        },
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('doc.pdf');
    });

    it('should map context_token to threadId', async () => {
      const rawMsg = createRawMessage({ context_token: 'ctx-abc' });
      const onMessage = vi.fn();
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage,
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].threadId).toBe('ctx-abc');
    });

    it('should map create_time to timestamp in milliseconds', async () => {
      const rawMsg = createRawMessage({ create_time: 1700000000 });
      const onMessage = vi.fn();
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage,
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].timestamp).toBe(1700000000 * 1000);
    });

    it('should use from_user_id as chatId', async () => {
      const rawMsg = createRawMessage({ from_user_id: 'sender-789' });
      const onMessage = vi.fn();
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage,
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].chatId).toBe('sender-789');
      expect(onMessage.mock.calls[0][0].userId).toBe('sender-789');
    });

    it('should handle unsupported item types gracefully', async () => {
      const rawMsg = createRawMessage({
        msg_id: 'msg-unsupported',
        item_list: [{ type: 99 } as unknown as WeChatRawMessage['item_list'] extends (infer U)[] | undefined ? U : never],
      });
      const onMessage = vi.fn();
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) return { msg_list: [rawMsg as WeChatRawMessage] };
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage,
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].messageType).toBe('text');
      expect(onMessage.mock.calls[0][0].content).toBe('[unsupported message type]');
    });
  });

  describe('cursor tracking', () => {
    it('should pass cursor to subsequent polls', async () => {
      const calls: Array<{ cursor?: string }> = [];
      let callCount = 0;

      const client = createMockClient(async (params) => {
        calls.push({ cursor: params?.cursor as string | undefined });
        callCount++;
        if (callCount <= 2) {
          return { msg_list: [], cursor: `cursor-${callCount}` };
        }
        return new Promise<WeChatGetUpdatesResponse>(() => {}); // hang after
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async () => {},
      });

      await listener.start();
      await yieldToEventLoop();
      await yieldToEventLoop();
      listener.stop();

      // First call: no cursor
      expect(calls[0].cursor).toBeUndefined();
      // Second call: cursor from first response
      expect(calls[1].cursor).toBe('cursor-1');
    });
  });

  describe('error handling', () => {
    it('should call onError on poll failure and continue', async () => {
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        return new Promise<WeChatGetUpdatesResponse>(() => {}); // hang after
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async () => {},
        onError: (err) => errors.push(err),
        retryDelayMs: 10,
      });

      await listener.start();
      await yieldToEventLoop(); // First poll fails

      // Wait for retry delay
      await new Promise((resolve) => setTimeout(resolve, 50));

      listener.stop();

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Network error');
    });

    it('should stop cleanly when stop() is called during poll', async () => {
      const client = createMockClient(async () => {
        // Simulate a long-running poll
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async () => {},
      });

      await listener.start();
      expect(listener.isRunning()).toBe(true);

      // Stop while poll is pending
      listener.stop();
      expect(listener.isRunning()).toBe(false);
    });
  });

  describe('deduplication cache', () => {
    it('should evict cache entries when max size is reached', async () => {
      const maxCacheSize = 5;
      const rawMessages: WeChatRawMessage[] = Array.from({ length: 7 }, (_, i) =>
        createRawMessage({ msg_id: `msg-${i}` })
      );

      let callCount = 0;
      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { msg_list: rawMessages.slice(0, 6) }; // 6 messages (exceeds max 5)
        }
        return new Promise<WeChatGetUpdatesResponse>(() => {});
      });

      const listener = new WeChatMessageListener(client, {
        onMessage: async (msg) => {
          messages.push({ messageId: msg.messageId, content: msg.content, chatId: msg.chatId });
        },
        maxDedupCacheSize: maxCacheSize,
      });

      await listener.start();
      await yieldToEventLoop();
      listener.stop();

      // All 6 messages should be forwarded (none are duplicates yet)
      expect(messages).toHaveLength(6);
    });
  });
});
