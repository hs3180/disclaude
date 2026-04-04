/**
 * Feishu Integration Test: Text message send/receive end-to-end.
 *
 * Tests the sendMessage IPC flow through the channel handler layer:
 * - Text message delegation to channel.sendMessage
 * - Thread (reply) support
 * - Error propagation and logging
 * - Multi-message scenarios
 *
 * P1 priority per Issue #1626.
 *
 * @module integration/feishu/send-message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChannelApiHandlers } from '../../../utils/channel-handlers.js';
import { createMockChannel, getSentMessages, describeIfFeishu, getTestChatId } from './helpers.js';

// ============================================================================
// Tests: sendMessage handler integration with mock channel
// ============================================================================

describe('sendMessage: handler integration', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    mockChannel = createMockChannel();
    vi.clearAllMocks();
  });

  it('should send plain text message', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('oc_test_chat', 'Hello, World!');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      chatId: 'oc_test_chat',
      type: 'text',
      text: 'Hello, World!',
      threadId: undefined,
    });
  });

  it('should send text message with thread reply', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('oc_test_chat', 'This is a reply', 'thread_msg_123');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      chatId: 'oc_test_chat',
      type: 'text',
      text: 'This is a reply',
      threadId: 'thread_msg_123',
    });
  });

  it('should send multiple messages in sequence', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('oc_test_chat', 'Message 1');
    await handlers.sendMessage('oc_test_chat', 'Message 2');
    await handlers.sendMessage('oc_test_chat', 'Message 3');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(3);
    expect(sent.map((m) => m.text)).toEqual(['Message 1', 'Message 2', 'Message 3']);
  });

  it('should send messages to different chats', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('oc_chat_1', 'Hello chat 1');
    await handlers.sendMessage('oc_chat_2', 'Hello chat 2');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(2);
    expect(sent[0].chatId).toBe('oc_chat_1');
    expect(sent[1].chatId).toBe('oc_chat_2');
  });

  it('should propagate channel errors', async () => {
    const errorChannel = createMockChannel({
      sendMessage: async () => { throw new Error('Feishu API rate limit exceeded'); },
    } as any);

    const handlers = createChannelApiHandlers(errorChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await expect(handlers.sendMessage('oc_test', 'fail'))
      .rejects.toThrow('Feishu API rate limit exceeded');

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'oc_test',
        handler: 'sendMessage',
      }),
      'IPC handler failed'
    );
  });

  it('should handle empty text message', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('oc_test', '');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('');
  });

  it('should handle very long text message', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const longText = 'A'.repeat(10000);
    await handlers.sendMessage('oc_test', longText);

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toHaveLength(10000);
  });

  it('should handle Unicode and emoji text', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('oc_test', '你好世界 🌍 Bonjour ça va? 🎉');

    const sent = getSentMessages(mockChannel);
    expect(sent[0].text).toBe('你好世界 🌍 Bonjour ça va? 🎉');
  });

  it('should handle special markdown characters in text', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.sendMessage('oc_test', '**bold** _italic_ `code` [link](url)');

    const sent = getSentMessages(mockChannel);
    expect(sent[0].text).toBe('**bold** _italic_ `code` [link](url)');
  });
});

// ============================================================================
// Tests: Real Feishu API (gated behind FEISHU_INTEGRATION_TEST)
// ============================================================================

describeIfFeishu('sendMessage: real Feishu API', () => {
  it('should verify test chat ID is configured', () => {
    const chatId = getTestChatId();
    expect(chatId).toBeTruthy();
    expect(chatId).toMatch(/^oc_/);
  });
});
