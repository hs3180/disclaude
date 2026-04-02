/**
 * Tests for WeChatMessageListener.
 *
 * Tests the long-poll based message listener with mocked API client.
 * Uses real timers with short delays to avoid fake timer memory issues.
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */

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

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

/**
 * Helper: create a mock getUpdates that returns data once then aborts.
 */
function createSingleShotGetUpdates(updates: WeChatUpdate[]) {
  let called = false;
  return vi.fn().mockImplementation(() => {
    if (called) {
      throw new DOMException('Aborted', 'AbortError');
    }
    called = true;
    return updates;
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
    const { WeChatMessageListener: Listener } = mod;
    WeChatMessageListener = Listener;

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

      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();
    });
  });

  describe('message processing', () => {
    it('should process text messages correctly', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        capturedMessage = msg;
        return Promise.resolve();
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Hello!' } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(processor).toHaveBeenCalledTimes(1);
      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageId).toBe('msg-1');
      expect(capturedMessage!.chatId).toBe('user-123');
      expect(capturedMessage!.userId).toBe('user-123');
      expect(capturedMessage!.content).toBe('Hello!');
      expect(capturedMessage!.messageType).toBe('text');
      expect(capturedMessage!.timestamp).toBe(1710000000000);
    });

    it('should process image messages correctly', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        capturedMessage = msg;
        return Promise.resolve();
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-img-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 2, image_item: { url: 'https://cdn.example.com/img.png', width: 800, height: 600 } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageType).toBe('image');
      expect(capturedMessage!.content).toBe('[Image received]');
      expect(capturedMessage!.attachments).toHaveLength(1);
      expect(capturedMessage!.attachments![0].filePath).toBe('https://cdn.example.com/img.png');
    });

    it('should process file messages correctly', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        capturedMessage = msg;
        return Promise.resolve();
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-file-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 3, file_item: { url: 'https://cdn.example.com/doc.pdf', file_name: 'report.pdf', file_size: 1024 } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageType).toBe('file');
      expect(capturedMessage!.content).toBe('[File received: report.pdf]');
      expect(capturedMessage!.attachments).toHaveLength(1);
      expect(capturedMessage!.attachments![0].fileName).toBe('report.pdf');
      expect(capturedMessage!.attachments![0].size).toBe(1024);
    });

    it('should handle context_token as threadId', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        capturedMessage = msg;
        return Promise.resolve();
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-thread-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Reply in thread' } }],
        context_token: 'ctx-token-abc',
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage!.threadId).toBe('ctx-token-abc');
    });

    it('should use Date.now() when create_time is missing', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        capturedMessage = msg;
        return Promise.resolve();
      });

      const beforeMs = Date.now();
      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-no-time',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'No timestamp' } }],
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      const afterMs = Date.now();
      expect(capturedMessage!.timestamp).toBeGreaterThanOrEqual(beforeMs);
      expect(capturedMessage!.timestamp).toBeLessThanOrEqual(afterMs);
    });
  });

  describe('deduplication', () => {
    it('should skip duplicate messages', async () => {
      const dupUpdate: WeChatUpdate = {
        msg_id: 'msg-dup-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Duplicate' } }],
        create_time: 1710000000,
      };

      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return [dupUpdate];
        }
        throw new DOMException('Aborted', 'AbortError');
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 200));
      await listener.stop();

      // Should only process once despite two polls returning same message
      expect(messageProcessor).toHaveBeenCalledTimes(1);
    });

    it('should evict old entries when cache exceeds max size', async () => {
      // Create updates with unique IDs to fill the cache
      const updates: WeChatUpdate[] = [];
      for (let i = 0; i < 10_001; i++) {
        updates.push({
          msg_id: `msg-${i}`,
          from_user_id: 'user-123',
          to_user_id: 'bot-456',
          item_list: [{ type: 1, text_item: { text: `Message ${i}` } }],
          create_time: 1710000000 + i,
        });
      }

      // Return all updates at once, then abort
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return updates;
        }
        throw new DOMException('Aborted', 'AbortError');
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 500));
      await listener.stop();

      // All 10001 messages should have been processed
      expect(messageProcessor).toHaveBeenCalledTimes(10_001);
      // Cache should have been trimmed
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ evicted: 5000 }),
        'Trimmed message dedup cache',
      );
    });
  });

  describe('error handling', () => {
    it('should apply exponential backoff on errors', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          throw new Error('Network error');
        }
        throw new DOMException('Aborted', 'AbortError');
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 8000));
      await listener.stop();

      // Should have retried after backoff delays
      expect(callCount).toBeGreaterThanOrEqual(3);
      expect(mockLogger.error).toHaveBeenCalledTimes(3);
    });

    it('should continue processing after processor error', async () => {
      const updates1: WeChatUpdate[] = [{
        msg_id: 'msg-err',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Error msg' } }],
        create_time: 1710000000,
      }];

      const updates2: WeChatUpdate[] = [{
        msg_id: 'msg-ok',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'OK msg' } }],
        create_time: 1710000001,
      }];

      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) { return updates1; }
        if (callCount === 2) { return updates2; }
        throw new DOMException('Aborted', 'AbortError');
      });

      const failingProcessor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        if (msg.messageId === 'msg-err') {
          return Promise.reject(new Error('Processor error'));
        }
        return Promise.resolve();
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        failingProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 200));
      await listener.stop();

      // Both messages should have been attempted
      expect(failingProcessor).toHaveBeenCalledTimes(2);
      // Processor error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'Processor error', msgId: 'msg-err' }),
        'Message processor failed',
      );
    });

    it('should log extended backoff warning after MAX_CONSECUTIVE_ERRORS', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 5) {
          throw new Error('Persistent error');
        }
        throw new DOMException('Aborted', 'AbortError');
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      // Total backoff: 2s + 4s + 8s + 16s + 30s = 60s
      // Use a promise-based approach to detect the warning log early.
      const warningPromise = new Promise<void>((resolve) => {
        const originalError = mockLogger.error;
        mockLogger.error = vi.fn().mockImplementation((...args: unknown[]) => {
          const msg = args[1] as string;
          if (msg === 'Too many consecutive errors, applying extended backoff') {
            resolve();
          }
          return originalError(...args);
        });
      });

      listener.start();

      // Wait for the warning to be logged (or timeout after 65s)
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 65_000));
      await Promise.race([warningPromise, timeoutPromise]);

      await listener.stop();

      // Should have logged the extended backoff warning
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ consecutiveErrors: 5 }),
        'Too many consecutive errors, applying extended backoff',
      );
    }, 70_000); // Extended timeout for backoff test
  });

  describe('edge cases', () => {
    it('should skip update without msg_id', async () => {
      const noIdUpdate = {
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'No ID' } }],
      } as WeChatUpdate;

      mockClient.getUpdates = createSingleShotGetUpdates([noIdUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should skip update without from_user_id', async () => {
      const noUserUpdate: WeChatUpdate = {
        msg_id: 'msg-no-user',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'No user' } }],
      };

      mockClient.getUpdates = createSingleShotGetUpdates([noUserUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should skip update without item_list', async () => {
      const noItemsUpdate: WeChatUpdate = {
        msg_id: 'msg-no-items',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
      };

      mockClient.getUpdates = createSingleShotGetUpdates([noItemsUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should handle unknown item type gracefully', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        capturedMessage = msg;
        return Promise.resolve();
      });

      const unknownTypeUpdate = {
        msg_id: 'msg-unknown',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 99, text_item: { text: 'Unknown type' } }],
        create_time: 1710000000,
      } as WeChatUpdate;

      mockClient.getUpdates = createSingleShotGetUpdates([unknownTypeUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      // Should still process with fallback text extraction
      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageType).toBe('text');
    });

    it('should handle empty text content', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation((msg: IncomingMessage) => {
        capturedMessage = msg;
        return Promise.resolve();
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-empty-text',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: '' } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.content).toBe('');
    });

    it('should process multiple messages from single poll', async () => {
      const updates: WeChatUpdate[] = [
        {
          msg_id: 'msg-multi-1',
          from_user_id: 'user-123',
          to_user_id: 'bot-456',
          item_list: [{ type: 1, text_item: { text: 'First' } }],
          create_time: 1710000000,
        },
        {
          msg_id: 'msg-multi-2',
          from_user_id: 'user-456',
          to_user_id: 'bot-789',
          item_list: [{ type: 1, text_item: { text: 'Second' } }],
          create_time: 1710000001,
        },
        {
          msg_id: 'msg-multi-3',
          from_user_id: 'user-789',
          to_user_id: 'bot-456',
          item_list: [{ type: 2, image_item: { url: 'https://cdn.example.com/img.png' } }],
          create_time: 1710000002,
        },
      ];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).toHaveBeenCalledTimes(3);
    });
  });
});
