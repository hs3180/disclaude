/**
 * Tests for IPC module - Unix Socket cross-process communication.
 *
 * Uses mocks to avoid real IPC interactions for stable, fast unit tests.
 *
 * @module ipc/ipc.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock types
interface MockSocket extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  remoteAddress?: string;
}

interface MockServer extends EventEmitter {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  listening: boolean;
}

// Mock net module
const mockSockets: MockSocket[] = [];
let mockServer: MockServer | null = null;
let serverConnectionHandler: ((socket: MockSocket) => void) | null = null;

vi.mock('net', () => ({
  createServer: vi.fn((handler: (socket: MockSocket) => void) => {
    serverConnectionHandler = handler;
    let currentSocketPath: string | null = null;
    mockServer = Object.assign(new EventEmitter(), {
      listen: vi.fn((path: string, callback: () => void) => {
        currentSocketPath = path;
        activeSocketPaths.add(path);
        mockServer!.listening = true;
        setTimeout(callback, 0);
      }),
      close: vi.fn((callback: () => void) => {
        if (currentSocketPath) {
          activeSocketPaths.delete(currentSocketPath);
        }
        mockServer!.listening = false;
        setTimeout(callback, 0);
      }),
      listening: false,
    }) as MockServer;
    return mockServer;
  }),
  createConnection: vi.fn(() => {
    const socket = Object.assign(new EventEmitter(), {
      write: vi.fn((data: string) => {
        // Simulate server receiving data and sending response
        setTimeout(() => {
          if (serverConnectionHandler) {
            // Create a server-side socket to handle the request
            const serverSocket = Object.assign(new EventEmitter(), {
              write: vi.fn((responseData: string) => {
                // Simulate client receiving response
                socket.emit('data', responseData);
              }),
              destroy: vi.fn(),
            }) as MockSocket;
            mockSockets.push(serverSocket);
            serverConnectionHandler(serverSocket);

            // Process the request data
            const lines = data.split('\n').filter((l: string) => l.trim());
            for (const line of lines) {
              try {
                JSON.parse(line);
                // Simulate server response
                serverSocket.emit('data', line);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }, 0);
        return true;
      }),
      destroy: vi.fn(),
    }) as MockSocket;
    mockSockets.push(socket);

    // Simulate successful connection
    setTimeout(() => {
      socket.emit('connect');
    }, 0);

    return socket;
  }),
}));

// Track active socket paths
const activeSocketPaths = new Set<string>();

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    // Socket path exists only if it's in the active set
    return activeSocketPaths.has(path);
  }),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

import { UnixSocketIpcServer, createInteractiveMessageHandler } from './unix-socket-server.js';
import { UnixSocketIpcClient, getIpcClient, resetIpcClient } from './unix-socket-client.js';

describe('createInteractiveMessageHandler', () => {
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    mockContexts.clear();
  });

  const createHandler = () =>
    createInteractiveMessageHandler({
      getActionPrompts: (messageId) => mockContexts.get(messageId)?.actionPrompts,
      registerActionPrompts: (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      unregisterActionPrompts: (messageId) => mockContexts.delete(messageId),
      generateInteractionPrompt: (messageId, actionValue, actionText) => {
        const context = mockContexts.get(messageId);
        if (!context) {
          return undefined;
        }
        const template = context.actionPrompts[actionValue];
        if (!template) {
          return undefined;
        }
        return template.replace(/\{\{actionText\}\}/g, actionText ?? '');
      },
      cleanupExpiredContexts: () => {
        let cleaned = 0;
        for (const [key] of mockContexts) {
          mockContexts.delete(key);
          cleaned++;
        }
        return cleaned;
      },
    });

  describe('ping', () => {
    it('should return pong', async () => {
      const handler = createHandler();
      const response = await handler({ type: 'ping', id: '1', payload: {} });
      expect(response).toEqual({ id: '1', success: true, payload: { pong: true } });
    });
  });

  describe('getActionPrompts', () => {
    it('should return prompts for existing message', async () => {
      mockContexts.set('msg-1', {
        chatId: 'chat-1',
        actionPrompts: { confirm: 'Confirmed!', cancel: 'Cancelled!' },
      });

      const handler = createHandler();
      const response = await handler({
        type: 'getActionPrompts',
        id: '2',
        payload: { messageId: 'msg-1' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ prompts: { confirm: 'Confirmed!', cancel: 'Cancelled!' } });
    });

    it('should return null for non-existent message', async () => {
      const handler = createHandler();
      const response = await handler({
        type: 'getActionPrompts',
        id: '3',
        payload: { messageId: 'non-existent' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ prompts: null });
    });
  });

  describe('registerActionPrompts', () => {
    it('should register action prompts', async () => {
      const handler = createHandler();
      const response = await handler({
        type: 'registerActionPrompts',
        id: '4',
        payload: {
          messageId: 'msg-2',
          chatId: 'chat-2',
          actionPrompts: { approve: 'Approved!' },
        },
      });

      expect(response.success).toBe(true);
      expect(mockContexts.has('msg-2')).toBe(true);
      expect(mockContexts.get('msg-2')?.actionPrompts).toEqual({ approve: 'Approved!' });
    });
  });

  describe('unregisterActionPrompts', () => {
    it('should unregister action prompts and return true', async () => {
      mockContexts.set('msg-3', { chatId: 'chat-1', actionPrompts: {} });

      const handler = createHandler();
      const response = await handler({
        type: 'unregisterActionPrompts',
        id: '5',
        payload: { messageId: 'msg-3' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ success: true });
      expect(mockContexts.has('msg-3')).toBe(false);
    });

    it('should return false for non-existent message', async () => {
      const handler = createHandler();
      const response = await handler({
        type: 'unregisterActionPrompts',
        id: '6',
        payload: { messageId: 'non-existent' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ success: false });
    });
  });

  describe('generateInteractionPrompt', () => {
    it('should generate prompt with template substitution', async () => {
      mockContexts.set('msg-4', {
        chatId: 'chat-1',
        actionPrompts: { confirm: 'User clicked {{actionText}}' },
      });

      const handler = createHandler();
      const response = await handler({
        type: 'generateInteractionPrompt',
        id: '7',
        payload: { messageId: 'msg-4', actionValue: 'confirm', actionText: 'Confirm' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ prompt: 'User clicked Confirm' });
    });

    it('should return null for non-existent message', async () => {
      const handler = createHandler();
      const response = await handler({
        type: 'generateInteractionPrompt',
        id: '8',
        payload: { messageId: 'non-existent', actionValue: 'confirm' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ prompt: null });
    });

    it('should return null for non-existent action', async () => {
      mockContexts.set('msg-5', {
        chatId: 'chat-1',
        actionPrompts: { confirm: 'Confirmed!' },
      });

      const handler = createHandler();
      const response = await handler({
        type: 'generateInteractionPrompt',
        id: '9',
        payload: { messageId: 'msg-5', actionValue: 'non-existent' },
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ prompt: null });
    });
  });

  describe('cleanupExpiredContexts', () => {
    it('should clean up all contexts and return count', async () => {
      mockContexts.set('msg-a', { chatId: 'chat-1', actionPrompts: {} });
      mockContexts.set('msg-b', { chatId: 'chat-2', actionPrompts: {} });
      mockContexts.set('msg-c', { chatId: 'chat-3', actionPrompts: {} });

      const handler = createHandler();
      const response = await handler({
        type: 'cleanupExpiredContexts',
        id: '10',
        payload: {},
      });

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ cleaned: 3 });
      expect(mockContexts.size).toBe(0);
    });
  });

  describe('unknown request type', () => {
    it('should return error for unknown type', async () => {
      const handler = createHandler();
      const response = await handler({
        type: 'unknown' as 'ping',
        id: '11',
        payload: {},
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unknown request type');
    });
  });
});

describe('UnixSocketIpcServer', () => {
  let server: UnixSocketIpcServer;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    mockContexts.clear();
    mockServer = null;
    mockSockets.length = 0;
    serverConnectionHandler = null;

    const handler = createInteractiveMessageHandler({
      getActionPrompts: (messageId) => mockContexts.get(messageId)?.actionPrompts,
      registerActionPrompts: (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      unregisterActionPrompts: (messageId) => mockContexts.delete(messageId),
      generateInteractionPrompt: () => undefined,
      cleanupExpiredContexts: () => 0,
    });

    server = new UnixSocketIpcServer(handler, { socketPath: '/tmp/test.ipc' });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should start successfully', async () => {
    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it('should stop successfully', async () => {
    await server.start();
    expect(server.isRunning()).toBe(true);
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('should handle multiple start calls gracefully', async () => {
    await server.start();
    await server.start(); // Should not throw
    expect(server.isRunning()).toBe(true);
  });

  it('should handle stop when not running', async () => {
    await server.stop(); // Should not throw
    expect(server.isRunning()).toBe(false);
  });

  it('should return socket path', () => {
    expect(server.getSocketPath()).toBe('/tmp/test.ipc');
  });
});

describe('UnixSocketIpcClient', () => {
  let client: UnixSocketIpcClient;
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    mockContexts.clear();
    mockServer = null;
    mockSockets.length = 0;
    serverConnectionHandler = null;
    resetIpcClient();

    const handler = createInteractiveMessageHandler({
      getActionPrompts: (messageId) => mockContexts.get(messageId)?.actionPrompts,
      registerActionPrompts: (messageId, chatId, actionPrompts) => {
        mockContexts.set(messageId, { chatId, actionPrompts });
      },
      unregisterActionPrompts: (messageId) => mockContexts.delete(messageId),
      generateInteractionPrompt: (messageId, actionValue, actionText) => {
        const context = mockContexts.get(messageId);
        if (!context) {
          return undefined;
        }
        const template = context.actionPrompts[actionValue];
        if (!template) {
          return undefined;
        }
        return template.replace(/\{\{actionText\}\}/g, actionText ?? '');
      },
      cleanupExpiredContexts: () => 0,
    });

    const server = new UnixSocketIpcServer(handler, { socketPath: '/tmp/test.ipc' });
    server.start();

    client = new UnixSocketIpcClient({ socketPath: '/tmp/test.ipc', timeout: 2000 });
  });

  afterEach(async () => {
    await client.disconnect();
    resetIpcClient();
  });

  it('should not be connected initially', () => {
    expect(client.isConnected()).toBe(false);
  });

  it('should check availability', async () => {
    const status = await client.checkAvailability();
    expect(status.available).toBe(true);
  });

  it('should report not available when socket does not exist', async () => {
    const noServerClient = new UnixSocketIpcClient({ socketPath: '/tmp/nonexistent.ipc', timeout: 100 });
    const status = await noServerClient.checkAvailability();
    expect(status.available).toBe(false);
    if (!status.available) {
      expect(status.reason).toBe('socket_not_found');
    }
  });

  it('should invalidate availability cache', async () => {
    const status1 = await client.checkAvailability();
    expect(status1.available).toBe(true);

    client.invalidateAvailabilityCache();

    // Cache should be cleared
    expect(client.isAvailable()).toBe(true);
  });
});

describe('getIpcClient singleton', () => {
  beforeEach(() => {
    resetIpcClient();
    mockServer = null;
    mockSockets.length = 0;
    serverConnectionHandler = null;
  });

  afterEach(() => {
    resetIpcClient();
  });

  it('should return the same instance', () => {
    const client1 = getIpcClient();
    const client2 = getIpcClient();
    expect(client1).toBe(client2);
  });

  it('should reset to a new instance', () => {
    const client1 = getIpcClient();
    resetIpcClient();
    const client2 = getIpcClient();
    expect(client1).not.toBe(client2);
  });
});

describe('Feishu API handlers', () => {
  const mockContexts = new Map<string, { chatId: string; actionPrompts: Record<string, string> }>();

  beforeEach(() => {
    mockContexts.clear();
  });

  it('should return error when Feishu handlers not available', async () => {
    const handler = createInteractiveMessageHandler({
      getActionPrompts: () => undefined,
      registerActionPrompts: () => {},
      unregisterActionPrompts: () => false,
      generateInteractionPrompt: () => undefined,
      cleanupExpiredContexts: () => 0,
    });

    const response = await handler({
      type: 'feishuSendMessage',
      id: '1',
      payload: { chatId: 'chat-1', text: 'Hello' },
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('Feishu API handlers not available');
  });

  it('should call Feishu handlers when available', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue(undefined);
    const mockSendCard = vi.fn().mockResolvedValue(undefined);
    const mockUploadFile = vi.fn().mockResolvedValue({
      fileKey: 'key-1',
      fileType: 'stream',
      fileName: 'test.txt',
      fileSize: 100,
    });
    const mockGetBotInfo = vi.fn().mockResolvedValue({
      openId: 'bot-1',
      name: 'Test Bot',
      avatarUrl: 'https://example.com/avatar.png',
    });

    const feishuContainer = {
      handlers: {
        sendMessage: mockSendMessage,
        sendCard: mockSendCard,
        uploadFile: mockUploadFile,
        getBotInfo: mockGetBotInfo,
      },
    };

    const handler = createInteractiveMessageHandler(
      {
        getActionPrompts: () => undefined,
        registerActionPrompts: () => {},
        unregisterActionPrompts: () => false,
        generateInteractionPrompt: () => undefined,
        cleanupExpiredContexts: () => 0,
      },
      feishuContainer
    );

    // Test feishuSendMessage
    const sendResponse = await handler({
      type: 'feishuSendMessage',
      id: '1',
      payload: { chatId: 'chat-1', text: 'Hello' },
    });
    expect(sendResponse.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith('chat-1', 'Hello', undefined);

    // Test feishuSendCard
    const cardResponse = await handler({
      type: 'feishuSendCard',
      id: '2',
      payload: { chatId: 'chat-1', card: { type: 'test' } },
    });
    expect(cardResponse.success).toBe(true);
    expect(mockSendCard).toHaveBeenCalledWith('chat-1', { type: 'test' }, undefined, undefined);

    // Test feishuUploadFile
    const uploadResponse = await handler({
      type: 'feishuUploadFile',
      id: '3',
      payload: { chatId: 'chat-1', filePath: '/tmp/test.txt' },
    });
    expect(uploadResponse.success).toBe(true);
    expect(uploadResponse.payload).toEqual({
      success: true,
      fileKey: 'key-1',
      fileType: 'stream',
      fileName: 'test.txt',
      fileSize: 100,
    });

    // Test feishuGetBotInfo
    const botResponse = await handler({
      type: 'feishuGetBotInfo',
      id: '4',
      payload: {},
    });
    expect(botResponse.success).toBe(true);
    expect(botResponse.payload).toEqual({
      openId: 'bot-1',
      name: 'Test Bot',
      avatarUrl: 'https://example.com/avatar.png',
    });
  });

  it('should handle Feishu handler errors', async () => {
    const mockSendMessage = vi.fn().mockRejectedValue(new Error('API Error'));

    const feishuContainer = {
      handlers: {
        sendMessage: mockSendMessage,
        sendCard: vi.fn().mockResolvedValue(undefined),
        uploadFile: vi.fn().mockResolvedValue({ fileKey: 'key', fileType: 'stream', fileName: 'f', fileSize: 0 }),
        getBotInfo: vi.fn().mockResolvedValue({ openId: 'bot' }),
      },
    };

    const handler = createInteractiveMessageHandler(
      {
        getActionPrompts: () => undefined,
        registerActionPrompts: () => {},
        unregisterActionPrompts: () => false,
        generateInteractionPrompt: () => undefined,
        cleanupExpiredContexts: () => 0,
      },
      feishuContainer
    );

    const response = await handler({
      type: 'feishuSendMessage',
      id: '1',
      payload: { chatId: 'chat-1', text: 'Hello' },
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
  });
});
