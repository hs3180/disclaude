/**
 * Integration Test: Card message sending flow.
 *
 * Tests the IPC sendCard → FeishuChannel.doSendMessage chain,
 * verifying that card messages are correctly dispatched.
 *
 * This test is gated by FEISHU_INTEGRATION_TEST env var.
 * When not set, all tests are automatically skipped.
 *
 * @see Issue #1626 — Optional Feishu integration tests (skip by default)
 */

import { it, expect, vi, beforeEach } from 'vitest';
import { describeIfFeishu } from './helpers.js';
import { createChannelApiHandlers } from '../../../utils/channel-handlers.js';
import type { IChannel, OutgoingMessage, FeishuCard } from '@disclaude/core';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

function createMockChannel() {
  const sentMessages: OutgoingMessage[] = [];

  const channel: IChannel = {
    id: 'test-feishu',
    name: 'Test Feishu',
    type: 'feishu',
    capabilities: {
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
    },
    isRunning: false,
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(async (msg: OutgoingMessage) => {
      sentMessages.push(msg);
    }),
    onMessage: vi.fn(),
    onControl: vi.fn(),
    checkHealth: vi.fn(() => true),
  } as unknown as IChannel;

  return { channel, sentMessages };
}

describeIfFeishu('IPC sendCard — card message flow', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let handlers: ReturnType<typeof createChannelApiHandlers>;

  beforeEach(() => {
    mockChannel = createMockChannel();
    handlers = createChannelApiHandlers(mockChannel.channel, {
      logger: mockLogger as any,
      channelName: 'Feishu',
    });
    vi.clearAllMocks();
  });

  it('should send a card message via IPC handler', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Test Card', tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        { tag: 'markdown', content: 'Hello from card test' },
      ],
    };

    await handlers.sendCard('oc_test_chat', card);

    expect(mockChannel.channel.sendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = mockChannel.sentMessages[0];
    expect(sentMsg.chatId).toBe('oc_test_chat');
    expect(sentMsg.type).toBe('card');
    expect(sentMsg.card).toEqual(card);
  });

  it('should send a card with threadId and description', async () => {
    const card: FeishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { content: 'Thread Card', tag: 'plain_text' },
        template: 'green',
      },
      elements: [{ tag: 'markdown', content: 'Reply in thread' }],
    };

    await handlers.sendCard('oc_test_chat', card, 'om_thread_456', 'Test description');

    const sentMsg = mockChannel.sentMessages[0];
    expect(sentMsg.threadId).toBe('om_thread_456');
    expect(sentMsg.description).toBe('Test description');
  });

  it('should propagate sendCard errors', async () => {
    const errorChannel = createMockChannel();
    const errorHandlers = createChannelApiHandlers(errorChannel.channel, {
      logger: mockLogger as any,
      channelName: 'Feishu',
    });

    (errorChannel.channel.sendMessage as any).mockRejectedValueOnce(
      new Error('Card send failed')
    );

    await expect(
      errorHandlers.sendCard('oc_test_chat', {} as FeishuCard)
    ).rejects.toThrow('Card send failed');

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'sendCard' }),
      'IPC handler failed'
    );
  });
});
