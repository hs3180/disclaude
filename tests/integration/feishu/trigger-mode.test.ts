/**
 * P3 Integration test: Trigger mode message filtering via IPC transport.
 *
 * Tests the full pipeline:
 *   Raw Socket Client → Unix Socket → IPC Server → Custom Handler → real MessageHandler
 *   → real TriggerModeManager + MentionDetector → mock callbacks → response
 *
 * Verifies that group chat messages are correctly filtered based on trigger mode
 * settings, using the real MessageHandler code path through IPC transport.
 *
 * Uses mock IPC handlers — no real Feishu credentials needed.
 * Runs as part of the Feishu IPC integration test suite.
 *
 * @see Issue #1626 — P3: 被动模式消息过滤
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConnection, type Socket } from 'net';
import {
  UnixSocketIpcServer,
  TriggerModeManager,
  MentionDetector,
  FeishuMessageHandler,
  InteractionManager,
  type IpcRequestHandler,
  type FeishuMessageCallbacks,
} from '@disclaude/primary-node';
import type { FeishuEventData, IpcRequest, IpcResponse } from '@disclaude/core';
import { generateSocketPath, cleanupSocket } from './helpers.js';

/**
 * Send a raw IPC request through a Unix socket and return the response.
 * This bypasses the typed IPC client to support custom request types.
 */
function sendRawIpcRequest(socketPath: string, request: { type: string; payload: unknown }): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('IPC request timeout'));
    }, 5000);

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response: IpcResponse = JSON.parse(line);
            if (response.id === id) {
              clearTimeout(timeout);
              socket.destroy();
              resolve(response);
            }
          } catch {
            // Ignore non-JSON lines
          }
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      socket.destroy();
      reject(err);
    });

    socket.on('connect', () => {
      const ipcRequest = { ...request, id };
      socket.write(JSON.stringify(ipcRequest) + '\n');
    });
  });
}

/**
 * Build a simulated Feishu message event.
 */
function buildFeishuEvent(options: {
  messageId: string;
  chatId: string;
  chatType?: 'p2p' | 'group' | 'topic';
  text: string;
  mentions?: Array<{ key: string; open_id: string; name?: string }>;
  senderType?: string;
  createTime?: number;
}): FeishuEventData {
  return {
    event: {
      message: {
        message_id: options.messageId,
        chat_id: options.chatId,
        chat_type: options.chatType ?? 'group',
        content: JSON.stringify({ text: options.text }),
        message_type: 'text',
        create_time: options.createTime ?? Date.now(),
        mentions: options.mentions?.map((m) => ({
          key: m.key,
          id: { open_id: m.open_id, union_id: '', user_id: '' },
          name: m.name ?? '',
          tenant_key: '',
        })),
      },
      sender: {
        sender_type: options.senderType ?? 'user',
        sender_id: { open_id: 'ou_user_123', union_id: '', user_id: '' },
        tenant_key: '',
      },
    },
  };
}

/**
 * Create a custom IPC handler that wraps the real FeishuMessageHandler
 * and processes simulated incoming Feishu events.
 *
 * The handler:
 * 1. Receives a 'processIncomingMessage' IPC request with Feishu event data
 * 2. Routes it through the real FeishuMessageHandler (with real TriggerModeManager
 *    and MentionDetector)
 * 3. Returns whether the message was processed (emitMessage called) or filtered
 */
function createTriggerModeHandler(
  messageHandler: FeishuMessageHandler,
  capturedState: { emitted: boolean; lastMessage?: unknown },
): IpcRequestHandler {
  return async (request: IpcRequest): Promise<IpcResponse> => {
    if (request.type === 'ping') {
      return { id: request.id, success: true, payload: { pong: true } };
    }

    if (request.type === 'processIncomingMessage') {
      capturedState.emitted = false;
      capturedState.lastMessage = undefined;

      try {
        await messageHandler.handleMessageReceive(request.payload as FeishuEventData);
        return {
          id: request.id,
          success: true,
          payload: { processed: capturedState.emitted },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { id: request.id, success: false, error: errorMessage };
      }
    }

    if (request.type === 'setTriggerMode') {
      // Directly set trigger mode on the manager (bypassing MessageHandler)
      return { id: request.id, success: false, error: 'Use triggerModeManager directly' };
    }

    return { id: request.id, success: false, error: `Unknown request type: ${request.type}` };
  };
}

// Mock messageLogger to avoid file system operations
vi.mock('../../../packages/primary-node/src/channels/feishu/message-logger.js', () => ({
  messageLogger: {
    isMessageProcessed: () => false,
    logIncomingMessage: vi.fn(),
  },
}));

describe('IPC trigger mode message filtering (P3)', () => {
  let server: UnixSocketIpcServer;
  let socketPath: string;
  let triggerModeManager: TriggerModeManager;
  let mentionDetector: MentionDetector;
  let messageHandler: FeishuMessageHandler;
  let capturedState: { emitted: boolean; lastMessage?: unknown };

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedState = { emitted: false };

    // Real TriggerModeManager (no mocks)
    triggerModeManager = new TriggerModeManager();

    // Real MentionDetector with bot info injected for reliable detection
    mentionDetector = new MentionDetector();
    (mentionDetector as unknown as { botInfo: { open_id: string; app_id: string } }).botInfo = {
      open_id: 'ou_bot_test',
      app_id: 'cli_test_app',
    };

    // Mock callbacks that capture emitted messages
    const mockCallbacks: FeishuMessageCallbacks = {
      emitMessage: vi.fn(async (message) => {
        capturedState.emitted = true;
        capturedState.lastMessage = message;
      }),
      emitControl: vi.fn(async () => ({ success: true })),
      sendMessage: vi.fn(async () => {}),
    };

    // Real InteractionManager
    const interactionManager = new InteractionManager();

    // Real FeishuMessageHandler with real dependencies
    messageHandler = new FeishuMessageHandler({
      triggerModeManager,
      mentionDetector,
      interactionManager,
      callbacks: mockCallbacks,
      isRunning: () => true,
      hasControlHandler: () => true,
    });

    // Create custom IPC handler wrapping the MessageHandler
    const handler = createTriggerModeHandler(messageHandler, capturedState);

    // Set up IPC server
    server = new UnixSocketIpcServer(handler, { socketPath });
    await server.start();
  });

  afterEach(async () => {
    try {
      await server.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  // Helper to send a message through IPC and check if it was processed
  async function sendThroughIpc(event: FeishuEventData): Promise<{ processed: boolean }> {
    const response = await sendRawIpcRequest(socketPath, {
      type: 'processIncomingMessage',
      payload: event,
    });
    expect(response.success).toBe(true);
    return response.payload as { processed: boolean };
  }

  describe('mention mode', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_group_chat', 'mention');
    });

    it('should filter group message without @mention in mention mode', async () => {
      const event = buildFeishuEvent({
        messageId: 'msg_mention_no_1',
        chatId: 'oc_group_chat',
        chatType: 'group',
        text: 'Hello everyone',
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(false);
    });

    it('should process group message with @mention in mention mode', async () => {
      const event = buildFeishuEvent({
        messageId: 'msg_mention_yes_1',
        chatId: 'oc_group_chat',
        chatType: 'group',
        text: '@bot Hello',
        mentions: [{ key: '@_user_1', open_id: 'ou_bot_test', name: 'bot' }],
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });

    it('should process group message mentioning bot by app_id', async () => {
      const event = buildFeishuEvent({
        messageId: 'msg_mention_appid_1',
        chatId: 'oc_group_chat',
        chatType: 'group',
        text: '@bot help',
        mentions: [{ key: '@_user_1', open_id: 'cli_test_app', name: 'bot' }],
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });
  });

  describe('always mode', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_always_chat', 'always');
    });

    it('should process group message without @mention in always mode', async () => {
      const event = buildFeishuEvent({
        messageId: 'msg_always_no_1',
        chatId: 'oc_always_chat',
        chatType: 'group',
        text: 'Hello everyone',
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });

    it('should process group message with @mention in always mode', async () => {
      const event = buildFeishuEvent({
        messageId: 'msg_always_yes_1',
        chatId: 'oc_always_chat',
        chatType: 'group',
        text: '@bot hello',
        mentions: [{ key: '@_user_1', open_id: 'ou_bot_test', name: 'bot' }],
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });
  });

  describe('auto mode', () => {
    beforeEach(() => {
      // 'auto' is the default, no need to explicitly set
    });

    it('should process small group message without @mention in auto mode', async () => {
      triggerModeManager.markAsSmallGroup('oc_auto_small');
      const event = buildFeishuEvent({
        messageId: 'msg_auto_small_1',
        chatId: 'oc_auto_small',
        chatType: 'group',
        text: 'Hello from small group',
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });

    it('should filter large group message without @mention in auto mode', async () => {
      // Not marking as small group = large group behavior
      const event = buildFeishuEvent({
        messageId: 'msg_auto_large_1',
        chatId: 'oc_auto_large',
        chatType: 'group',
        text: 'Hello from large group',
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(false);
    });

    it('should process large group message with @mention in auto mode', async () => {
      const event = buildFeishuEvent({
        messageId: 'msg_auto_large_mention_1',
        chatId: 'oc_auto_large',
        chatType: 'group',
        text: '@bot help',
        mentions: [{ key: '@_user_1', open_id: 'ou_bot_test', name: 'bot' }],
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });
  });

  describe('P2P messages', () => {
    it('should always process P2P messages regardless of trigger mode', async () => {
      triggerModeManager.setMode('oc_p2p_chat', 'mention');
      const event = buildFeishuEvent({
        messageId: 'msg_p2p_1',
        chatId: 'oc_p2p_chat',
        chatType: 'p2p',
        text: 'Hello bot',
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });
  });

  describe('/trigger command', () => {
    beforeEach(() => {
      triggerModeManager.setMode('oc_trigger_cmd_chat', 'mention');
    });

    it('should pass /trigger command through even in mention mode', async () => {
      const event = buildFeishuEvent({
        messageId: 'msg_trigger_cmd_1',
        chatId: 'oc_trigger_cmd_chat',
        chatType: 'group',
        text: '/trigger always',
      });

      const result = await sendThroughIpc(event);
      expect(result.processed).toBe(true);
    });
  });

  describe('IPC transport reliability', () => {
    it('should handle multiple sequential messages through IPC', async () => {
      triggerModeManager.setMode('oc_sequential_chat', 'mention');

      // Message 1: filtered
      const event1 = buildFeishuEvent({
        messageId: 'msg_seq_1',
        chatId: 'oc_sequential_chat',
        chatType: 'group',
        text: 'filtered message',
      });
      const result1 = await sendThroughIpc(event1);
      expect(result1.processed).toBe(false);

      // Message 2: with mention, processed
      const event2 = buildFeishuEvent({
        messageId: 'msg_seq_2',
        chatId: 'oc_sequential_chat',
        chatType: 'group',
        text: '@bot processed',
        mentions: [{ key: '@_user_1', open_id: 'ou_bot_test', name: 'bot' }],
      });
      const result2 = await sendThroughIpc(event2);
      expect(result2.processed).toBe(true);

      // Message 3: mode changed to always, processed
      triggerModeManager.setMode('oc_sequential_chat', 'always');
      const event3 = buildFeishuEvent({
        messageId: 'msg_seq_3',
        chatId: 'oc_sequential_chat',
        chatType: 'group',
        text: 'now always mode',
      });
      const result3 = await sendThroughIpc(event3);
      expect(result3.processed).toBe(true);
    });
  });
});
