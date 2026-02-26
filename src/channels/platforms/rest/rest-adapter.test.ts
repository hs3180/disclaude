/**
 * Tests for REST Platform Adapter.
 *
 * Tests the REST-specific implementation of IPlatformAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RestPlatformAdapter, RestMessageSender } from './rest-adapter.js';

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
};

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('RestMessageSender', () => {
  let sender: RestMessageSender;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = new RestMessageSender({
      baseUrl: 'http://localhost:3000',
      logger: mockLogger as any,
    });
  });

  describe('sendText()', () => {
    it('should log text message', async () => {
      await sender.sendText('chat-1', 'Hello World', 'thread-1');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: 'chat-1', text: 'Hello World', threadId: 'thread-1' },
        'REST: Sending text message'
      );
    });

    it('should log long text messages', async () => {
      const longText = 'A'.repeat(100);
      await sender.sendText('chat-1', longText);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          text: longText.substring(0, 50),
        }),
        'REST: Sending text message'
      );
    });
  });

  describe('sendCard()', () => {
    it('should log card message', async () => {
      const card = { type: 'test' };
      await sender.sendCard('chat-1', card, 'Test card', 'thread-1');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: 'chat-1', description: 'Test card', threadId: 'thread-1' },
        'REST: Sending card message'
      );
    });
  });

  describe('sendFile()', () => {
    it('should log file message', async () => {
      await sender.sendFile('chat-1', '/tmp/test.txt', 'thread-1');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: 'chat-1', filePath: '/tmp/test.txt', threadId: 'thread-1' },
        'REST: Sending file'
      );
    });
  });

  describe('addReaction()', () => {
    it('should return false (not supported)', async () => {
      const result = await sender.addReaction!('msg-1', '👍');
      expect(result).toBe(false);
    });
  });
});

describe('RestPlatformAdapter', () => {
  let adapter: RestPlatformAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new RestPlatformAdapter({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-api-key',
      logger: mockLogger as any,
    });
  });

  describe('Properties', () => {
    it('should have correct platformId', () => {
      expect(adapter.platformId).toBe('rest');
    });

    it('should have correct platformName', () => {
      expect(adapter.platformName).toBe('REST API');
    });

    it('should have messageSender', () => {
      expect(adapter.messageSender).toBeDefined();
    });

    it('should not have fileHandler', () => {
      expect(adapter.fileHandler).toBeUndefined();
    });
  });

  describe('getBaseUrl()', () => {
    it('should return configured base URL', () => {
      expect(adapter.getBaseUrl()).toBe('http://localhost:3000');
    });

    it('should return default URL when not configured', () => {
      const defaultAdapter = new RestPlatformAdapter({
        logger: mockLogger as any,
      });
      expect(defaultAdapter.getBaseUrl()).toBe('http://localhost:3000');
    });
  });

  describe('Custom Message Sender', () => {
    it('should use custom message sender when provided', () => {
      const customSender = {
        sendText: vi.fn(),
        sendCard: vi.fn(),
        sendFile: vi.fn(),
      };

      const customAdapter = new RestPlatformAdapter({
        logger: mockLogger as any,
        messageSender: customSender as any,
      });

      expect(customAdapter.messageSender).toBe(customSender);
    });
  });
});
