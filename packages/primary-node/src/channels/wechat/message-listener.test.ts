/**
 * Tests for WeChatMessageListener.
 *
 * Tests the long-poll based message listener with mocked API client.
 * Uses real timers with short delays to avoid fake timer memory issues.
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate } from './types.js';

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

/**
 * Helper: create a mock getUpdates that returns data once then aborts.
 */
function createSingleShotGetUpdates(updates: WeChatUpdate[]) {
  let called = false;
  return vi.fn().mockImplementation(async () => {
    if (called) {
      throw new DOMException('Aborted', 'AbortError');
    }
    called = true;
    return updates;
  });
}

/**
 * Helper: create a mock getUpdates that resolves N times then aborts.
 */
function createMultiShotGetUpdates(updates: WeChatUpdate[][], signal?: AbortSignal) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    if (signal?.aborted || callIndex >= updates.length) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const result = updates[callIndex];
    callIndex++;
    return result;
  });
}

describe('WeChatMessageListener', () => {
  let WeChatMessageListener: typeof import('./message-listener.js').WeChatMessageListener;
  let mockClient: Partial<WeChatApiClient>;
  let messageProcessor: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const mod = await import('./message-listener.js');
    WeChatMessageListener = mod.WeChatMessageListener;

    messageProcessor = vi.fn().mockResolvedValue(undefined);

    mockClient = {
      getUpdates: vi.fn().mockResolvedValue([]),
    };
  });

  describe('start / stop', () => {
    it('should start and stop the listener', async () => {
      mockClient.getUpdates = createSingleShotGetUpdates([]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      expect(listener.isListening()).toBe(true);

      // Give the poll loop time to process
      await new Promise((r) => setTimeout(r, 50));

      await listener.stop();
      expect(listener.isListening()).toBe(false);
    });

    it('should be safe to call stop when not started', async () => {
      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      await listener.stop();
      expect(listener.isListening()).toBe(false);
    });

    it('should be safe to call start when already started', async () => {
      mockClient.getUpdates = createSingleShotGetUpdates([]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      listener.start(); // Should warn but not throw
      expect(listener.isListening()).toBe(true);

      await listener.stop();
    });

    it('should be safe to call stop multiple times', async () => {
      mockClient.getUpdates = createSingleShotGetUpdates([]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();
      await listener.stop(); // Should be safe
      expect(listener.isListening()).toBe(false);
    });
  });

  describe('message processing', () => {
    it('should process a text message update', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Hello bot!' } }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).toHaveBeenCalledTimes(1);
      const received = messageProcessor.mock.calls[0][0] as IncomingMessage;
      expect(received.messageId).toBe('msg-1');
      expect(received.chatId).toBe('user-123');
      expect(received.userId).toBe('user-123');
      expect(received.content).toBe('Hello bot!');
      expect(received.messageType).toBe('text');
      expect(received.timestamp).toBe(1710000000000);
    });

    it('should process an image message update', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-2',
        from_user_id: 'user-456',
        item_list: [{ type: 2, image_item: { url: 'https://cdn.example.com/img.png' } }],
        create_time: 1710000001,
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).toHaveBeenCalledTimes(1);
      const received = messageProcessor.mock.calls[0][0] as IncomingMessage;
      expect(received.messageType).toBe('image');
      expect(received.content).toBe('[Image received]');
      expect(received.attachments).toEqual([{
        fileName: 'image',
        filePath: 'https://cdn.example.com/img.png',
      }]);
    });

    it('should process a file message update', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-3',
        from_user_id: 'user-789',
        item_list: [{
          type: 3,
          file_item: {
            url: 'https://cdn.example.com/doc.pdf',
            file_name: 'report.pdf',
            file_size: 1024000,
          },
        }],
        create_time: 1710000002,
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).toHaveBeenCalledTimes(1);
      const received = messageProcessor.mock.calls[0][0] as IncomingMessage;
      expect(received.messageType).toBe('file');
      expect(received.content).toBe('[File received: report.pdf]');
      expect(received.attachments).toEqual([{
        fileName: 'report.pdf',
        filePath: 'https://cdn.example.com/doc.pdf',
        size: 1024000,
      }]);
    });

    it('should handle context_token as threadId', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-4',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'Thread reply' } }],
        create_time: 1710000003,
        context_token: 'ctx-token-abc',
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      const received = messageProcessor.mock.calls[0][0] as IncomingMessage;
      expect(received.threadId).toBe('ctx-token-abc');
    });
  });

  describe('deduplication', () => {
    it('should skip duplicate messages', async () => {
      const update: WeChatUpdate = {
        msg_id: 'dup-msg-1',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'Hello' } }],
      };

      // First call returns the message, second call returns the same message
      const updates: WeChatUpdate[][] = [
        [update],
        [update], // Duplicate — should be skipped
      ];

      mockClient.getUpdates = createMultiShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 150));
      await listener.stop();

      // Should only process the message once
      expect(messageProcessor).toHaveBeenCalledTimes(1);
    });

    it('should skip updates without msg_id', async () => {
      const update = {
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'No ID' } }],
      } as WeChatUpdate;

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should skip updates without from_user_id', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-no-user',
        item_list: [{ type: 1, text_item: { text: 'No user' } }],
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should skip updates with empty item_list', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-no-items',
        from_user_id: 'user-123',
        item_list: [],
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should continue polling after a transient error', async () => {
      let callCount = 0;
      const update: WeChatUpdate = {
        msg_id: 'msg-err-1',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'After error' } }],
      };

      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        // Second call succeeds
        return [update];
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      // Wait for error backoff + second poll + processing
      await new Promise((r) => setTimeout(r, 3000));
      await listener.stop();

      expect(mockClient.getUpdates).toHaveBeenCalled();
      // After error backoff, the message should be processed
      expect(messageProcessor).toHaveBeenCalledTimes(1);
    });

    it('should not throw when message processor fails', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-proc-err',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'Processor fails' } }],
      };

      messageProcessor.mockRejectedValue(new Error('Processor error'));
      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      // Should not throw — error is caught and logged
      expect(messageProcessor).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should use AbortError as normal shutdown signal', async () => {
      mockClient.getUpdates = vi.fn().mockRejectedValue(
        new DOMException('Aborted', 'AbortError'),
      );

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(listener.isListening()).toBe(false);
      expect(messageProcessor).not.toHaveBeenCalled();
    });
  });

  describe('unknown message types', () => {
    it('should handle unknown message type gracefully', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-unknown',
        from_user_id: 'user-123',
        item_list: [{ type: 99 } as any],
        create_time: 1710000000,
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).toHaveBeenCalledTimes(1);
      const received = messageProcessor.mock.calls[0][0] as IncomingMessage;
      expect(received.messageType).toBe('text');
      expect(received.content).toBe('[Unsupported message type: 99]');
    });

    it('should extract text from mixed item list for unknown types', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-mixed',
        from_user_id: 'user-123',
        item_list: [
          { type: 99 } as any,
          { type: 1, text_item: { text: 'Extracted text' } },
        ],
        create_time: 1710000000,
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      const received = messageProcessor.mock.calls[0][0] as IncomingMessage;
      expect(received.content).toBe('Extracted text');
    });
  });

  describe('dedup cache trimming', () => {
    it('should trim dedup cache when exceeding limit', async () => {
      // Create a listener and manually populate the cache
      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      // Access private field to populate cache
      const cache = (listener as any).seenMessageIds as Set<string>;

      // Add more than DEDUP_CACHE_LIMIT entries
      for (let i = 0; i < 10_500; i++) {
        cache.add(`msg-${i}`);
      }

      expect(cache.size).toBe(10_500);

      // Trigger trimming by processing an update
      const update: WeChatUpdate = {
        msg_id: 'msg-trigger',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'Trigger trim' } }],
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      // Cache should have been trimmed
      expect(cache.size).toBeLessThan(10_500);
    });
  });
});
