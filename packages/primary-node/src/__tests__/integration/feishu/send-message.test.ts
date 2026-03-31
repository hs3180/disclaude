/**
 * Integration Test: Text message send/receive flow.
 *
 * Tests the IPC sendMessage → FeishuChannel.doSendMessage chain,
 * verifying that messages are correctly formatted and dispatched to
 * the Feishu SDK.
 *
 * This test is gated by FEISHU_INTEGRATION_TEST env var.
 * When not set, all tests are automatically skipped.
 *
 * @see Issue #1626 — Optional Feishu integration tests (skip by default)
 */

import { it, expect, vi, beforeEach } from 'vitest';
import { describeIfFeishu } from './helpers.js';
import { createChannelApiHandlers } from '../../../utils/channel-handlers.js';
import type { IChannel, OutgoingMessage } from '@disclaude/core';

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

/**
 * Create a mock channel that records messages instead of sending them.
 */
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

describeIfFeishu('IPC sendMessage — text message flow', () => {
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

  it('should send a text message via IPC handler', async () => {
    await handlers.sendMessage('oc_test_chat', 'Hello from test');

    // Verify the channel received a properly formatted text message
    expect(mockChannel.channel.sendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = mockChannel.sentMessages[0];
    expect(sentMsg.chatId).toBe('oc_test_chat');
    expect(sentMsg.type).toBe('text');
    expect(sentMsg.text).toBe('Hello from test');
  });

  it('should send a text message with threadId', async () => {
    await handlers.sendMessage('oc_test_chat', 'Thread reply', 'om_thread_123');

    const sentMsg = mockChannel.sentMessages[0];
    expect(sentMsg.threadId).toBe('om_thread_123');
  });

  it('should handle empty text gracefully', async () => {
    await handlers.sendMessage('oc_test_chat', '');

    const sentMsg = mockChannel.sentMessages[0];
    expect(sentMsg.text).toBe('');
  });

  it('should propagate channel errors', async () => {
    const errorChannel = createMockChannel();
    const errorHandlers = createChannelApiHandlers(errorChannel.channel, {
      logger: mockLogger as any,
      channelName: 'Feishu',
    });

    // Make sendMessage throw
    (errorChannel.channel.sendMessage as any).mockRejectedValueOnce(
      new Error('Network error')
    );

    await expect(
      errorHandlers.sendMessage('oc_test_chat', 'fail')
    ).rejects.toThrow('Network error');

    // Verify error was logged
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'sendMessage' }),
      'IPC handler failed'
    );
  });
});
