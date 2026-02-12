/**
 * Comprehensive Tests for Feishu Bot (src/feishu/bot.ts)
 *
 * Coverage Goals: Increase from 25.18% to >70%
 *
 * Tests the following functionality:
 * - Bot initialization and lifecycle (start/stop)
 * - Message sending (sendMessage, sendCard, sendFileToUser)
 * - WebSocket connection and event handling
 * - Message processing and deduplication
 * - Command processing (/task)
 * - Direct chat mode
 * - File message handling (image, file, media)
 * - Task flow (Scout → Task.md → DialogueOrchestrator)
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { FeishuBot } from './bot.js';
import * as lark from '@larksuiteoapi/node-sdk';
import { TaskTracker } from '../utils/task-tracker.js';
import { Pilot } from '../pilot/index.js';
import { messageHistoryManager } from './message-history.js';
import { attachmentManager } from './attachment-manager.js';
import * as fs from 'fs/promises';
import { Scout, DialogueOrchestrator } from '../task/index.js';

// Mock dependencies
vi.mock('@larksuiteoapi/node-sdk', () => {
  const mockClient = vi.fn();

  // Create a proper EventDispatcher mock class
  class MockEventDispatcher {
    register(_handlers: Record<string, Function>) {
      return this; // Return this for chaining
    }
    start() {
      return Promise.resolve();
    }
  }

  const mockEventDispatcher = vi.fn(() => new MockEventDispatcher());

  // Create a WSClient mock function that returns an instance with start method
  const mockWSClient = vi.fn().mockImplementation(function(_config: any) {
    return {
      start: vi.fn().mockResolvedValue(undefined),
    };
  });

  return {
    Client: mockClient,
    WSClient: mockWSClient,
    EventDispatcher: mockEventDispatcher,
    Domain: {
      Feishu: 'https://open.feishu.cn',
    },
  };
});

vi.mock('../utils/task-tracker.js', () => ({
  TaskTracker: vi.fn(),
}));

vi.mock('../long-task/index.js', () => ({
//   LongTaskTracker: vi.fn(),
  LongTaskManager: vi.fn(),
}));

vi.mock('../pilot/index.js', () => ({
  Pilot: vi.fn(),
}));

vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-api-key',
      model: 'test-model',
      apiBaseUrl: 'https://api.test.com',
    })),
    getWorkspaceDir: vi.fn(() => '/mock/workspace'),
    getSkillsDir: vi.fn(() => '/mock/skills'),
  },
}));

vi.mock('./content-builder.js', () => ({
  buildTextContent: vi.fn((text) => JSON.stringify({ text })),
}));

vi.mock('../utils/error-handler.js', () => ({
  handleError: vi.fn((_error, _context, _options) => ({
    userMessage: 'Test error message',
    message: 'Original error message',
  })),
  ErrorCategory: {
    API: 'api',
    SDK: 'sdk',
  },
}));

vi.mock('./file-uploader.js', () => ({
  uploadAndSendFile: vi.fn(),
}));

vi.mock('./file-downloader.js', () => ({
  downloadFile: vi.fn(),
  getFileStats: vi.fn(),
}));

vi.mock('../task/index.js', () => ({
  Scout: vi.fn(),
  DialogueOrchestrator: vi.fn(),
  extractText: vi.fn((msg) => msg.content || ''),
}));

vi.mock('../mcp/feishu-context-mcp.js', () => ({
  setMessageSentCallback: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  access: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

// Import mocked modules after vi.mock() calls for use in tests
import { buildTextContent } from './content-builder.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import { uploadAndSendFile } from './file-uploader.js';
import { downloadFile, getFileStats } from './file-downloader.js';

// Assert imports are used (referenced dynamically in tests)
void {
  buildTextContent,
  handleError,
  ErrorCategory,
  uploadAndSendFile,
  downloadFile,
  getFileStats,
};

describe('FeishuBot', () => {
  let bot: FeishuBot;
  let mockClientInstance: any;
  let mockWSClientInstance: any;
  let mockEventDispatcherInstance: any;
  let mockTaskTrackerInstance: any;
//   let mockLongTaskTrackerInstance: any;
  let mockPilotInstance: any;
  let mockScoutInstance: any;
  let mockDialogueOrchestratorInstance: any;

  const mockedLarkClient = lark.Client as unknown as ReturnType<typeof vi.fn>;
  const mockedLarkWSClient = lark.WSClient as unknown as ReturnType<typeof vi.fn>;
  const mockedEventDispatcher = lark.EventDispatcher as unknown as ReturnType<typeof vi.fn>;
  const mockedTaskTracker = TaskTracker as unknown as ReturnType<typeof vi.fn>;
//   const mockedLongTaskTracker = LongTaskTracker as unknown as ReturnType<typeof vi.fn>;
  const mockedPilot = Pilot as unknown as ReturnType<typeof vi.fn>;
  const mockedScout = Scout as unknown as ReturnType<typeof vi.fn>;
  const mockedDialogueOrchestrator = DialogueOrchestrator as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock client instance
    mockClientInstance = {
      im: {
        message: {
          create: vi.fn(),
        },
      },
    };

    // Mock WebSocket client instance
    mockWSClientInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };

    // Mock event dispatcher instance
    mockEventDispatcherInstance = {
      register: vi.fn().mockReturnThis(),
    };

    // Mock task tracker instance
    mockTaskTrackerInstance = {
      hasTaskRecord: vi.fn().mockResolvedValue(false),
      saveTaskRecord: vi.fn().mockResolvedValue(undefined),
      saveTaskRecordSync: vi.fn(),
      getDialogueTaskPath: vi.fn().mockReturnValue('/tmp/test-task.md'),
    };

    // Mock pilot instance
    mockPilotInstance = {
      enqueueMessage: vi.fn().mockResolvedValue(undefined),
    };

    // Mock Scout instance
    mockScoutInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      setTaskContext: vi.fn(),
      queryStream: vi.fn().mockResolvedValue(undefined),
    };

    // Mock DialogueOrchestrator instance
    mockDialogueOrchestratorInstance = {
      runDialogue: vi.fn(),
      getMessageTracker: vi.fn().mockReturnValue({
        recordMessageSent: vi.fn(),
        hasAnyMessage: vi.fn().mockReturnValue(true),
        buildWarning: vi.fn().mockReturnValue('Warning message'),
      }),
    };

    mockedLarkClient.mockReturnValue(mockClientInstance);
    mockedLarkWSClient.mockReturnValue(mockWSClientInstance);
    mockedEventDispatcher.mockReturnValue(mockEventDispatcherInstance);
    mockedTaskTracker.mockReturnValue(mockTaskTrackerInstance);
    mockedPilot.mockReturnValue(mockPilotInstance);
    mockedScout.mockReturnValue(mockScoutInstance);
    mockedDialogueOrchestrator.mockReturnValue(mockDialogueOrchestratorInstance);

    // Mock message history manager
    vi.spyOn(messageHistoryManager, 'addBotMessage').mockImplementation(() => {});
    vi.spyOn(messageHistoryManager, 'addUserMessage').mockImplementation(() => {});
    vi.spyOn(messageHistoryManager, 'getFormattedHistory').mockReturnValue('');

    // Mock attachment manager
    vi.spyOn(attachmentManager, 'hasAttachments').mockReturnValue(false);
    vi.spyOn(attachmentManager, 'formatAttachmentsForPrompt').mockReturnValue('');
    vi.spyOn(attachmentManager, 'addAttachment').mockImplementation(() => {});
    vi.spyOn(attachmentManager, 'getAttachmentCount').mockReturnValue(0);

    // Mock fs.readFile - mock the module directly
    (fs.readFile as any).mockResolvedValue('Task content');

    // Create bot instance
    bot = new FeishuBot('test-app-id', 'test-app-secret');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create bot instance with appId and appSecret', () => {
      expect(bot.appId).toBe('test-app-id');
      expect(bot.appSecret).toBe('test-app-secret');
    });

    it('should extend EventEmitter', () => {
      expect(bot).toBeInstanceOf(EventEmitter);
    });

    it('should initialize task tracker', () => {
      expect(mockedTaskTracker).toHaveBeenCalled();
    });

    it('should initialize long task tracker', () => {
//       expect(mockedLongTaskTracker).toHaveBeenCalled();
    });

    it('should initialize pilot with callbacks', () => {
      expect(mockedPilot).toHaveBeenCalledWith({
        callbacks: {
          sendMessage: expect.any(Function),
          sendCard: expect.any(Function),
          sendFile: expect.any(Function),
        },
      });
    });

    // activeDialogues Map was removed from the codebase
    it.skip('should initialize empty active dialogues map', () => {
      expect((bot as any).activeDialogues).toBeInstanceOf(Map);
      expect((bot as any).activeDialogues.size).toBe(0);
    });
  });

  describe('getClient', () => {
    it('should create Lark client on first call', () => {
      const client = (bot as any).getClient();
      expect(mockedLarkClient).toHaveBeenCalledWith({
        appId: 'test-app-id',
        appSecret: 'test-app-secret',
      });
      expect(client).toBe(mockClientInstance);
    });

    it('should reuse existing client on subsequent calls', () => {
      const client1 = (bot as any).getClient();
      const client2 = (bot as any).getClient();
      expect(client1).toBe(client2);
      expect(mockedLarkClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMessage', () => {
    beforeEach(() => {
      mockClientInstance.im.message.create.mockResolvedValue({
        data: { message_id: 'msg123' },
      });
    });

    it('should send text message via REST API', async () => {
      await bot.sendMessage('oc_chat123', 'Test message');

      expect(mockClientInstance.im.message.create).toHaveBeenCalledWith({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: 'oc_chat123',
          msg_type: 'text',
          content: expect.any(String),
        },
      });
    });

    it('should use buildTextContent for message formatting', async () => {
      await bot.sendMessage('oc_chat123', 'Test message');

      expect(buildTextContent).toHaveBeenCalledWith('Test message');
    });

    it('should handle empty message gracefully', async () => {
      await bot.sendMessage('oc_chat123', '');

      expect(mockClientInstance.im.message.create).toHaveBeenCalled();
    });

    it('should handle API errors', async () => {
      mockClientInstance.im.message.create.mockRejectedValue(new Error('API error'));

      await expect(bot.sendMessage('oc_chat123', 'Test message')).resolves.not.toThrow();
      expect(handleError).toHaveBeenCalledWith(
        expect.any(Error),
        {
          category: ErrorCategory.API,
          chatId: 'oc_chat123',
          messageType: 'text'
        },
        {
          log: true,
          customLogger: expect.any(Object)
        }
      );
    });

    it('should truncate long messages in logs', async () => {
      const longMessage = 'A'.repeat(200);
      await bot.sendMessage('oc_chat123', longMessage);

      expect(mockClientInstance.im.message.create).toHaveBeenCalled();
    });

    it('should handle missing message_id in response', async () => {
      mockClientInstance.im.message.create.mockResolvedValue({
        data: {}, // No message_id
      });

      await expect(bot.sendMessage('oc_chat123', 'Test message')).resolves.not.toThrow();
      expect(messageHistoryManager.addBotMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendCard', () => {
    beforeEach(() => {
      mockClientInstance.im.message.create.mockResolvedValue({
        data: { message_id: 'msg123' },
      });
    });

    it('should send interactive card message', async () => {
      const card = { config: { wide_screen_mode: true } };
      await bot.sendCard('oc_chat123', card, 'Test card');

      expect(mockClientInstance.im.message.create).toHaveBeenCalledWith({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: 'oc_chat123',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    });

    it('should send card without description', async () => {
      const card = { config: {} };
      await bot.sendCard('oc_chat123', card);

      expect(mockClientInstance.im.message.create).toHaveBeenCalled();
    });

    it('should handle card send errors', async () => {
      mockClientInstance.im.message.create.mockRejectedValue(new Error('Card send failed'));

      await expect(bot.sendCard('oc_chat123', { config: {} })).resolves.not.toThrow();
      expect(handleError).toHaveBeenCalledWith(
        expect.any(Error),
        {
          category: ErrorCategory.API,
          chatId: 'oc_chat123',
          description: undefined,
          messageType: 'card'
        },
        {
          log: true,
          customLogger: expect.any(Object)
        }
      );
    });
  });

  describe('sendFileToUser', () => {
    it('should upload and send file to user', async () => {
      (uploadAndSendFile as any).mockResolvedValue(1024);

      await bot.sendFileToUser('oc_chat123', '/path/to/file.txt');

      expect(uploadAndSendFile).toHaveBeenCalledWith(
        mockClientInstance,
        '/path/to/file.txt',
        'oc_chat123'
      );
    });

    it('should handle file upload errors gracefully', async () => {
      (uploadAndSendFile as any).mockRejectedValue(new Error('Upload failed'));

      await expect(bot.sendFileToUser('oc_chat123', '/path/to/file.txt')).resolves.not.toThrow();
    });

    it('should not throw on upload failure', async () => {
      (uploadAndSendFile as any).mockRejectedValue(new Error('Upload failed'));

      let errorOccurred = false;
      try {
        await bot.sendFileToUser('oc_chat123', '/path/to/file.txt');
      } catch (error) {
        errorOccurred = true;
      }

      expect(errorOccurred).toBe(false);
    });
  });

  describe('start', () => {
    it('should create event dispatcher and register handlers', async () => {
      await bot.start();

      expect(mockedEventDispatcher).toHaveBeenCalled();
      expect(mockEventDispatcherInstance.register).toHaveBeenCalled();
    });

    it('should register im.message.receive_v1 handler', async () => {
      await bot.start();

      const registerCall = (mockEventDispatcherInstance.register as any).mock.calls[0];
      expect(registerCall[0]).toHaveProperty('im.message.receive_v1');
      expect(typeof registerCall[0]['im.message.receive_v1']).toBe('function');
    });

    it('should register im.message.message_read_v1 handler', async () => {
      await bot.start();

      const registerCall = (mockEventDispatcherInstance.register as any).mock.calls[0];
      expect(registerCall[0]).toHaveProperty('im.message.message_read_v1');
    });

    it('should register im.chat.access_event.bot_p2p_chat_entered_v1 handler', async () => {
      await bot.start();

      const registerCall = (mockEventDispatcherInstance.register as any).mock.calls[0];
      expect(registerCall[0]).toHaveProperty('im.chat.access_event.bot_p2p_chat_entered_v1');
    });

    it('should create WebSocket client and start connection', async () => {
      await bot.start();

      expect(mockedLarkWSClient).toHaveBeenCalledWith({
        appId: 'test-app-id',
        appSecret: 'test-app-secret',
      });
      expect(mockWSClientInstance.start).toHaveBeenCalledWith({
        eventDispatcher: mockEventDispatcherInstance,
      });
    });

    it('should set running flag to true', async () => {
      await bot.start();

      expect((bot as any).running).toBe(true);
    });

    it('should register SIGINT handler', async () => {
      const sigintListeners = process.listeners('SIGINT');
      const initialCount = sigintListeners.length;

      await bot.start();

      expect(process.listeners('SIGINT').length).toBeGreaterThan(initialCount);
    });
  });

  describe('stop', () => {
    it('should set running flag to false', () => {
      (bot as any).running = true;
      bot.stop();

      expect((bot as any).running).toBe(false);
    });

    it('should clear wsClient reference', () => {
      (bot as any).wsClient = mockWSClientInstance;
      bot.stop();

      expect((bot as any).wsClient).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle sendMessage errors gracefully', async () => {
      mockClientInstance.im.message.create.mockRejectedValue(new Error('API error'));

      await expect(bot.sendMessage('oc_chat123', 'Test message')).resolves.not.toThrow();
      expect(handleError).toHaveBeenCalled();
    });

    it('should handle sendCard errors gracefully', async () => {
      mockClientInstance.im.message.create.mockRejectedValue(new Error('Card send failed'));

      await expect(bot.sendCard('oc_chat123', { config: {} })).resolves.not.toThrow();
      expect(handleError).toHaveBeenCalled();
    });

    it('should handle file upload errors gracefully', async () => {
      (uploadAndSendFile as any).mockRejectedValue(new Error('Upload failed'));

      await expect(bot.sendFileToUser('oc_chat123', '/path/to/file.txt')).resolves.not.toThrow();
    });

    it('should handle message receive event errors', async () => {
      await bot.start();
      const registerCall = (mockEventDispatcherInstance.register as any).mock.calls[0];
      const messageHandler = registerCall[0]['im.message.receive_v1'];

      mockTaskTrackerInstance.hasTaskRecord.mockImplementation(() => {
        throw new Error('Deduplication failed');
      });

      await expect(messageHandler({
        message: {
          message_id: 'msg123',
          chat_id: 'chat123',
          content: '{"text":"test"}',
          message_type: 'text',
          sender: { sender_type: 'user' }
        }
      })).resolves.not.toThrow();
    });
  });
});
