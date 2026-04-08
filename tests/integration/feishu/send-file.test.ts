/**
 * Integration tests for IPC sendCard end-to-end flow.
 *
 * Tests the complete chain: IPC request → card message delivery.
 *
 * Prerequisites:
 *   - Primary Node must be running with IPC enabled
 *   - FEISHU_INTEGRATION_TEST=true
 *   - FEISHU_TEST_CHAT_ID set to a valid chat where the bot is a member
 *
 * @see Issue #1626 - Feishu integration test framework
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient } from '@disclaude/core';
import {
  describeIfFeishu,
  getTestChatId,
  getTestSocketPath,
} from './helpers.js';

describeIfFeishu('IPC sendCard end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

  beforeAll(async () => {
    chatId = getTestChatId();
    client = new UnixSocketIpcClient({
      socketPath: getTestSocketPath(),
      timeout: 15000,
    });
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  it('should send a simple card message', async () => {
    const result = await client.sendCard(
      chatId,
      {
        schema: '2.0',
        config: {
          wide_screen_mode: true,
        },
        header: {
          title: {
            tag: 'plain_text',
            content: '集成测试卡片',
          },
          template: 'blue',
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '这是一条来自集成测试的卡片消息。',
            },
          },
        ],
      },
      undefined,
      '集成测试卡片描述'
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });

  it('should send a card with markdown content', async () => {
    const result = await client.sendCard(
      chatId,
      {
        schema: '2.0',
        config: {
          wide_screen_mode: true,
        },
        header: {
          title: {
            tag: 'plain_text',
            content: 'Markdown 测试',
          },
          template: 'green',
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '**粗体** _斜体_ [链接](https://example.com)\n- 列表项 1\n- 列表项 2',
            },
          },
          {
            tag: 'hr',
          },
          {
            tag: 'note',
            elements: [
              {
                tag: 'plain_text',
                content: `集成测试时间: ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      }
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
  });
});
