/**
 * Integration test: Trigger mode filtering end-to-end chain.
 *
 * Tests the full pipeline through real IPC transport:
 *   IPC Client → Unix Socket → IPC Server → MessageHandler → Mock Callbacks → Response
 *
 * Verifies that TriggerModeManager and MentionDetector filtering logic works
 * correctly in the real MessageHandler code path, not via mocked internals.
 *
 * The test harness:
 * 1. Creates a real MessageHandler with real TriggerModeManager and MentionDetector
 * 2. Wraps it in a custom IPC request handler that simulates incoming Feishu events
 * 3. Uses real Unix socket IPC transport (Client ↔ Server)
 * 4. Captures the filtering decision via mock MessageCallbacks
 *
 * Uses mock Feishu client — no real Feishu credentials needed.
 * Runs as part of the standard test suite.
 *
 * @see Issue #1626
 * @see Issue #511 — Group chat passive mode control
 * @see Issue #3345 — 'auto' triggerMode for intelligent group size detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  type IpcRequest,
  type IpcResponse,
  type IpcRequestHandler,
} from '@disclaude/primary-node';
import {
  FeishuMessageHandler as MessageHandler,
  TriggerModeManager,
  MentionDetector,
  InteractionManager,
  type FeishuMessageCallbacks as MessageCallbacks,
} from '@disclaude/primary-node';
import type { IpcRequestType, IpcRequestPayloads, IpcResponsePayloads } from '@disclaude/core';
import { generateSocketPath, cleanupSocket } from './helpers.js';

// ============================================================================
// Test Helpers
// ============================================================================

/** Result captured from MessageHandler callbacks */
interface CapturedResult {
  /** Whether the message was emitted (not filtered) */
  emitted: boolean;
  /** Emitted message content */
  content?: string;
  /** Chat ID of emitted message */
  chatId?: string;
  /** Whether the message was filtered */
  filtered: boolean;
}

/** Payload for the custom 'simulateMessage' IPC request */
interface SimulateMessagePayload {
  /** Chat ID */
  chatId: string;
  /** Chat type: 'p2p' | 'group' | 'topic' */
  chatType: 'p2p' | 'group' | 'topic';
  /** Message content (will be JSON-encoded as text message) */
  text: string;
  /** Message ID (auto-generated if not provided) */
  messageId?: string;
  /** Sender open_id */
  senderOpenId?: string;
  /** Sender type (e.g., 'user' or 'app') */
  senderType?: string;
  /** Mentions array (simulates @mentions) */
  mentions?: Array<{
    key: string;
    id: { open_id: string; union_id: string; user_id: string };
    name: string;
    tenant_key: string;
  }>;
  /** Message creation time (epoch ms); defaults to Date.now() */
  createTime?: number;
}

/** Payload for the custom 'setTriggerMode' IPC request */
interface SetTriggerModePayload {
  chatId: string;
  mode: 'mention' | 'always' | 'auto';
}

/** Payload for the custom 'markSmallGroup' IPC request */
interface MarkSmallGroupPayload {
  chatId: string;
}

/** Custom IPC request types for test simulation */
const TEST_REQUEST_TYPES = {
  PING: 'ping',
  SIMULATE_MESSAGE: 'simulateMessage',
  SET_TRIGGER_MODE: 'setTriggerMode',
  MARK_SMALL_GROUP: 'markSmallGroup',
} as const;

/**
 * Shared mutable result container for capturing MessageHandler output.
 *
 * The IPC handler and MessageHandler callbacks share a reference to this object.
 * After each simulated message, the IPC handler reads the result to build the response.
 */
class ResultCapture {
  result: CapturedResult = { emitted: false, filtered: true };

  reset(): void {
    this.result = { emitted: false, filtered: true };
  }

  markEmitted(content: string, chatId: string): void {
    this.result = { emitted: true, filtered: false, content, chatId };
  }
}

/**
 * Create mock MessageCallbacks that capture the filtering decision.
 *
 * - emitMessage: Called when message passes through (not filtered)
 * - sendMessage: Called for control command responses
 * - emitControl: Called for control commands
 */
function createTestCallbacks(capture: ResultCapture): MessageCallbacks {
  return {
    emitMessage: async (message) => {
      capture.markEmitted(message.content, message.chatId);
    },
    emitControl: async () => ({ success: false }),
    sendMessage: async () => {},
  };
}

/**
 * Create a custom IPC request handler that wraps MessageHandler.
 *
 * The handler processes custom request types for test simulation:
 * - simulateMessage: Sends a simulated Feishu event through the real MessageHandler
 * - setTriggerMode: Sets trigger mode for a chat
 * - markSmallGroup: Marks a chat as a small group
 *
 * The response includes the filtering decision from MessageHandler.
 */
function createTestIpcHandler(
  messageHandler: MessageHandler,
  triggerModeManager: TriggerModeManager,
  capture: ResultCapture,
): IpcRequestHandler {
  return async (request: IpcRequest): Promise<IpcResponse> => {
    try {
      switch (request.type) {
        case TEST_REQUEST_TYPES.PING:
          return { id: request.id, success: true, payload: { pong: true } };

        case TEST_REQUEST_TYPES.SET_TRIGGER_MODE: {
          const { chatId, mode } = request.payload as unknown as SetTriggerModePayload;
          triggerModeManager.setMode(chatId, mode);
          return { id: request.id, success: true, payload: { mode } };
        }

        case TEST_REQUEST_TYPES.MARK_SMALL_GROUP: {
          const { chatId } = request.payload as unknown as MarkSmallGroupPayload;
          triggerModeManager.markAsSmallGroup(chatId);
          return { id: request.id, success: true, payload: { marked: true } };
        }

        case TEST_REQUEST_TYPES.SIMULATE_MESSAGE: {
          const payload = request.payload as unknown as SimulateMessagePayload;

          // Reset capture for this message
          capture.reset();

          const messageId = payload.messageId || `om_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          // Build a realistic Feishu event
          const feishuEvent = {
            message: {
              message_id: messageId,
              chat_id: payload.chatId,
              chat_type: payload.chatType,
              content: JSON.stringify({ text: payload.text }),
              message_type: 'text',
              create_time: payload.createTime ?? Date.now(),
              mentions: payload.mentions,
            },
            sender: {
              sender_type: payload.senderType || 'user',
              sender_id: {
                open_id: payload.senderOpenId || 'ou_test_user',
              },
            },
          };

          // Process through the real MessageHandler
          await messageHandler.handleMessageReceive({ event: feishuEvent });

          // Return the captured result
          return {
            id: request.id,
            success: true,
            payload: {
              emitted: capture.result.emitted,
              filtered: capture.result.filtered,
              content: capture.result.content,
              chatId: capture.result.chatId,
            },
          };
        }

        default:
          return {
            id: request.id,
            success: false,
            error: `Unknown request type: ${request.type}`,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { id: request.id, success: false, error: errorMessage };
    }
  };
}

// ============================================================================
// Bot info for MentionDetector
// ============================================================================

const BOT_OPEN_ID = 'ou_bot_test_abc123';
const BOT_APP_ID = 'cli_test_app_xyz789';

/**
 * Set bot info on MentionDetector so it can detect mentions.
 * This simulates what fetchBotInfo() would do with a real Feishu API.
 */
function setTestBotInfo(mentionDetector: MentionDetector): void {
  (mentionDetector as unknown as { botInfo: { open_id: string; app_id?: string } }).botInfo = {
    open_id: BOT_OPEN_ID,
    app_id: BOT_APP_ID,
  };
}

/**
 * Create a mention object that references the test bot.
 */
function createBotMention(): {
  key: string;
  id: { open_id: string; union_id: string; user_id: string };
  name: string;
  tenant_key: string;
} {
  return {
    key: '@_bot',
    id: { open_id: BOT_OPEN_ID, union_id: 'on_bot_union', user_id: 'bot_user_id' },
    name: 'TestBot',
    tenant_key: 'tenant_test',
  };
}

// ============================================================================
// Extended IPC Client for custom request types
// ============================================================================

/**
 * Extended IPC client that supports custom test request types.
 *
 * The standard UnixSocketIpcClient.request() is strongly typed to known IPC types.
 * This wrapper bypasses the type system to send custom test requests through
 * the same IPC transport layer.
 */
class TestIpcClient extends UnixSocketIpcClient {
  /**
   * Send a raw IPC request with custom type.
   * Uses the parent's transport to send and receive, bypassing type constraints.
   */
  async sendRawRequest(type: string, payload: Record<string, unknown>): Promise<IpcResponse> {
    // Access private properties via type assertion for testing purposes
    const self = this as unknown as {
      connected: boolean;
      connect: () => Promise<void>;
      requestId: number;
      pendingRequests: Map<string, {
        resolve: (response: IpcResponse) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
      }>;
      timeout: number;
      transport?: { write: (data: string) => void };
      socket?: { write: (data: string) => boolean };
    };

    if (!self.connected) {
      await this.connect();
    }

    const id = `${++self.requestId}`;
    const request: IpcRequest = { type: type as IpcRequestType, id, payload: payload as IpcRequestPayloads[keyof IpcRequestPayloads] };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        self.pendingRequests.delete(id);
        reject(new Error(`IPC_TIMEOUT: Request timed out: ${type}`));
      }, self.timeout);

      self.pendingRequests.set(id, {
        resolve: (response: IpcResponse) => {
          clearTimeout(timeoutId);
          resolve(response);
        },
        reject,
        timeout: timeoutId,
      });

      try {
        const serialized = `${JSON.stringify(request)}\n`;
        if (self.transport) {
          self.transport.write(serialized);
        } else if (self.socket) {
          self.socket.write(serialized);
        } else {
          throw new Error('No transport or socket available');
        }
      } catch (error) {
        self.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Trigger mode filtering end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: TestIpcClient;
  let socketPath: string;
  let triggerModeManager: TriggerModeManager;
  let mentionDetector: MentionDetector;
  let messageHandler: MessageHandler;
  let capture: ResultCapture;

  beforeEach(async () => {
    socketPath = generateSocketPath();
    triggerModeManager = new TriggerModeManager();
    mentionDetector = new MentionDetector();
    setTestBotInfo(mentionDetector);

    capture = new ResultCapture();

    const callbacks = createTestCallbacks(capture);
    const interactionManager = new InteractionManager();

    messageHandler = new MessageHandler({
      triggerModeManager,
      mentionDetector,
      interactionManager,
      callbacks,
      isRunning: () => true,
      hasControlHandler: () => false,
    });

    const handler = createTestIpcHandler(messageHandler, triggerModeManager, capture);
    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new TestIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    try {
      await client.disconnect();
      await server.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  // Helper to send a simulateMessage request via IPC
  async function sendSimulateMessage(
    payload: Omit<SimulateMessagePayload, 'triggerMode' | 'markSmallGroup'>,
  ): Promise<CapturedResult> {
    const response = await client.sendRawRequest(
      TEST_REQUEST_TYPES.SIMULATE_MESSAGE,
      payload as unknown as Record<string, unknown>,
    );

    expect(response.success).toBe(true);
    return response.payload as unknown as CapturedResult;
  }

  // Helper to set trigger mode via IPC
  async function setTriggerMode(
    chatId: string,
    mode: 'mention' | 'always' | 'auto',
  ): Promise<void> {
    const response = await client.sendRawRequest(
      TEST_REQUEST_TYPES.SET_TRIGGER_MODE,
      { chatId, mode },
    );
    expect(response.success).toBe(true);
  }

  // Helper to mark small group via IPC
  async function markSmallGroup(chatId: string): Promise<void> {
    const response = await client.sendRawRequest(
      TEST_REQUEST_TYPES.MARK_SMALL_GROUP,
      { chatId },
    );
    expect(response.success).toBe(true);
  }

  // ==========================================================================
  // Group chat with 'mention' mode — bot only responds to @mentions
  // ==========================================================================

  describe('mention mode (bot only responds to @mentions)', () => {
    beforeEach(async () => {
      await setTriggerMode('oc_mention_group', 'mention');
    });

    it('should filter group message without @mention in mention mode', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_mention_group',
        chatType: 'group',
        text: 'Hello everyone',
      });

      expect(result.filtered).toBe(true);
      expect(result.emitted).toBe(false);
    });

    it('should emit group message WITH @mention in mention mode', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_mention_group',
        chatType: 'group',
        text: '@TestBot please help',
        mentions: [createBotMention()],
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
      expect(result.content).toContain('@TestBot please help');
    });

    it('should filter multiple non-mention messages in sequence', async () => {
      for (let i = 0; i < 3; i++) {
        const result = await sendSimulateMessage({
          chatId: 'oc_mention_group',
          chatType: 'group',
          text: `Message ${i}`,
          messageId: `om_filter_seq_${i}_${Date.now()}`,
        });
        expect(result.filtered).toBe(true);
        expect(result.emitted).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Group chat with 'always' mode — bot responds to all messages
  // ==========================================================================

  describe('always mode (bot responds to all messages)', () => {
    beforeEach(async () => {
      await setTriggerMode('oc_always_group', 'always');
    });

    it('should emit group message without @mention in always mode', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_always_group',
        chatType: 'group',
        text: 'Hello without mention',
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
      expect(result.content).toBe('Hello without mention');
    });

    it('should emit group message WITH @mention in always mode', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_always_group',
        chatType: 'group',
        text: '@TestBot hello',
        mentions: [createBotMention()],
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
      expect(result.content).toContain('@TestBot');
    });

    it('should emit multiple messages in sequence in always mode', async () => {
      for (let i = 0; i < 3; i++) {
        const result = await sendSimulateMessage({
          chatId: 'oc_always_group',
          chatType: 'group',
          text: `Message ${i}`,
          messageId: `om_always_seq_${i}_${Date.now()}`,
        });
        expect(result.emitted).toBe(true);
        expect(result.filtered).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Group chat with 'auto' mode — responds based on group size
  // ==========================================================================

  describe('auto mode (responds based on group size)', () => {
    beforeEach(async () => {
      await setTriggerMode('oc_auto_group', 'auto');
    });

    it('should filter message in auto mode when NOT a small group', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_auto_group',
        chatType: 'group',
        text: 'Hello auto mode',
      });

      // Auto mode without small group detection = filtered
      // (no Feishu API client to call checkAndAutoDisableSmallGroup)
      expect(result.filtered).toBe(true);
      expect(result.emitted).toBe(false);
    });

    it('should emit message in auto mode when marked as small group', async () => {
      // Mark the chat as a small group
      await markSmallGroup('oc_auto_group');

      const result = await sendSimulateMessage({
        chatId: 'oc_auto_group',
        chatType: 'group',
        text: 'Hello from small group',
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
      expect(result.content).toBe('Hello from small group');
    });

    it('should still respond to @mention in auto mode even for non-small group', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_auto_group',
        chatType: 'group',
        text: '@TestBot help please',
        mentions: [createBotMention()],
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
      expect(result.content).toContain('@TestBot help please');
    });
  });

  // ==========================================================================
  // P2P chat — always responds regardless of trigger mode
  // ==========================================================================

  describe('P2P chat (always responds)', () => {
    it('should emit P2P message regardless of trigger mode', async () => {
      // Set mention mode for a P2P chat — should still emit
      await setTriggerMode('oc_p2p_chat', 'mention');

      const result = await sendSimulateMessage({
        chatId: 'oc_p2p_chat',
        chatType: 'p2p',
        text: 'Direct message',
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
      expect(result.content).toBe('Direct message');
    });

    it('should emit P2P message in always mode', async () => {
      await setTriggerMode('oc_p2p_chat2', 'always');

      const result = await sendSimulateMessage({
        chatId: 'oc_p2p_chat2',
        chatType: 'p2p',
        text: 'Another direct message',
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
    });
  });

  // ==========================================================================
  // Mode switching — dynamic changes to trigger mode
  // ==========================================================================

  describe('mode switching', () => {
    it('should filter after switching from always to mention mode', async () => {
      await setTriggerMode('oc_switch_chat', 'always');

      // First: should emit in always mode
      const result1 = await sendSimulateMessage({
        chatId: 'oc_switch_chat',
        chatType: 'group',
        text: 'Before switch',
        messageId: `om_before_${Date.now()}`,
      });
      expect(result1.emitted).toBe(true);

      // Switch to mention mode
      await setTriggerMode('oc_switch_chat', 'mention');

      // Second: should filter in mention mode
      const result2 = await sendSimulateMessage({
        chatId: 'oc_switch_chat',
        chatType: 'group',
        text: 'After switch',
        messageId: `om_after_${Date.now()}`,
      });
      expect(result2.filtered).toBe(true);
      expect(result2.emitted).toBe(false);
    });

    it('should emit after switching from mention to always mode', async () => {
      await setTriggerMode('oc_switch_chat2', 'mention');

      // First: should filter in mention mode
      const result1 = await sendSimulateMessage({
        chatId: 'oc_switch_chat2',
        chatType: 'group',
        text: 'Before switch',
        messageId: `om_pre_${Date.now()}`,
      });
      expect(result1.filtered).toBe(true);

      // Switch to always mode
      await setTriggerMode('oc_switch_chat2', 'always');

      // Second: should emit in always mode
      const result2 = await sendSimulateMessage({
        chatId: 'oc_switch_chat2',
        chatType: 'group',
        text: 'After switch',
        messageId: `om_post_${Date.now()}`,
      });
      expect(result2.emitted).toBe(true);
    });
  });

  // ==========================================================================
  // Default mode (auto) for unknown chats
  // ==========================================================================

  describe('default auto mode for unconfigured chats', () => {
    it('should filter group message in default auto mode (no config)', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_unknown_group',
        chatType: 'group',
        text: 'Hello unknown group',
      });

      // Default is 'auto' mode, and no small group detection → filtered
      expect(result.filtered).toBe(true);
      expect(result.emitted).toBe(false);
    });

    it('should still respond to @mention in default auto mode', async () => {
      const result = await sendSimulateMessage({
        chatId: 'oc_unknown_group',
        chatType: 'group',
        text: '@TestBot help',
        mentions: [createBotMention()],
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
    });
  });

  // ==========================================================================
  // Bot message filtering
  // ==========================================================================

  describe('bot message filtering', () => {
    it('should filter bot messages that do not @mention our bot', async () => {
      await setTriggerMode('oc_bot_filter', 'always');

      const result = await sendSimulateMessage({
        chatId: 'oc_bot_filter',
        chatType: 'group',
        text: 'Automated bot message',
        senderType: 'app',
        senderOpenId: 'ou_other_bot',
      });

      expect(result.filtered).toBe(true);
      expect(result.emitted).toBe(false);
    });

    it('should allow bot messages that @mention our bot (bot-to-bot communication)', async () => {
      await setTriggerMode('oc_bot_mention', 'always');

      const result = await sendSimulateMessage({
        chatId: 'oc_bot_mention',
        chatType: 'group',
        text: '@TestBot notification',
        senderType: 'app',
        senderOpenId: 'ou_other_bot',
        mentions: [createBotMention()],
      });

      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
    });
  });

  // ==========================================================================
  // /trigger command passthrough
  // ==========================================================================

  describe('/trigger command passthrough', () => {
    it('should pass /trigger command through even without @mention in mention mode', async () => {
      await setTriggerMode('oc_trigger_cmd', 'mention');

      const result = await sendSimulateMessage({
        chatId: 'oc_trigger_cmd',
        chatType: 'group',
        text: '/trigger',
      });

      // /trigger commands should pass through trigger mode filter
      // (handled by MessageHandler's isTriggerCommand check)
      expect(result.emitted).toBe(true);
      expect(result.filtered).toBe(false);
    });
  });

  // ==========================================================================
  // IPC transport layer verification
  // ==========================================================================

  describe('IPC transport layer', () => {
    it('should respond to ping through IPC transport', async () => {
      const response = await client.sendRawRequest(TEST_REQUEST_TYPES.PING, {});

      expect(response.success).toBe(true);
      expect(response.payload).toEqual({ pong: true });
    });

    it('should return error for unknown request type', async () => {
      const response = await client.sendRawRequest('unknownType', {});

      expect(response.success).toBe(false);
      expect(response.error).toContain('Unknown request type');
    });
  });
});
