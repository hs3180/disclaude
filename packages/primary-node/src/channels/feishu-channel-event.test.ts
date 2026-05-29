/**
 * Tests for FeishuChannel event extraction and offline queue logic.
 *
 * Covers:
 * - extractChatIdFromEvent: parses chat ID from 4 Feishu event formats
 * - Offline message queue: buffering during WS reconnection
 * - Offline queue expiry: discarding stale messages on flush
 * - Offline queue size limit: dropping oldest when full
 * - getCapabilities: returns correct Feishu capabilities
 * - getBotInfo: delegates to MentionDetector
 * - Trigger mode delegation: isTriggerEnabled/setTriggerEnabled/getTriggerEnabledChats
 *
 * Issue #1357: extractChatIdFromEvent for error notifications.
 * Issue #1351: Offline message queue during reconnection.
 * Related: #1617 (test coverage improvement).
 */



import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel, extractChatIdFromEvent } from './feishu-channel.js';

// ─── Mock Logger ────────────────────────────────────────────────────────────

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

// ─── Mock Lark SDK ──────────────────────────────────────────────────────────

function createMockClient() {
  const createMock = vi.fn().mockResolvedValue({
    data: { message_id: 'new_msg_001' },
  });

  return {
    client: {
      im: {
        message: { create: createMock },
      },
    },
    mocks: { createMock },
  };
}

// ─── Mock Feishu platform modules ───────────────────────────────────────────

vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
  WelcomeService: vi.fn(),
  createFeishuClient: vi.fn(() => {
    const { client } = createMockClient();
    return client;
  }),
}));

const mockTriggerModeManager = vi.hoisted(() => ({
  isTriggerEnabled: vi.fn().mockReturnValue(false),
  setTriggerEnabled: vi.fn(),
  getTriggerEnabledChats: vi.fn().mockReturnValue([]),
}));

const mockMentionDetector = vi.hoisted(() => ({
  setClient: vi.fn(),
  fetchBotInfo: vi.fn().mockResolvedValue(undefined),
  getBotInfo: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./feishu/index.js', () => ({
  TriggerModeManager: vi.fn().mockImplementation(() => mockTriggerModeManager),
  MentionDetector: vi.fn().mockImplementation(() => mockMentionDetector),
  WelcomeHandler: vi.fn().mockImplementation(() => ({
    handleP2PChatEntered: vi.fn(),
    handleChatMemberAdded: vi.fn(),
    setWelcomeService: vi.fn(),
  })),
  MessageHandler: vi.fn().mockImplementation(() => ({
    handleMessageReceive: vi.fn(),
    handleCardAction: vi.fn(),
    initialize: vi.fn(),
    clearClient: vi.fn(),
  })),
  messageLogger: { init: vi.fn().mockResolvedValue(undefined) },
  WsConnectionManager: vi.fn().mockImplementation(() => ({
    state: 'connected',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    getMetrics: vi.fn().mockReturnValue(undefined),
  })),
  type: {},
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestChannel(mockClient: ReturnType<typeof createMockClient>['client']) {
  const channel = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
  (channel as any).client = mockClient;
  (channel as any)._status = 'running';
  return channel;
}

// ═══════════════════════════════════════════════════════════════════════════
// extractChatIdFromEvent
// ═══════════════════════════════════════════════════════════════════════════

describe('extractChatIdFromEvent — Issue #1357', () => {
  it('should extract chat_id from im.message.receive_v1 event', () => {
    const data = {
      event: {
        message: { chat_id: 'oc_chat_001' },
      },
    };

    expect(extractChatIdFromEvent(data)).toBe('oc_chat_001');
  });

  it('should extract open_chat_id from card.action.trigger event', () => {
    const data = {
      context: { open_chat_id: 'oc_card_chat_002' },
    };

    expect(extractChatIdFromEvent(data)).toBe('oc_card_chat_002');
  });

  it('should extract chat_id from chat.member.added_v1 event', () => {
    const data = {
      event: { chat_id: 'oc_member_chat_003' },
    };

    expect(extractChatIdFromEvent(data)).toBe('oc_member_chat_003');
  });

  it('should extract open_id from bot_p2p_chat_entered_v1 event', () => {
    const data = {
      event: {
        user: { open_id: 'ou_user_004' },
      },
    };

    expect(extractChatIdFromEvent(data)).toBe('ou_user_004');
  });

  it('should prioritize message.chat_id over event.chat_id when both exist', () => {
    const data = {
      event: {
        message: { chat_id: 'oc_priority' },
        chat_id: 'oc_lower_priority',
      },
    };

    expect(extractChatIdFromEvent(data)).toBe('oc_priority');
  });

  it('should return undefined for null input', () => {
    expect(extractChatIdFromEvent(null)).toBeUndefined();
  });

  it('should return undefined for empty object', () => {
    expect(extractChatIdFromEvent({})).toBeUndefined();
  });

  it('should return undefined when event has no recognized fields', () => {
    const data = {
      event: { unknown_field: 'value' },
    };

    expect(extractChatIdFromEvent(data)).toBeUndefined();
  });

  it('should return undefined when message exists but chat_id is not a string', () => {
    const data = {
      event: {
        message: { chat_id: 12345 },
      },
    };

    expect(extractChatIdFromEvent(data)).toBeUndefined();
  });

  it('should return undefined when context.open_chat_id is not a string', () => {
    const data = {
      context: { open_chat_id: null },
    };

    expect(extractChatIdFromEvent(data)).toBeUndefined();
  });

  it('should return undefined when user.open_id is not a string', () => {
    const data = {
      event: {
        user: { open_id: { nested: 'object' } },
      },
    };

    expect(extractChatIdFromEvent(data)).toBeUndefined();
  });

  it('should return undefined when event.chat_id is not a string', () => {
    const data = {
      event: { chat_id: true },
    };

    expect(extractChatIdFromEvent(data)).toBeUndefined();
  });

  it('should handle message event without message field', () => {
    const data = {
      event: {},
    };

    expect(extractChatIdFromEvent(data)).toBeUndefined();
  });

  it('should fall back to context.open_chat_id when message.chat_id is missing', () => {
    const data = {
      event: {
        message: {},
      },
      context: { open_chat_id: 'oc_fallback' },
    };

    expect(extractChatIdFromEvent(data)).toBe('oc_fallback');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Offline Message Queue — Issue #1351
// ═══════════════════════════════════════════════════════════════════════════

describe('FeishuChannel offline queue — Issue #1351', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should queue message when WebSocket is not connected', async () => {
    const { client } = createMockClient();
    const channel = createTestChannel(client);

    // Set WS state to reconnecting
    const wsManager = {
      state: 'reconnecting',
      isHealthy: vi.fn().mockReturnValue(false),
    };
    (channel as any).wsConnectionManager = wsManager;

    const result = await channel.sendMessage({
      chatId: 'chat_123',
      type: 'text',
      text: 'Queued message',
    });

    // Message should be queued (doSendMessage returns void for queued)
    expect(result).toBeUndefined();
    expect((channel as any).offlineQueue).toHaveLength(1);
    expect((channel as any).offlineQueue[0].message.text).toBe('Queued message');
  });

  it('should not queue message when WebSocket is connected', async () => {
    const { client, mocks } = createMockClient();
    const channel = createTestChannel(client);

    // WS is connected (default mock state)
    const wsManager = {
      state: 'connected',
      isHealthy: vi.fn().mockReturnValue(true),
    };
    (channel as any).wsConnectionManager = wsManager;

    await channel.sendMessage({
      chatId: 'chat_123',
      type: 'text',
      text: 'Direct message',
    });

    // Message should go through directly
    expect(mocks.createMock).toHaveBeenCalledTimes(1);
    expect((channel as any).offlineQueue).toHaveLength(0);
  });

  it('should record queuedAt timestamp when queuing', async () => {
    const { client } = createMockClient();
    const channel = createTestChannel(client);

    const wsManager = { state: 'reconnecting', isHealthy: vi.fn().mockReturnValue(false) };
    (channel as any).wsConnectionManager = wsManager;

    const before = Date.now();
    await channel.sendMessage({
      chatId: 'chat_123',
      type: 'text',
      text: 'Timestamped',
    });
    const after = Date.now();

    const { offlineQueue } = (channel as any);
    const [entry] = offlineQueue;
    expect(entry.queuedAt).toBeGreaterThanOrEqual(before);
    expect(entry.queuedAt).toBeLessThanOrEqual(after);
  });

  it('should drop oldest message when queue exceeds MAX_SIZE', async () => {
    const { client } = createMockClient();
    const channel = createTestChannel(client);

    const wsManager = { state: 'reconnecting', isHealthy: vi.fn().mockReturnValue(false) };
    (channel as any).wsConnectionManager = wsManager;

    // Fill queue to MAX_SIZE (100)
    for (let i = 0; i < 100; i++) {
      await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: `Message ${i}`,
      });
    }

    expect((channel as any).offlineQueue).toHaveLength(100);

    // Queue one more — should drop oldest
    await channel.sendMessage({
      chatId: 'chat_123',
      type: 'text',
      text: 'Overflow message',
    });

    expect((channel as any).offlineQueue).toHaveLength(100);
    // First message should be dropped, second should be at index 0
    expect((channel as any).offlineQueue[0].message.text).toBe('Message 1');
    expect((channel as any).offlineQueue[99].message.text).toBe('Overflow message');
  });

  it('should discard expired messages on flush', async () => {
    const { client, mocks } = createMockClient();
    const channel = createTestChannel(client);

    const wsManager = { state: 'reconnecting', isHealthy: vi.fn().mockReturnValue(false) };
    (channel as any).wsConnectionManager = wsManager;

    // Queue a message with a very old timestamp (expired)
    const expiredMessage = {
      message: {
        chatId: 'chat_123',
        type: 'text' as const,
        text: 'Expired message',
      },
      queuedAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago (> 10 min MAX_MESSAGE_AGE_MS)
    };

    const freshMessage = {
      message: {
        chatId: 'chat_123',
        type: 'text' as const,
        text: 'Fresh message',
      },
      queuedAt: Date.now(),
    };

    (channel as any).offlineQueue = [expiredMessage, freshMessage];

    // Simulate reconnection: set WS state to connected before flush
    wsManager.state = 'connected';

    // Trigger flush (simulates reconnection)
    await (channel as any).flushOfflineQueue();

    // Only the fresh message should have been sent
    expect(mocks.createMock).toHaveBeenCalledTimes(1);
    expect((channel as any).offlineQueue).toHaveLength(0);
  });

  it('should not send anything when all queued messages are expired', async () => {
    const { client, mocks } = createMockClient();
    const channel = createTestChannel(client);

    const wsManager = { state: 'reconnecting', isHealthy: vi.fn().mockReturnValue(false) };
    (channel as any).wsConnectionManager = wsManager;

    // Queue two expired messages
    (channel as any).offlineQueue = [
      {
        message: { chatId: 'chat_123', type: 'text', text: 'Old 1' },
        queuedAt: Date.now() - 20 * 60 * 1000,
      },
      {
        message: { chatId: 'chat_123', type: 'text', text: 'Old 2' },
        queuedAt: Date.now() - 15 * 60 * 1000,
      },
    ];

    await (channel as any).flushOfflineQueue();

    expect(mocks.createMock).not.toHaveBeenCalled();
  });

  it('should handle empty queue flush gracefully', async () => {
    const { client, mocks } = createMockClient();
    const channel = createTestChannel(client);

    await (channel as any).flushOfflineQueue();

    expect(mocks.createMock).not.toHaveBeenCalled();
  });

  it('should continue flushing after individual message send errors', async () => {
    const { client, mocks } = createMockClient();
    const channel = createTestChannel(client);

    // First call fails, second succeeds
    mocks.createMock
      .mockRejectedValueOnce(new Error('Send failed'))
      .mockResolvedValueOnce({ data: { message_id: 'msg_002' } });

    const now = Date.now();
    (channel as any).offlineQueue = [
      { message: { chatId: 'chat_123', type: 'text', text: 'Will fail' }, queuedAt: now },
      { message: { chatId: 'chat_123', type: 'text', text: 'Will succeed' }, queuedAt: now },
    ];

    await (channel as any).flushOfflineQueue();

    // Both attempts should have been made
    expect(mocks.createMock).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getCapabilities
// ═══════════════════════════════════════════════════════════════════════════

describe('FeishuChannel getCapabilities', () => {
  it('should return correct Feishu channel capabilities', () => {
    const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
    const caps = channel.getCapabilities();

    expect(caps.supportsCard).toBe(true);
    expect(caps.supportsThread).toBe(true);
    expect(caps.supportsFile).toBe(true);
    expect(caps.supportsMarkdown).toBe(true);
    expect(caps.supportsMention).toBe(true);
    expect(caps.supportsUpdate).toBe(true);
    expect(caps.supportedMcpTools).toContain('send_text');
    expect(caps.supportedMcpTools).toContain('send_card');
    expect(caps.supportedMcpTools).toContain('send_interactive');
    expect(caps.supportedMcpTools).toContain('send_file');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getBotInfo
// ═══════════════════════════════════════════════════════════════════════════

describe('FeishuChannel getBotInfo', () => {
  it('should return empty openId when MentionDetector has no bot info', () => {
    const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
    const info = channel.getBotInfo();

    expect(info.openId).toBe('');
    expect(info.name).toBe('Bot');
  });

  it('should return bot openId from MentionDetector', () => {
    mockMentionDetector.getBotInfo.mockReturnValue({ open_id: 'ou_bot_123' });

    const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
    const info = channel.getBotInfo();

    expect(info.openId).toBe('ou_bot_123');
    expect(info.name).toBe('Bot');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trigger mode delegation
// ═══════════════════════════════════════════════════════════════════════════

describe('FeishuChannel trigger mode delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate isTriggerEnabled to TriggerModeManager', () => {
    mockTriggerModeManager.isTriggerEnabled.mockReturnValue(true);
    const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });

    expect(channel.isTriggerEnabled('chat_123')).toBe(true);
    expect(mockTriggerModeManager.isTriggerEnabled).toHaveBeenCalledWith('chat_123');
  });

  it('should delegate setTriggerEnabled to TriggerModeManager', () => {
    const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
    channel.setTriggerEnabled('chat_456', true);

    expect(mockTriggerModeManager.setTriggerEnabled).toHaveBeenCalledWith('chat_456', true);
  });

  it('should delegate getTriggerEnabledChats to TriggerModeManager', () => {
    mockTriggerModeManager.getTriggerEnabledChats.mockReturnValue(['chat_1', 'chat_2']);
    const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });

    expect(channel.getTriggerEnabledChats()).toEqual(['chat_1', 'chat_2']);
  });

  it('should expose TriggerModeManager via getTriggerModeManager', () => {
    const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
    const manager = channel.getTriggerModeManager();

    expect(manager).toBeDefined();
    expect(typeof manager.isTriggerEnabled).toBe('function');
  });
});
