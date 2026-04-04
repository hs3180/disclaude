/**
 * Tests for FeishuChannel post format with @mentions support.
 *
 * Issue #1742: Bot-to-bot @mention conversations.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockClient() {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          data: { message_id: 'msg_test_123' },
        }),
        reply: vi.fn().mockResolvedValue({}),
        patch: vi.fn().mockResolvedValue({}),
      },
      image: {
        create: vi.fn().mockResolvedValue({ image_key: 'img_key_123' }),
      },
      file: {
        create: vi.fn().mockResolvedValue({ file_key: 'file_key_123' }),
      },
    },
    request: vi.fn().mockResolvedValue({
      bot: { open_id: 'cli_test_bot', app_id: 'app_test' },
    }),
  } as any;
}

function createFeishuChannel(client?: any): FeishuChannel {
  const channel = new FeishuChannel({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
  });

  if (client) {
    (channel as any).client = client;
  }

  return channel;
}

// ============================================================================
// Tests: buildPostContentWithMentions (via doSendMessage)
// ============================================================================

describe('FeishuChannel mentions support (Issue #1742)', () => {
  let channel: FeishuChannel;
  let mockClient: any;

  beforeEach(() => {
    mockClient = createMockClient();
    channel = createFeishuChannel(mockClient);
    vi.clearAllMocks();
  });

  it('should send plain text when no mentions provided', async () => {
    await (channel as any).doSendMessage({
      chatId: 'oc_test',
      type: 'text',
      text: 'Hello world',
    });

    expect(mockClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_test',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Hello world' }),
      },
    });
  });

  it('should use post format when mentions are provided', async () => {
    const mentions = [{ openId: 'ou_user123', name: 'Alice' }];
    await (channel as any).doSendMessage({
      chatId: 'oc_test',
      type: 'text',
      text: 'Please review this',
      mentions,
    });

    expect(mockClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_test',
        msg_type: 'post',
        content: expect.any(String),
      },
    });

    // Verify the post content structure
    const callArgs = mockClient.im.message.create.mock.calls[0][0].data;
    const parsed = JSON.parse(callArgs.content);
    expect(parsed.zh_cn.title).toBe('');
    expect(parsed.zh_cn.content).toHaveLength(1);
    expect(parsed.zh_cn.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_user123' },
      { tag: 'text', text: ' Please review this' },
    ]);
  });

  it('should support multiple mentions in one message', async () => {
    const mentions = [
      { openId: 'ou_user1', name: 'Alice' },
      { openId: 'ou_user2', name: 'Bob' },
      { openId: 'cli_bot1', name: 'Bot A' },
    ];
    await (channel as any).doSendMessage({
      chatId: 'oc_test',
      type: 'text',
      text: 'Please review',
      mentions,
    });

    const callArgs = mockClient.im.message.create.mock.calls[0][0].data;
    const parsed = JSON.parse(callArgs.content);
    expect(parsed.zh_cn.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_user1' },
      { tag: 'at', user_id: 'ou_user2' },
      { tag: 'at', user_id: 'cli_bot1' },
      { tag: 'text', text: ' Please review' },
    ]);
  });

  it('should handle mentions without text content', async () => {
    const mentions = [{ openId: 'ou_user1', name: 'Alice' }];
    await (channel as any).doSendMessage({
      chatId: 'oc_test',
      type: 'text',
      text: '',
      mentions,
    });

    const callArgs = mockClient.im.message.create.mock.calls[0][0].data;
    const parsed = JSON.parse(callArgs.content);
    // Only the @mention tag, no text element
    expect(parsed.zh_cn.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_user1' },
    ]);
  });

  it('should handle mentions without name', async () => {
    const mentions = [{ openId: 'ou_user1' }];
    await (channel as any).doSendMessage({
      chatId: 'oc_test',
      type: 'text',
      text: 'Hello',
      mentions,
    });

    const callArgs = mockClient.im.message.create.mock.calls[0][0].data;
    const parsed = JSON.parse(callArgs.content);
    expect(parsed.zh_cn.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_user1' },
      { tag: 'text', text: ' Hello' },
    ]);
  });

  it('should use msg_type text for empty mentions array', async () => {
    await (channel as any).doSendMessage({
      chatId: 'oc_test',
      type: 'text',
      text: 'Hello',
      mentions: [],
    });

    expect(mockClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_test',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Hello' }),
      },
    });
  });

  it('should support bot-to-bot mentions (cli_ prefix openId)', async () => {
    const mentions = [{ openId: 'cli_other_bot', name: 'Other Bot' }];
    await (channel as any).doSendMessage({
      chatId: 'oc_test',
      type: 'text',
      text: 'Hey bot!',
      mentions,
    });

    const callArgs = mockClient.im.message.create.mock.calls[0][0].data;
    const parsed = JSON.parse(callArgs.content);
    expect(parsed.zh_cn.content[0][0]).toEqual({
      tag: 'at',
      user_id: 'cli_other_bot',
    });
  });
});
