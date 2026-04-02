/**
 * Feishu Integration Test: Interactive Card Send.
 *
 * Tests the end-to-end flow of sending interactive cards via Feishu API.
 * Verifies card construction, sending, and action prompt registration.
 *
 * @module integration/feishu/send-interactive
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  createTestClient,
  getTestChatId,
  generateTestMarker,
  FEISHU_TEST_TIMEOUT,
} from './helpers.js';
import * as lark from '@larksuiteoapi/node-sdk';

describeIfFeishu('Feishu: Send Interactive Card (P0)', () => {
  let client: lark.Client;
  let chatId: string;
  const sentMessageIds: string[] = [];

  beforeAll(() => {
    client = createTestClient();
    chatId = getTestChatId();
  });

  afterAll(async () => {
    // Clean up sent messages
    for (const messageId of sentMessageIds) {
      try {
        await client.im.message.delete({
          path: { message_id: messageId },
        });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it(
    'should send an interactive card with header and buttons',
    async () => {
      const marker = generateTestMarker();
      const cardContent = {
        config: {
          wide_screen_mode: true,
        },
        header: {
          title: {
            tag: 'plain_text',
            content: `${marker} Integration Test Card`,
          },
          template: 'blue',
        },
        elements: [
          {
            tag: 'markdown',
            content: `This is an integration test card.\nMarker: ${marker}`,
          },
          {
            tag: 'hr',
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: {
                  tag: 'plain_text',
                  content: 'Confirm',
                },
                value: { action: 'confirm' },
                type: 'primary',
              },
              {
                tag: 'button',
                text: {
                  tag: 'plain_text',
                  content: 'Cancel',
                },
                value: { action: 'cancel' },
                type: 'default',
              },
            ],
          },
        ],
      };

      const response = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(cardContent),
        },
      });

      const messageId = response?.data?.message_id;
      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe('string');
      sentMessageIds.push(messageId!);
    },
    FEISHU_TEST_TIMEOUT
  );

  it(
    'should send a markdown card and verify content',
    async () => {
      const marker = generateTestMarker();
      const markdownContent = `**Bold text** and *italic text*\n\n- List item 1\n- List item 2\n\n${marker}`;

      const cardContent = {
        config: {
          wide_screen_mode: true,
        },
        elements: [
          {
            tag: 'markdown',
            content: markdownContent,
          },
        ],
      };

      // Send card
      const sendResponse = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(cardContent),
        },
      });

      const messageId = sendResponse?.data?.message_id;
      expect(messageId).toBeDefined();
      sentMessageIds.push(messageId!);

      // Retrieve and verify
      const getResponse = await client.im.message.get({
        path: { message_id: messageId! },
        params: { message_id_type: 'message_id' },
      });

      const items = getResponse?.data?.items;
      expect(items).toBeDefined();
      expect(items![0].msg_type).toBe('interactive');

      const content = JSON.parse(items![0].body?.content || '{}');
      // The card should contain our markdown element
      expect(JSON.stringify(content)).toContain('markdown');
    },
    FEISHU_TEST_TIMEOUT
  );

  it(
    'should send a card with select_static menu',
    async () => {
      const marker = generateTestMarker();
      const cardContent = {
        config: {
          wide_screen_mode: true,
        },
        header: {
          title: {
            tag: 'plain_text',
            content: `${marker} Select Menu Test`,
          },
          template: 'green',
        },
        elements: [
          {
            tag: 'markdown',
            content: 'Please select an option:',
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'select_static',
                placeholder: {
                  tag: 'plain_text',
                  content: 'Choose...',
                },
                options: [
                  {
                    text: { tag: 'plain_text', content: 'Option A' },
                    value: 'option_a',
                  },
                  {
                    text: { tag: 'plain_text', content: 'Option B' },
                    value: 'option_b',
                  },
                  {
                    text: { tag: 'plain_text', content: 'Option C' },
                    value: 'option_c',
                  },
                ],
              },
            ],
          },
        ],
      };

      const response = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(cardContent),
        },
      });

      const messageId = response?.data?.message_id;
      expect(messageId).toBeDefined();
      sentMessageIds.push(messageId!);
    },
    FEISHU_TEST_TIMEOUT
  );
});
