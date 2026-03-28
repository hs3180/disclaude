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
  return vi.fn().mockImplementation(async () => {
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

      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();
    });
  });

  describe('message processing', () => {
    it('should process text messages correctly', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
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
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
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
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
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
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
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
      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
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

    it('should trim dedup cache when exceeding max size', async () => {
      // Create 10,001 unique updates to trigger trim
      const updates: WeChatUpdate[] = Array.from({ length: 10_001 }, (_, i) => ({
        msg_id: `msg-trim-${i}`,
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: `Message ${i}` } }],
        create_time: 1710000000 + i,
      }));

      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
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
      await new Promise((r) => setTimeout(r, 200));
      await listener.stop();

      // All 10,001 messages should be processed
      expect(messageProcessor).toHaveBeenCalledTimes(10_001);

      // Trim should have been called (logged)
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ remaining: expect.any(Number) }),
        'Trimmed message dedup cache',
      );
    });
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
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const unknownTypeUpdate = {
        msg_id: 'msg-unknown',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 99, unknown_field: { data: 'Unknown type' } }],
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
      expect(capturedMessage!.content).toBe('[Unsupported message type: 99]');
    });

    it('should handle processor errors gracefully', async () => {
      const failingProcessor = vi.fn().mockRejectedValue(new Error('Processor failed'));

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-err',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Error trigger' } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        failingProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      // Processor should be called but error should be caught
      expect(failingProcessor).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'Processor failed' }),
        'Message processor failed',
      );
    });

    it('should handle missing create_time with current timestamp', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-no-time',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'No time' } }],
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
      // Should use Date.now() when create_time is missing
      expect(capturedMessage!.timestamp).toBeGreaterThan(1710000000000);
    });
  });

  describe('error handling and backoff', () => {
    it('should apply exponential backoff on consecutive errors', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) {
          throw new Error('Temporary failure');
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

      // Should have logged errors for each failure
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should reset error counter on successful poll', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Temporary failure');
        }
        if (callCount === 2) {
          return [];
        }
        if (callCount === 3) {
          throw new Error('Another failure');
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

      // Should have logged errors but recovered
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('concurrent messages', () => {
    it('should process multiple messages in a single poll', async () => {
      const capturedMessages: IncomingMessage[] = [];
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessages.push(msg);
      });

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
          item_list: [{ type: 2, image_item: { url: 'https://img.com/1.png' } }],
          create_time: 1710000002,
        },
      ];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(processor).toHaveBeenCalledTimes(3);
      expect(capturedMessages).toHaveLength(3);
      expect(capturedMessages[0].messageId).toBe('msg-multi-1');
      expect(capturedMessages[0].content).toBe('First');
      expect(capturedMessages[1].messageId).toBe('msg-multi-2');
      expect(capturedMessages[1].content).toBe('Second');
      expect(capturedMessages[2].messageId).toBe('msg-multi-3');
      expect(capturedMessages[2].messageType).toBe('image');
    });
  });
});
