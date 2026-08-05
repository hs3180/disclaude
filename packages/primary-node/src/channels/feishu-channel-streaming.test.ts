/**
 * Tests for FeishuChannel Card Kit streaming wiring.
 *
 * Issue #4400 (#4208 P2-c): startStreaming / streamText / finalizeStreaming.
 *
 * The Card Kit 2-step flow (verified against the live Feishu API):
 *   1. startStreaming → POST /cardkit/v1/cards (createCard) → card_id, then
 *      IM-send the card by card_id (msg_type "interactive", {type:'card',data:{card_id}}).
 *   2. streamText → PUT /cards/{card_id}/elements/{element_id}/content (full buffer).
 *   3. finalizeStreaming → PATCH /cards/{card_id}/settings (streaming_mode off).
 *
 * Coverage:
 * - startStreaming declines (→ sendMessage degrade) when the flag is off, the
 *   Card Kit client cannot be built, the lark IM client is missing, or
 *   createCard returns no card_id.
 * - startStreaming success creates + IM-sends the card and returns the card_id.
 * - streamText PATCHes the reply element with a strictly-increasing sequence.
 * - finalizeStreaming freezes the card and makes the handle idempotent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';
import { STREAMING_REPLY_ELEMENT_ID } from '../platforms/feishu/card-builders/streaming-card-builder.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

const mockLogOutgoingMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockCardKit = vi.hoisted(() => ({
  createCard: vi.fn(),
  updateElementContent: vi.fn(),
  updateCard: vi.fn(),
  finalizeStreaming: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
  WelcomeService: vi.fn(),
  createFeishuClient: vi.fn(),
}));

vi.mock('./feishu/index.js', () => ({
  TriggerModeManager: vi.fn().mockImplementation(() => ({
    isTriggerEnabled: vi.fn().mockReturnValue(false),
    setTriggerEnabled: vi.fn(),
    getTriggerEnabledChats: vi.fn().mockReturnValue([]),
  })),
  MentionDetector: vi.fn().mockImplementation(() => ({
    setClient: vi.fn(),
    fetchBotInfo: vi.fn().mockResolvedValue(undefined),
    getBotInfo: vi.fn().mockReturnValue(undefined),
  })),
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
  messageLogger: {
    init: vi.fn().mockResolvedValue(undefined),
    logOutgoingMessage: mockLogOutgoingMessage,
  },
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

vi.mock('../platforms/feishu/feishu-cardkit-client.js', () => ({
  FeishuCardKitClient: vi.fn(),
  createCardKitClientFromEnv: vi.fn(() => mockCardKit),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Mock lark client exposing im.message.create (the IM-send step). */
function createMockLarkClient() {
  const createMock = vi.fn().mockResolvedValue({ data: { message_id: 'msg_001' } });
  return {
    client: { im: { message: { create: createMock } } } as any,
    createMock,
  };
}

function createTestChannel(opts: { streamingCard?: boolean; client?: any } = {}) {
  const channel = new FeishuChannel({
    appId: 'test-app',
    appSecret: 'test-secret',
    ...(opts.streamingCard !== undefined ? { streamingCard: opts.streamingCard } : {}),
  });
  if (opts.client !== undefined) {
    (channel as any).client = opts.client;
  }
  (channel as any)._status = 'running';
  return channel;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCardKit.createCard.mockResolvedValue({ ok: true, status: 200, cardId: 'card_123' });
  mockCardKit.updateElementContent.mockResolvedValue({ ok: true, status: 200 });
  mockCardKit.finalizeStreaming.mockResolvedValue({ ok: true, status: 200 });
});

// ─── startStreaming ─────────────────────────────────────────────────────────

describe('FeishuChannel.startStreaming — Issue #4400', () => {
  it('declines (null) when streamingCard is off', async () => {
    const channel = createTestChannel({ streamingCard: false, client: createMockLarkClient().client });
    await expect(channel.startStreaming('oc_chat1')).resolves.toBe(null);
    expect(mockCardKit.createCard).not.toHaveBeenCalled();
  });

  it('declines when the Card Kit client cannot be built (missing tenant token)', async () => {
    const { createCardKitClientFromEnv } = await import('../platforms/feishu/feishu-cardkit-client.js');
    (createCardKitClientFromEnv as any).mockImplementationOnce(() => {
      throw new Error('LARKSUITE_CLI_TENANT_ACCESS_TOKEN is not set');
    });
    const channel = createTestChannel({ streamingCard: true, client: createMockLarkClient().client });
    await expect(channel.startStreaming('oc_chat1')).resolves.toBe(null);
    expect(mockCardKit.createCard).not.toHaveBeenCalled();
  });

  it('declines when the lark IM client is not ready', async () => {
    const channel = createTestChannel({ streamingCard: true }); // no client injected
    await expect(channel.startStreaming('oc_chat1')).resolves.toBe(null);
    expect(mockCardKit.createCard).not.toHaveBeenCalled();
  });

  it('declines when createCard returns no card_id', async () => {
    mockCardKit.createCard.mockResolvedValueOnce({ ok: true, status: 200, cardId: undefined });
    const { client } = createMockLarkClient();
    const channel = createTestChannel({ streamingCard: true, client });
    await expect(channel.startStreaming('oc_chat1')).resolves.toBe(null);
    expect(client.im.message.create).not.toHaveBeenCalled();
  });

  it('creates the card and IM-sends it by card_id, returning the handle', async () => {
    const { client, createMock } = createMockLarkClient();
    const channel = createTestChannel({ streamingCard: true, client });

    const handle = await channel.startStreaming('oc_chat1', 'om_parent');

    expect(handle).toBe('card_123');
    // Step 1: createCard with the streaming placeholder card.
    expect(mockCardKit.createCard).toHaveBeenCalledTimes(1);
    const [firstCreateCall] = mockCardKit.createCard.mock.calls;
    const [createdCard] = firstCreateCall;
    expect(createdCard.schema).toBe('2.0');
    expect(createdCard.config.streaming_mode).toBe(true);
    // Step 2: IM-send the card by card_id (msg_type "interactive").
    expect(createMock).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat1',
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: 'card_123' } }),
        root_id: 'om_parent',
      },
    });
  });

  it('omits root_id when no parent message id is given', async () => {
    const { client, createMock } = createMockLarkClient();
    const channel = createTestChannel({ streamingCard: true, client });
    await channel.startStreaming('oc_chat1');
    expect(createMock.mock.calls[0][0].data).not.toHaveProperty('root_id');
  });

  it('declines (null) when createCard throws', async () => {
    mockCardKit.createCard.mockRejectedValueOnce(new Error('cardkit 500'));
    const { client } = createMockLarkClient();
    const channel = createTestChannel({ streamingCard: true, client });
    await expect(channel.startStreaming('oc_chat1')).resolves.toBe(null);
  });
});

// ─── streamText / finalizeStreaming ─────────────────────────────────────────

describe('FeishuChannel.streamText / finalizeStreaming — Issue #4400', () => {
  async function startedChannel() {
    const { client } = createMockLarkClient();
    const channel = createTestChannel({ streamingCard: true, client });
    const id = await channel.startStreaming('oc_chat1');
    expect(id).toBe('card_123');
    return { channel, id: id as string };
  }

  it('streamText PATCHes the reply element with a strictly-increasing sequence', async () => {
    const { channel, id } = await startedChannel();

    await channel.streamText(id, 'Hello');
    await channel.streamText(id, 'Hello world');
    await channel.streamText(id, 'Hello world!');

    expect(mockCardKit.updateElementContent).toHaveBeenCalledTimes(3);
    const { calls } = mockCardKit.updateElementContent.mock;
    expect(calls[0]).toEqual([id, STREAMING_REPLY_ELEMENT_ID, 'Hello', 1]);
    expect(calls[1]).toEqual([id, STREAMING_REPLY_ELEMENT_ID, 'Hello world', 2]);
    expect(calls[2]).toEqual([id, STREAMING_REPLY_ELEMENT_ID, 'Hello world!', 3]);
  });

  it('streamText is a no-op for an unknown / already-finalized card', async () => {
    const channel = createTestChannel({ streamingCard: true, client: createMockLarkClient().client });
    await channel.streamText('card_unknown', 'text');
    expect(mockCardKit.updateElementContent).not.toHaveBeenCalled();
  });

  it('finalizeStreaming freezes the card and the next sequence continues to increment', async () => {
    const { channel, id } = await startedChannel();
    await channel.streamText(id, 'partial');
    await channel.finalizeStreaming(id);

    expect(mockCardKit.finalizeStreaming).toHaveBeenCalledTimes(1);
    // streamText used seq 1 → finalizeStreaming uses seq 2.
    expect(mockCardKit.finalizeStreaming.mock.calls[0]).toEqual([id, 2]);
  });

  it('finalizeStreaming is idempotent (second call is a no-op)', async () => {
    const { channel, id } = await startedChannel();
    await channel.finalizeStreaming(id);
    await channel.finalizeStreaming(id); // already cleaned up
    expect(mockCardKit.finalizeStreaming).toHaveBeenCalledTimes(1);
  });

  it('streamText after finalize is a no-op (handle dropped)', async () => {
    const { channel, id } = await startedChannel();
    await channel.finalizeStreaming(id);
    mockCardKit.updateElementContent.mockClear();
    await channel.streamText(id, 'late');
    expect(mockCardKit.updateElementContent).not.toHaveBeenCalled();
  });
});
