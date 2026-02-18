/**
 * Tests for Feishu Bot (src/feishu/bot.ts)
 *
 * Coverage Goals: Core functionality with simplified mock setup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { FeishuBot } from './bot.js';
import * as lark from '@larksuiteoapi/node-sdk';
import { TaskTracker } from '../utils/task-tracker.js';
import { Pilot } from '../agents/pilot.js';
import { messageHistoryManager } from './message-history.js';
import { attachmentManager } from './attachment-manager.js';
import * as fs from 'fs/promises';
import { DialogueOrchestrator } from '../task/index.js';

// ===== Shared Mock Setup =====
const createMockClient = () => ({
  im: {
    message: {
      create: vi.fn().mockResolvedValue({ data: { message_id: 'msg123' } }),
    },
  },
});

const createMockWSClient = () => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
});

const createMockTaskTracker = () => ({
  hasTaskRecord: vi.fn().mockResolvedValue(false),
  saveTaskRecord: vi.fn().mockResolvedValue(undefined),
  saveTaskRecordSync: vi.fn(),
  getDialogueTaskPath: vi.fn().mockReturnValue('/tmp/test-task.md'),
});

const createMockPilot = () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  setTaskContext: vi.fn(),
  queryStream: vi.fn().mockResolvedValue(undefined),
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
});

const createMockDialogueOrchestrator = () => ({
  runDialogue: vi.fn(),
  getMessageTracker: vi.fn().mockReturnValue({
    recordMessageSent: vi.fn(),
    hasAnyMessage: vi.fn().mockReturnValue(true),
    buildWarning: vi.fn().mockReturnValue('Warning message'),
  }),
});

// ===== Module Mocks =====

// Store handlers registered to event dispatcher for assertions
let registeredHandlers: Record<string, unknown> = {};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
  WSClient: vi.fn().mockImplementation(() => ({ start: vi.fn().mockResolvedValue(undefined) })),
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: vi.fn((handlers: Record<string, unknown>) => {
      registeredHandlers = handlers;
      return this;
    }),
  })),
  Domain: { Feishu: 'https://open.feishu.cn' },
}));

vi.mock('../utils/task-tracker.js', () => ({ TaskTracker: vi.fn() }));
vi.mock('../long-task/index.js', () => ({ LongTaskManager: vi.fn() }));
vi.mock('../agents/pilot.js', () => ({ Pilot: vi.fn() }));
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({ apiKey: 'test-api-key', model: 'test-model', apiBaseUrl: 'https://api.test.com' })),
    getWorkspaceDir: vi.fn(() => '/mock/workspace'),
    getSkillsDir: vi.fn(() => '/mock/skills'),
  },
}));
vi.mock('./content-builder.js', () => ({ buildTextContent: vi.fn((text) => JSON.stringify({ text })) }));
vi.mock('../utils/error-handler.js', () => ({
  handleError: vi.fn(() => ({ userMessage: 'Test error message', message: 'Original error message' })),
  ErrorCategory: { API: 'api', SDK: 'sdk' },
}));
vi.mock('./file-uploader.js', () => ({ uploadAndSendFile: vi.fn() }));
vi.mock('./file-downloader.js', () => ({ downloadFile: vi.fn() }));
vi.mock('../task/index.js', () => ({ DialogueOrchestrator: vi.fn(), extractText: vi.fn((msg) => msg.content || '') }));
vi.mock('../mcp/feishu-context-mcp.js', () => ({ setMessageSentCallback: vi.fn() }));

// Fix: fs/promises mock with proper default export and all needed methods
vi.mock('fs/promises', () => {
  const fns = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isFile: () => true }),
    appendFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...fns,
    default: fns,
  };
});

// Import mocked modules
import { buildTextContent } from './content-builder.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import { uploadAndSendFile } from './file-uploader.js';

// Assert imports are used
void { buildTextContent, handleError, ErrorCategory, uploadAndSendFile };

// Type helpers
type MockClient = ReturnType<typeof createMockClient>;

describe('FeishuBot', () => {
  let bot: FeishuBot;
  let mockClient: MockClient;
  let mockWSClient: ReturnType<typeof createMockWSClient>;
  let mockTaskTracker: ReturnType<typeof createMockTaskTracker>;
  let mockPilot: ReturnType<typeof createMockPilot>;
  let mockDialogueOrchestrator: ReturnType<typeof createMockDialogueOrchestrator>;

  const mockedLarkClient = lark.Client as unknown as ReturnType<typeof vi.fn>;
  const mockedLarkWSClient = lark.WSClient as unknown as ReturnType<typeof vi.fn>;
  const mockedTaskTracker = TaskTracker as unknown as ReturnType<typeof vi.fn>;
  const mockedPilot = Pilot as unknown as ReturnType<typeof vi.fn>;
  const mockedDialogueOrchestrator = DialogueOrchestrator as unknown as ReturnType<typeof vi.fn>;

  const setupMocks = () => {
    mockClient = createMockClient();
    mockWSClient = createMockWSClient();
    mockTaskTracker = createMockTaskTracker();
    mockPilot = createMockPilot();
    mockDialogueOrchestrator = createMockDialogueOrchestrator();

    mockedLarkClient.mockReturnValue(mockClient);
    mockedLarkWSClient.mockReturnValue(mockWSClient);
    mockedTaskTracker.mockReturnValue(mockTaskTracker);
    mockedPilot.mockReturnValue(mockPilot);
    mockedDialogueOrchestrator.mockReturnValue(mockDialogueOrchestrator);

    vi.spyOn(messageHistoryManager, 'addBotMessage').mockImplementation(() => {});
    vi.spyOn(messageHistoryManager, 'addUserMessage').mockImplementation(() => {});
    vi.spyOn(messageHistoryManager, 'getFormattedHistory').mockReturnValue('');
    vi.spyOn(attachmentManager, 'hasAttachments').mockReturnValue(false);
    vi.spyOn(attachmentManager, 'formatAttachmentsForPrompt').mockReturnValue('');
    vi.spyOn(attachmentManager, 'addAttachment').mockImplementation(() => {});
    vi.spyOn(attachmentManager, 'getAttachmentCount').mockReturnValue(0);
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('Task content');

    // Reset registered handlers before each test
    registeredHandlers = {};
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
    bot = new FeishuBot('test-app-id', 'test-app-secret');
  });

  describe('initialization', () => {
    it('should create bot with appId and appSecret', () => {
      expect(bot.appId).toBe('test-app-id');
      expect(bot.appSecret).toBe('test-app-secret');
    });

    it('should extend EventEmitter', () => {
      expect(bot).toBeInstanceOf(EventEmitter);
    });

    it('should initialize dependencies', () => {
      expect(mockedTaskTracker).toHaveBeenCalled();
      expect(mockedPilot).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        model: 'test-model',
        apiBaseUrl: 'https://api.test.com',
        callbacks: { sendMessage: expect.any(Function), sendCard: expect.any(Function), sendFile: expect.any(Function) },
      });
    });
  });

  describe('getClient', () => {
    it('should create and reuse Lark client', () => {
      const client1 = (bot as unknown as { getClient: () => unknown }).getClient();
      const client2 = (bot as unknown as { getClient: () => unknown }).getClient();
      expect(client1).toBe(client2);
      expect(mockedLarkClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('message sending (sendMessage & sendCard)', () => {
    it('should send text message via sendMessage', async () => {
      await bot.sendMessage('oc_chat123', 'Test');
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: 'oc_chat123', msg_type: 'text', content: expect.any(String) },
      });
    });

    it('should send card via sendCard', async () => {
      await bot.sendCard('oc_chat123', { config: {} });
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: 'oc_chat123', msg_type: 'interactive', content: expect.any(String) },
      });
    });

    it('should handle API errors gracefully', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('API error'));
      await expect(bot.sendMessage('oc_chat123', 'Test')).resolves.not.toThrow();
      expect(handleError).toHaveBeenCalled();
    });

    it('should handle missing message_id in response', async () => {
      mockClient.im.message.create.mockResolvedValue({ data: {} });
      await expect(bot.sendMessage('oc_chat123', 'Test')).resolves.not.toThrow();
      expect(messageHistoryManager.addBotMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendFileToUser', () => {
    it('should upload and send file', async () => {
      (uploadAndSendFile as ReturnType<typeof vi.fn>).mockResolvedValue(1024);
      await bot.sendFileToUser('oc_chat123', '/path/to/file.txt');
      expect(uploadAndSendFile).toHaveBeenCalledWith(mockClient, '/path/to/file.txt', 'oc_chat123');
    });

    it('should handle upload errors gracefully', async () => {
      (uploadAndSendFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Upload failed'));
      await expect(bot.sendFileToUser('oc_chat123', '/path/to/file.txt')).resolves.not.toThrow();
    });
  });

  describe('start', () => {
    it('should initialize WebSocket and register handlers', async () => {
      await bot.start();
      // Check that handlers were registered
      expect(registeredHandlers).toHaveProperty('im.message.receive_v1');
      expect(registeredHandlers).toHaveProperty('im.message.message_read_v1');
      expect(registeredHandlers).toHaveProperty('im.chat.access_event.bot_p2p_chat_entered_v1');
    });

    it('should start WebSocket client', async () => {
      await bot.start();
      expect(mockedLarkWSClient).toHaveBeenCalledWith({ appId: 'test-app-id', appSecret: 'test-app-secret' });
    });

    it('should set running flag', async () => {
      await bot.start();
      expect((bot as unknown as Record<string, unknown>).running).toBe(true);
    });
  });

  describe('stop', () => {
    it('should clear running flag and wsClient', () => {
      (bot as unknown as Record<string, unknown>).running = true;
      (bot as unknown as Record<string, unknown>).wsClient = mockWSClient;
      bot.stop();
      expect((bot as unknown as Record<string, unknown>).running).toBe(false);
      expect((bot as unknown as Record<string, unknown>).wsClient).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle message receive event errors', async () => {
      await bot.start();

      const handler = registeredHandlers['im.message.receive_v1'] as (event: unknown) => Promise<void>;
      mockTaskTracker.hasTaskRecord.mockImplementation(() => { throw new Error('Deduplication failed'); });

      await expect(handler({
        message: { message_id: 'msg123', chat_id: 'chat123', content: '{"text":"test"}', message_type: 'text', sender: { sender_type: 'user' } },
      })).resolves.not.toThrow();
    });
  });
});
