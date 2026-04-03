/**
 * Tests for WeChatMessageListener (Phase 3 — Issue #1556).
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatMessageListener } from './message-listener.js';
import type { GetUpdatesResponse } from './types.js';

// Mock the core logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/** Create a mock API client with configurable getUpdates behavior. */
function createMockClient(getUpdatesFn?: (opts?: { timeoutMs?: number; cursor?: string }) => Promise<GetUpdatesResponse>) {
  return {
    getUpdates: getUpdatesFn ?? vi.fn().mockResolvedValue({ ret: 0, update_list: [] }),
    hasToken: vi.fn().mockReturnValue(true),
  } as any;
}

/** Create a text message update. */
function createTextUpdate(overrides: Record<string, unknown> = {}): any {
  return {
    msg_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from_user_id: 'user-123',
    to_user_id: 'bot-456',
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: 'Hello from WeChat' } }],
    create_time: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('WeChatMessageListener', () => {
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create listener with default config', () => {
      const client = createMockClient();
      const listener = new WeChatMessageListener(client, onMessage);

      expect(listener.isListening()).toBe(false);
      expect(listener.getDedupSize()).toBe(0);
    });

    it('should create listener with custom config', () => {
      const client = createMockClient();
      const listener = new WeChatMessageListener(client, onMessage, {
        maxDedupSize: 100,
        maxConsecutiveErrors: 5,
        pollTimeoutMs: 10_000,
      });

      expect(listener.isListening()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start the listener', () => {
      const client = createMockClient();
      const listener = new WeChatMessageListener(client, onMessage);

      listener.start();
      expect(listener.isListening()).toBe(true);
    });

    it('should not start twice', () => {
      const client = createMockClient();
      const listener = new WeChatMessageListener(client, onMessage);

      listener.start();
      listener.start(); // Second call should warn but not throw
      expect(listener.isListening()).toBe(true);
    });

    it('should stop the listener', async () => {
      // Use a client that returns empty results immediately
      const client = createMockClient(async () => {
        // Return immediately on first call, then the loop continues
        await new Promise((r) => setTimeout(r, 10));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      expect(listener.isListening()).toBe(true);

      // Give the poll loop time to start
      await new Promise((r) => setTimeout(r, 50));

      await listener.stop();
      expect(listener.isListening()).toBe(false);
    });

    it('should be safe to call stop when not started', async () => {
      const client = createMockClient();
      const listener = new WeChatMessageListener(client, onMessage);

      await listener.stop(); // Should not throw
      expect(listener.isListening()).toBe(false);
    });
  });

  describe('message processing', () => {
    it('should call onMessage for text messages', async () => {
      const update = createTextUpdate();
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { ret: 0, update_list: [update] };
        }
        // After first call, abort the loop
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();

      // Wait for the first poll to process
      await new Promise((r) => setTimeout(r, 50));

      await listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      const received = onMessage.mock.calls[0][0];
      expect(received.messageId).toBe(update.msg_id);
      expect(received.chatId).toBe('user-123');
      expect(received.userId).toBe('user-123');
      expect(received.content).toBe('Hello from WeChat');
      expect(received.messageType).toBe('text');
      expect(received.timestamp).toBeDefined();
    });

    it('should deduplicate messages with same ID', async () => {
      const update = createTextUpdate({ msg_id: 'duplicate-msg-id' });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount <= 2) {
          return { ret: 0, update_list: [update] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 200));
      await listener.stop();

      // Same message ID should only trigger onMessage once
      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it('should skip updates without msg_id', async () => {
      const update = createTextUpdate({ msg_id: undefined });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { ret: 0, update_list: [update] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('should skip updates without from_user_id', async () => {
      const update = createTextUpdate({ from_user_id: undefined });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { ret: 0, update_list: [update] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('should skip unsupported message types', async () => {
      const update = createTextUpdate({ message_type: 99 });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { ret: 0, update_list: [update] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('should handle image messages', async () => {
      const update = createTextUpdate({
        message_type: 2,
        item_list: [{ type: 2, image_item: { image_url: 'https://example.com/img.png' } }],
      });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { ret: 0, update_list: [update] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      const received = onMessage.mock.calls[0][0];
      expect(received.messageType).toBe('image');
      expect(received.content).toBe('[Image]');
      expect(received.attachments).toBeDefined();
      expect(received.attachments?.[0].fileName).toBe('image');
    });

    it('should handle file messages', async () => {
      const update = createTextUpdate({
        message_type: 3,
        item_list: [{ type: 3, file_item: { file_name: 'doc.pdf', file_url: 'https://example.com/doc.pdf', file_size: 1024 } }],
      });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { ret: 0, update_list: [update] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      const received = onMessage.mock.calls[0][0];
      expect(received.messageType).toBe('file');
      expect(received.content).toBe('[File: doc.pdf]');
      expect(received.attachments).toBeDefined();
      expect(received.attachments?.[0].fileName).toBe('doc.pdf');
      expect(received.attachments?.[0].size).toBe(1024);
    });

    it('should preserve context_token as threadId', async () => {
      const update = createTextUpdate({ context_token: 'ctx-token-abc' });
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          return { ret: 0, update_list: [update] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(onMessage).toHaveBeenCalledTimes(1);
      const received = onMessage.mock.calls[0][0];
      expect(received.threadId).toBe('ctx-token-abc');
    });
  });

  describe('error handling', () => {
    it('should stop after max consecutive errors', async () => {
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        throw new Error('API server error');
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        maxConsecutiveErrors: 3,
        pollTimeoutMs: 100,
        backoffBaseMs: 10,
        backoffMaxMs: 50,
      });

      listener.start();

      // Wait for the listener to stop due to max errors
      await new Promise((r) => setTimeout(r, 1000));

      expect(listener.isListening()).toBe(false);
      expect(callCount).toBeGreaterThanOrEqual(3);
      await listener.stop();
    });

    it('should use exponential backoff between retries', async () => {
      const timestamps: number[] = [];
      let callCount = 0;

      const client = createMockClient(async () => {
        timestamps.push(Date.now());
        callCount++;
        if (callCount <= 3) {
          throw new Error('Temporary error');
        }
        // After 3 errors, return success to verify backoff happened
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        maxConsecutiveErrors: 10,
        pollTimeoutMs: 100,
        backoffBaseMs: 50,
        backoffMaxMs: 200,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 2000));
      await listener.stop();

      // Verify there were delays between retries (not immediate)
      if (timestamps.length >= 2) {
        for (let i = 1; i < timestamps.length; i++) {
          const delay = timestamps[i] - timestamps[i - 1];
          // Should have at least some delay (backoff + jitter)
          expect(delay).toBeGreaterThan(10);
        }
      }
    });
  });

  describe('deduplication', () => {
    it('should evict dedup set when it exceeds max size', async () => {
      const maxSize = 5;
      const updates = Array.from({ length: 8 }, (_, i) =>
        createTextUpdate({ msg_id: `msg-${i}` }),
      );
      let callCount = 0;

      const client = createMockClient(async () => {
        callCount++;
        if (callCount === 1) {
          // Send first batch of messages
          return { ret: 0, update_list: updates.slice(0, 6) };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        maxDedupSize: maxSize,
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      // All 6 messages should have been processed (first 5 fill set, 6th triggers eviction)
      expect(onMessage).toHaveBeenCalledTimes(6);
    });
  });

  describe('cursor pagination', () => {
    it('should pass cursor on subsequent polls', async () => {
      const update = createTextUpdate();
      let callCount = 0;
      const cursors: string[] = [];

      const client = createMockClient(async (opts?: { cursor?: string }) => {
        callCount++;
        cursors.push(opts?.cursor ?? '');

        if (callCount === 1) {
          return { ret: 0, cursor: 'cursor-1', update_list: [update] };
        }
        if (callCount === 2) {
          return { ret: 0, cursor: 'cursor-2', update_list: [] };
        }
        await new Promise((r) => setTimeout(r, 1000));
        return { ret: 0, update_list: [] };
      });

      const listener = new WeChatMessageListener(client, onMessage, {
        pollTimeoutMs: 100,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 200));
      await listener.stop();

      // First poll: no cursor
      expect(cursors[0]).toBe('');
      // Second poll: should pass cursor from first response
      expect(cursors[1]).toBe('cursor-1');
    });
  });
});
