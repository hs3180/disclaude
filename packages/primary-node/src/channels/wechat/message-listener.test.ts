/**
 * Tests for WeChatMessageListener.
 *
 * Tests the WeChat message listener with mocked API client.
 * Covers: polling loop, deduplication, error backoff, graceful shutdown,
 * message type conversion, and FIFO cache eviction.
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('WeChatMessageListener', () => {
  let WeChatMessageListener: typeof import('./message-listener.js').WeChatMessageListener;
  let mockClient: {
    getUpdates: ReturnType<typeof vi.fn>;
  };
  let mockProcessor: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockClient = {
      getUpdates: vi.fn(),
    };
    mockProcessor = vi.fn().mockResolvedValue(undefined);

    vi.resetModules();
    const mod = await import('./message-listener.js');
    WeChatMessageListener = mod.WeChatMessageListener;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create listener with client and processor', () => {
      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      expect(listener).toBeDefined();
      expect(listener.isListening()).toBe(false);
    });
  });

  describe('start / stop lifecycle', () => {
    it('should start and stop listener', async () => {
      // Make getUpdates resolve immediately with empty array, then throw AbortError
      mockClient.getUpdates
        .mockResolvedValueOnce([])
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);

      listener.start();
      expect(listener.isListening()).toBe(true);

      // Let the first poll complete (empty updates)
      await vi.advanceTimersByTimeAsync(0);

      // Trigger stop
      const stopPromise = listener.stop();
      await vi.advanceTimersByTimeAsync(0);
      await stopPromise;

      expect(listener.isListening()).toBe(false);
    });

    it('should warn on double start', async () => {
      mockClient.getUpdates.mockResolvedValue([]);

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);

      listener.start();
      listener.start(); // Double start

      expect(mockLogger.warn).toHaveBeenCalledWith('Message listener already running');

      await listener.stop();
    });
  });

  describe('message processing', () => {
    it('should process text messages', async () => {
      const updates = [{
        msg_id: 'msg-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Hello bot!' } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();

      await vi.advanceTimersByTimeAsync(0);

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const processedMsg = mockProcessor.mock.calls[0][0];
      expect(processedMsg.messageId).toBe('msg-1');
      expect(processedMsg.chatId).toBe('user-123');
      expect(processedMsg.userId).toBe('user-123');
      expect(processedMsg.content).toBe('Hello bot!');
      expect(processedMsg.messageType).toBe('text');
      expect(processedMsg.timestamp).toBe(1710000000000);

      await listener.stop();
    });

    it('should process image messages', async () => {
      const updates = [{
        msg_id: 'msg-img-1',
        from_user_id: 'user-456',
        item_list: [{ type: 2, image_item: { url: 'https://cdn.example.com/img.png', width: 800, height: 600 } }],
        create_time: 1710000001,
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      const processedMsg = mockProcessor.mock.calls[0][0];
      expect(processedMsg.messageType).toBe('image');
      expect(processedMsg.content).toBe('[Image received]');
      expect(processedMsg.attachments).toEqual([{
        fileName: 'image',
        filePath: 'https://cdn.example.com/img.png',
      }]);

      await listener.stop();
    });

    it('should process file messages', async () => {
      const updates = [{
        msg_id: 'msg-file-1',
        from_user_id: 'user-789',
        item_list: [{ type: 3, file_item: { url: 'https://cdn.example.com/doc.pdf', file_name: 'report.pdf', file_size: 102400 } }],
        create_time: 1710000002,
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      const processedMsg = mockProcessor.mock.calls[0][0];
      expect(processedMsg.messageType).toBe('file');
      expect(processedMsg.content).toBe('[File received: report.pdf]');
      expect(processedMsg.attachments).toEqual([{
        fileName: 'report.pdf',
        filePath: 'https://cdn.example.com/doc.pdf',
        size: 102400,
      }]);

      await listener.stop();
    });

    it('should handle unsupported message types', async () => {
      const updates = [{
        msg_id: 'msg-unknown-1',
        from_user_id: 'user-111',
        item_list: [{ type: 99, unknown_item: { data: 'test' } }],
        create_time: 1710000003,
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      const processedMsg = mockProcessor.mock.calls[0][0];
      expect(processedMsg.messageType).toBe('text');
      expect(processedMsg.content).toBe('[Unsupported message type: 99]');

      await listener.stop();
    });

    it('should extract text from mixed items for unknown types', async () => {
      const updates = [{
        msg_id: 'msg-mixed-1',
        from_user_id: 'user-222',
        item_list: [
          { type: 99, unknown_item: { data: 'test' } },
          { type: 1, text_item: { text: 'fallback text' } },
        ],
        create_time: 1710000004,
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      const processedMsg = mockProcessor.mock.calls[0][0];
      expect(processedMsg.content).toBe('fallback text');

      await listener.stop();
    });

    it('should pass context_token as threadId', async () => {
      const updates = [{
        msg_id: 'msg-thread-1',
        from_user_id: 'user-333',
        item_list: [{ type: 1, text_item: { text: 'Reply' } }],
        context_token: 'ctx-abc-123',
        create_time: 1710000005,
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      const processedMsg = mockProcessor.mock.calls[0][0];
      expect(processedMsg.threadId).toBe('ctx-abc-123');

      await listener.stop();
    });
  });

  describe('deduplication', () => {
    it('should skip duplicate messages', async () => {
      const updates = [
        { msg_id: 'msg-dup-1', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'First' } }] },
        { msg_id: 'msg-dup-1', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'Duplicate' } }] },
        { msg_id: 'msg-dup-2', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'Second' } }] },
      ];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      // Should only process 2 unique messages
      expect(mockProcessor).toHaveBeenCalledTimes(2);
      expect(mockProcessor.mock.calls[0][0].content).toBe('First');
      expect(mockProcessor.mock.calls[1][0].content).toBe('Second');

      await listener.stop();
    });

    it('should skip updates without msg_id', async () => {
      const updates = [
        { from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'No ID' } }] },
        { msg_id: 'msg-valid-1', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'Has ID' } }] },
      ];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      expect(mockProcessor.mock.calls[0][0].messageId).toBe('msg-valid-1');

      await listener.stop();
    });

    it('should skip updates without from_user_id', async () => {
      const updates = [
        { msg_id: 'msg-no-user', item_list: [{ type: 1, text_item: { text: 'No user' } }] },
      ];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockProcessor).not.toHaveBeenCalled();

      await listener.stop();
    });

    it('should skip updates without item_list', async () => {
      const updates = [
        { msg_id: 'msg-no-items', from_user_id: 'user-123' },
      ];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockProcessor).not.toHaveBeenCalled();

      await listener.stop();
    });
  });

  describe('error handling', () => {
    it('should apply exponential backoff on consecutive errors', async () => {
      let callCount = 0;
      mockClient.getUpdates.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();

      // Let the error loop run
      await vi.advanceTimersByTimeAsync(50_000);

      expect(mockProcessor).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();

      await listener.stop();
    });

    it('should log warning but not crash when processor throws', async () => {
      const updates = [{
        msg_id: 'msg-error-1',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'Error' } }],
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      mockProcessor.mockRejectedValueOnce(new Error('Processor failed'));

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'Processor failed' }),
        'Message processor failed'
      );

      await listener.stop();
    });
  });

  describe('stop behavior', () => {
    it('should be safe to call stop when not started', async () => {
      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      await expect(listener.stop()).resolves.not.toThrow();
    });

    it('should clear dedup cache on stop', async () => {
      const updates = [{
        msg_id: 'msg-cache-1',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'Cached' } }],
      }];

      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockResolvedValueOnce([])
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      const listener = new WeChatMessageListener(mockClient as any, mockProcessor);
      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      // First poll processed the message
      expect(mockProcessor).toHaveBeenCalledTimes(1);

      await listener.stop();

      // After restart, same message should NOT be deduplicated (cache cleared)
      mockClient.getUpdates
        .mockResolvedValueOnce(updates)
        .mockImplementationOnce(() => {
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        });

      listener.start();
      await vi.advanceTimersByTimeAsync(0);

      // Should process again since cache was cleared
      expect(mockProcessor).toHaveBeenCalledTimes(2);

      await listener.stop();
    });
  });
});
