/**
 * Tests for MessageLogger (src/feishu/message-logger.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

// Mock config before importing message-logger
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace',
  },
}));

vi.mock('../config/constants.js', () => ({
  MESSAGE_LOGGING: {
    LOGS_DIR: 'chat-logs',
    MD_PARSE_REGEX: /message_id:\s*([^\n\]]+)/g,
    DEDUP_DAYS: 7,
    HISTORY_DAYS: 3,
  },
}));

// Mock fs/promises with all methods
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockRejectedValue(new Error('File not found')),
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('File not found')),
}));

describe('MessageLogger', () => {
  let MessageLogger: typeof import('./message-logger.js').MessageLogger;
  let messageLogger: InstanceType<typeof MessageLogger>;
  let mockFs: typeof fs & {
    default: typeof fs;
  };

  beforeEach(async () => {
    // Get mocked fs
    mockFs = fs as typeof fs & {
      default: typeof fs;
    };

    // Reset all mocks
    vi.mocked(mockFs.mkdir).mockClear().mockResolvedValue(undefined);
    vi.mocked(mockFs.readdir).mockClear().mockResolvedValue([]);
    vi.mocked(mockFs.readFile).mockClear().mockResolvedValue('');
    vi.mocked(mockFs.writeFile).mockClear().mockResolvedValue(undefined);
    vi.mocked(mockFs.appendFile).mockClear().mockResolvedValue(undefined);
    vi.mocked(mockFs.access).mockClear().mockRejectedValue(new Error('File not found'));

    // Also reset default exports if they exist
    if (mockFs.default) {
      vi.mocked(mockFs.default.mkdir).mockClear().mockResolvedValue(undefined);
      vi.mocked(mockFs.default.readdir).mockClear().mockResolvedValue([]);
      vi.mocked(mockFs.default.readFile).mockClear().mockResolvedValue('');
      vi.mocked(mockFs.default.writeFile).mockClear().mockResolvedValue(undefined);
      vi.mocked(mockFs.default.appendFile).mockClear().mockResolvedValue(undefined);
      vi.mocked(mockFs.default.access).mockClear().mockRejectedValue(new Error('File not found'));
    }

    // Re-import to get fresh instance
    vi.resetModules();
    const { MessageLogger: MessageLoggerClass } = await import('./message-logger.js');
    MessageLogger = MessageLoggerClass;
    messageLogger = new MessageLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('init', () => {
    it('should initialize successfully', async () => {
      await messageLogger.init();
      // Initialization should complete without throwing
      expect(true).toBe(true);
    });

    it('should not reinitialize if already initialized', async () => {
      await messageLogger.init();
      await messageLogger.init();
      // Should complete without error
      expect(true).toBe(true);
    });

    it('should handle initialization errors gracefully', async () => {
      vi.mocked(mockFs.mkdir).mockRejectedValueOnce(new Error('Permission denied'));

      // Should not throw
      await expect(messageLogger.init()).resolves.toBeUndefined();
    });
  });

  describe('isMessageProcessed', () => {
    it('should return false for unknown message ID', () => {
      expect(messageLogger.isMessageProcessed('unknown-id')).toBe(false);
    });

    it('should return true after logging incoming message', async () => {
      const messageId = 'msg-123';

      await messageLogger.logIncomingMessage(
        messageId,
        'sender-1',
        'chat-1',
        'Hello',
        'text'
      );

      expect(messageLogger.isMessageProcessed(messageId)).toBe(true);
    });

    it('should return true after logging outgoing message', async () => {
      const messageId = 'msg-456';

      await messageLogger.logOutgoingMessage(
        messageId,
        'chat-1',
        'Response'
      );

      expect(messageLogger.isMessageProcessed(messageId)).toBe(true);
    });
  });

  describe('logIncomingMessage', () => {
    it('should not throw when logging message', async () => {
      await expect(
        messageLogger.logIncomingMessage(
          'msg-1',
          'user-1',
          'chat-1',
          'Hello World',
          'text'
        )
      ).resolves.toBeUndefined();
    });

    it('should mark message as processed', async () => {
      const messageId = 'msg-mark';

      await messageLogger.logIncomingMessage(
        messageId,
        'user-1',
        'chat-1',
        'Hello',
        'text'
      );

      expect(messageLogger.isMessageProcessed(messageId)).toBe(true);
    });

    it('should handle timestamp as number', async () => {
      const timestamp = Date.now();

      await expect(
        messageLogger.logIncomingMessage(
          'msg-time',
          'user-1',
          'chat-1',
          'Test',
          'text',
          timestamp
        )
      ).resolves.toBeUndefined();
    });

    it('should use current time if timestamp not provided', async () => {
      await expect(
        messageLogger.logIncomingMessage(
          'msg-auto-time',
          'user-1',
          'chat-1',
          'Test',
          'text'
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('logOutgoingMessage', () => {
    it('should not throw when logging outgoing message', async () => {
      await expect(
        messageLogger.logOutgoingMessage(
          'out-msg-1',
          'chat-1',
          'Bot response'
        )
      ).resolves.toBeUndefined();
    });

    it('should mark message as processed', async () => {
      const messageId = 'out-msg-2';

      await messageLogger.logOutgoingMessage(
        messageId,
        'chat-1',
        'Response'
      );

      expect(messageLogger.isMessageProcessed(messageId)).toBe(true);
    });
  });

  describe('getChatHistory', () => {
    it('should return empty string when all files not found', async () => {
      const impl = async () => {
        throw new Error('File not found');
      };
      vi.mocked(mockFs.readFile).mockImplementation(impl);
      if (mockFs.default) {
        vi.mocked(mockFs.default.readFile).mockImplementation(impl);
      }

      const history = await messageLogger.getChatHistory('nonexistent');

      expect(history).toBe('');
    });

    it('should return file content when today\'s file exists', async () => {
      const mockContent = '# Chat Log\nContent here';
      let callCount = 0;

      const impl = async () => {
        callCount++;
        if (callCount === 1) return mockContent; // Today
        throw new Error('Not found'); // Other days
      };
      vi.mocked(mockFs.readFile).mockImplementation(impl);
      if (mockFs.default) {
        vi.mocked(mockFs.default.readFile).mockImplementation(impl);
      }

      const history = await messageLogger.getChatHistory('chat-1');

      // History should contain the content
      expect(history).toContain(mockContent);
    });

    it('should combine history from multiple days', async () => {
      const todayContent = '# Chat Log Today';
      const yesterdayContent = '# Chat Log Yesterday';
      let callCount = 0;

      const impl = async () => {
        callCount++;
        if (callCount === 1) return todayContent; // Today
        if (callCount === 2) return yesterdayContent; // Yesterday
        throw new Error('Not found'); // Other days
      };
      vi.mocked(mockFs.readFile).mockImplementation(impl);
      if (mockFs.default) {
        vi.mocked(mockFs.default.readFile).mockImplementation(impl);
      }

      const history = await messageLogger.getChatHistory('chat-1');

      // Both contents should be present (reversed to chronological order)
      expect(history).toContain(todayContent);
      expect(history).toContain(yesterdayContent);
    });
  });

  describe('clearCache', () => {
    it('should clear processed message IDs', async () => {
      const messageId = 'msg-clear';

      await messageLogger.logIncomingMessage(
        messageId,
        'user-1',
        'chat-1',
        'Test',
        'text'
      );

      expect(messageLogger.isMessageProcessed(messageId)).toBe(true);

      messageLogger.clearCache();

      expect(messageLogger.isMessageProcessed(messageId)).toBe(false);
    });
  });

  describe('ID sanitization', () => {
    it('should handle special characters in chat ID', async () => {
      // Should not throw with special characters
      await expect(
        messageLogger.logIncomingMessage(
          'msg-sanitize',
          'user-1',
          'chat/with:special@chars',
          'Test',
          'text'
        )
      ).resolves.toBeUndefined();
    });

    it('should handle alphanumeric, dash, and underscore in chat ID', async () => {
      await expect(
        messageLogger.logIncomingMessage(
          'msg-normal',
          'user-1',
          'chat-123_test',
          'Test',
          'text'
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('should not throw on file write errors', async () => {
      vi.mocked(mockFs.writeFile).mockRejectedValueOnce(new Error('Disk full'));

      await expect(
        messageLogger.logIncomingMessage(
          'msg-error',
          'user-1',
          'chat-1',
          'Test',
          'text'
        )
      ).resolves.toBeUndefined();
    });

    it('should handle mkdir errors gracefully', async () => {
      vi.mocked(mockFs.mkdir).mockRejectedValue(new Error('Permission denied'));

      // Should not throw even if mkdir fails
      await expect(
        messageLogger.logIncomingMessage(
          'msg-mkdir-error',
          'user-1',
          'chat-1',
          'Test',
          'text'
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('Multiple messages', () => {
    it('should handle multiple messages to same chat', async () => {
      await messageLogger.logIncomingMessage('msg-1', 'user-1', 'chat-1', 'First', 'text');
      await messageLogger.logIncomingMessage('msg-2', 'user-1', 'chat-1', 'Second', 'text');
      await messageLogger.logOutgoingMessage('msg-3', 'chat-1', 'Response');

      expect(messageLogger.isMessageProcessed('msg-1')).toBe(true);
      expect(messageLogger.isMessageProcessed('msg-2')).toBe(true);
      expect(messageLogger.isMessageProcessed('msg-3')).toBe(true);
    });

    it('should handle messages to different chats', async () => {
      await messageLogger.logIncomingMessage('msg-a1', 'user-1', 'chat-a', 'A1', 'text');
      await messageLogger.logIncomingMessage('msg-b1', 'user-1', 'chat-b', 'B1', 'text');

      expect(messageLogger.isMessageProcessed('msg-a1')).toBe(true);
      expect(messageLogger.isMessageProcessed('msg-b1')).toBe(true);
    });
  });
});
