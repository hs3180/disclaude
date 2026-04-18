/**
 * Tests for WeChatMessageListener.
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import { WeChatMessageListener } from './message-listener.js';
import type { WeChatApiClient } from './api-client.js';

// Store original fetch
const originalFetch = globalThis.fetch;

describe('WeChatMessageListener', () => {
  /** Helper to get the first call's first argument from mockProcessor. */
  function getFirstMessage() {
    return mockProcessor.mock.calls[0][0];
  }
  let mockClient: Partial<WeChatApiClient>;
  let mockProcessor: ReturnType<typeof vi.fn>;
  let listener: WeChatMessageListener;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockProcessor = vi.fn().mockResolvedValue(undefined);
    mockClient = {
      getUpdates: vi.fn().mockResolvedValue([]),
    };

    listener = new WeChatMessageListener(
      mockClient as WeChatApiClient,
      mockProcessor,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  describe('start / stop lifecycle', () => {
    it('should start and stop cleanly', async () => {
      // Make getUpdates throw AbortError after one call to exit loop
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        return Promise.resolve([]);
      });

      listener.start();
      expect(listener.isListening()).toBe(true);

      await listener.stop();
      expect(listener.isListening()).toBe(false);
    });

    it('should warn when start is called while already running', () => {
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        return new Promise(() => {}); // never resolves
      });

      listener.start();
      listener.start(); // second call

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('already running'),
      );
    });

    it('should be safe to call stop multiple times', async () => {
      // Make getUpdates throw AbortError after first call to exit loop
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        return Promise.resolve([]);
      });

      listener.start();
      await vi.advanceTimersByTimeAsync(50);

      await listener.stop();
      await listener.stop(); // second call should be no-op
      expect(listener.isListening()).toBe(false);
    });

    it('should clear dedup cache on stop', async () => {
      // Make getUpdates throw AbortError to exit loop
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        return Promise.resolve([]);
      });

      // Access private seenMessageIds via any
      (listener as any).seenMessageIds.add('msg-1');
      (listener as any).seenMessageIds.add('msg-2');

      listener.start();
      await listener.stop();

      expect((listener as any).seenMessageIds.size).toBe(0);
    });
  });

  describe('message processing', () => {
    it('should process text updates', async () => {
      const update = {
        msg_id: 'msg-1',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'Hello bot!' } }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]); // exit after first poll

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const message = getFirstMessage();
      expect(message.messageId).toBe('msg-1');
      expect(message.chatId).toBe('user-123');
      expect(message.userId).toBe('user-123');
      expect(message.content).toBe('Hello bot!');
      expect(message.messageType).toBe('text');
      expect(message.timestamp).toBe(1710000000000);
    });

    it('should process image updates', async () => {
      const update = {
        msg_id: 'msg-img-1',
        from_user_id: 'user-456',
        item_list: [{ type: 2, image_item: { url: 'https://cdn.example.com/img.png', width: 800, height: 600 } }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const message = getFirstMessage();
      expect(message.messageType).toBe('image');
      expect(message.content).toBe('[Image received]');
      expect(message.attachments).toEqual([{
        fileName: 'image',
        filePath: 'https://cdn.example.com/img.png',
      }]);
    });

    it('should process file updates', async () => {
      const update = {
        msg_id: 'msg-file-1',
        from_user_id: 'user-789',
        item_list: [{ type: 3, file_item: { url: 'https://cdn.example.com/doc.pdf', file_name: 'doc.pdf', file_size: 1024 } }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const message = getFirstMessage();
      expect(message.messageType).toBe('file');
      expect(message.content).toBe('[File received: doc.pdf]');
      expect(message.attachments).toEqual([{
        fileName: 'doc.pdf',
        filePath: 'https://cdn.example.com/doc.pdf',
        size: 1024,
      }]);
    });

    it('should handle unknown message types by extracting text', async () => {
      const update = {
        msg_id: 'msg-unknown-1',
        from_user_id: 'user-100',
        item_list: [{ type: 99, some_field: 'data' }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const message = getFirstMessage();
      expect(message.messageType).toBe('text');
      expect(message.content).toBe('[Unsupported message type: 99]');
    });

    it('should include context_token as threadId', async () => {
      const update = {
        msg_id: 'msg-thread-1',
        from_user_id: 'user-200',
        item_list: [{ type: 1, text_item: { text: 'Reply in thread' } }],
        context_token: 'ctx-token-abc',
        create_time: 1710000000,
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      const message = getFirstMessage();
      expect(message.threadId).toBe('ctx-token-abc');
    });

    it('should skip updates without msg_id', async () => {
      const update = {
        from_user_id: 'user-100',
        item_list: [{ type: 1, text_item: { text: 'No ID' } }],
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).not.toHaveBeenCalled();
    });

    it('should skip updates without from_user_id', async () => {
      const update = {
        msg_id: 'msg-no-user',
        item_list: [{ type: 1, text_item: { text: 'No user' } }],
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).not.toHaveBeenCalled();
    });

    it('should skip updates without item_list', async () => {
      const update = {
        msg_id: 'msg-no-items',
        from_user_id: 'user-100',
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).not.toHaveBeenCalled();
    });
  });

  describe('deduplication', () => {
    it('should deduplicate messages with the same msg_id', async () => {
      const update = {
        msg_id: 'msg-dup-1',
        from_user_id: 'user-100',
        item_list: [{ type: 1, text_item: { text: 'Hello' } }],
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([update]) // same message again
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
    });

    it('should evict dedup cache when exceeding limit', () => {
      // Directly test the eviction behavior
      const seenIds = (listener as any).seenMessageIds as Set<string>;
      const MAX_SIZE = 10_000;

      // Fill beyond limit
      for (let i = 0; i < MAX_SIZE + 100; i++) {
        seenIds.add(`msg-${i}`);
      }

      expect(seenIds.size).toBe(MAX_SIZE + 100);

      // Trigger eviction
      (listener as any).evictDedupCacheIfNeeded();

      expect(seenIds.size).toBeLessThanOrEqual(MAX_SIZE);
      // Should have evicted 5000 entries
      expect(seenIds.size).toBe(MAX_SIZE - 4900); // 5100 - 5000 = 100 remaining
    });
  });

  describe('error handling and backoff', () => {
    it('should continue polling after transient error', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(({ signal }) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        if (callCount === 2) {
          // Recovery: return empty results
          return Promise.resolve([]);
        }
        // After recovery, simulate long-poll that responds to abort
        return new Promise((_, reject) => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          signal?.addEventListener('abort', () => reject(err), { once: true });
        });
      });

      listener.start();
      // Advance past the backoff period (2000ms) plus recovery poll
      await vi.advanceTimersByTimeAsync(5000);
      await listener.stop();

      // Should have retried after backoff (call 1: error, call 2: recovery)
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should stop gracefully on AbortError', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockClient.getUpdates = vi.fn().mockRejectedValue(abortError);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      expect(listener.isListening()).toBe(false);
    });

    it('should apply exponential backoff on consecutive errors', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        throw new Error(`Persistent error ${callCount}`);
      });

      listener.start();

      // Let several error+backoff cycles happen
      await vi.advanceTimersByTimeAsync(100_000);
      await listener.stop();

      // With exponential backoff (2s, 4s, 8s, 16s, 30s, 30s...),
      // we should see fewer calls than if there were no backoff
      expect(callCount).toBeLessThan(20);
    });

    it('should catch processor errors without stopping', async () => {
      const update = {
        msg_id: 'msg-err-1',
        from_user_id: 'user-100',
        item_list: [{ type: 1, text_item: { text: 'Cause error' } }],
      };

      mockProcessor.mockRejectedValue(new Error('Processor failed'));
      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      // Should still have processed the message (and logged the error)
      expect(mockProcessor).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'Processor failed' }),
        'Message processor failed',
      );
    });
  });

  describe('timestamp handling', () => {
    it('should use create_time when available', async () => {
      const update = {
        msg_id: 'msg-ts-1',
        from_user_id: 'user-100',
        item_list: [{ type: 1, text_item: { text: 'Hello' } }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      const message = getFirstMessage();
      expect(message.timestamp).toBe(1710000000000);
    });

    it('should fallback to Date.now() when create_time is missing', async () => {
      const before = Date.now();
      const update = {
        msg_id: 'msg-ts-2',
        from_user_id: 'user-100',
        item_list: [{ type: 1, text_item: { text: 'Hello' } }],
      };

      mockClient.getUpdates = vi.fn()
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([]);

      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();

      const after = Date.now();
      const message = getFirstMessage();
      expect(message.timestamp).toBeGreaterThanOrEqual(before);
      expect(message.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('isListening', () => {
    it('should return false before start', () => {
      expect(listener.isListening()).toBe(false);
    });

    it('should return true after start', () => {
      mockClient.getUpdates = vi.fn().mockImplementation(() => new Promise(() => {}));
      listener.start();
      expect(listener.isListening()).toBe(true);
    });

    it('should return false after stop', async () => {
      mockClient.getUpdates = vi.fn().mockResolvedValue([]);
      listener.start();
      await vi.advanceTimersByTimeAsync(100);
      await listener.stop();
      expect(listener.isListening()).toBe(false);
    });
  });
});
