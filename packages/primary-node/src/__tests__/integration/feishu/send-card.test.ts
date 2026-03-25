/**
 * Integration tests for IPC sendCard end-to-end.
 *
 * Tests card message sending via IPC to verify the complete chain
 * from Worker Node through IPC to Feishu API.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chatId> npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { UnixSocketIpcClient, getIpcSocketPath, resetIpcClient } from '@disclaude/core';
import { describeIfFeishu, setupFeishuIntegration, INTEGRATION_TIMEOUT } from './helpers.js';

describeIfFeishu('IPC sendCard end-to-end', () => {
  let client: UnixSocketIpcClient;
  let chatId: string;

  beforeAll(async () => {
    chatId = setupFeishuIntegration();

    resetIpcClient();
    client = new UnixSocketIpcClient({
      socketPath: getIpcSocketPath(),
      timeout: 10000,
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    await client.disconnect();
    resetIpcClient();
  });

  it(
    'should send a simple card message',
    async () => {
      const result = await client.sendCard(
        chatId,
        {
          config: {
            wide_screen_mode: true,
          },
          header: {
            title: {
              content: '🧪 Integration Test Card',
              tag: 'plain_text',
            },
            template: 'blue',
          },
          elements: [
            {
              tag: 'markdown',
              content: 'This is an integration test card message.',
            },
          ],
        },
        undefined,
        'Integration test card'
      );

      expect(result.success).toBe(true);
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should send a card with multiple elements',
    async () => {
      const result = await client.sendCard(
        chatId,
        {
          config: {
            wide_screen_mode: true,
          },
          header: {
            title: {
              content: '🧪 Multi-Element Card',
              tag: 'plain_text',
            },
            template: 'green',
          },
          elements: [
            {
              tag: 'markdown',
              content: '## Section 1\nSome content here.',
            },
            {
              tag: 'hr',
            },
            {
              tag: 'markdown',
              content: '## Section 2\nMore content below.',
            },
            {
              tag: 'note',
              elements: [
                {
                  tag: 'plain_text',
                  content: 'This is a footnote.',
                },
              ],
            },
          ],
        },
        undefined,
        'Multi-element integration test card'
      );

      expect(result.success).toBe(true);
    },
    INTEGRATION_TIMEOUT
  );

  it(
    'should send a card as a thread reply',
    async () => {
      // First send a parent message
      const parentResult = await client.sendMessage(
        chatId,
        '🧪 Integration test: parent message for card thread'
      );
      expect(parentResult.success).toBe(true);

      const threadId = parentResult.messageId;
      if (!threadId) {
        console.warn('Skipping card thread test: no messageId from parent');
        return;
      }

      const result = await client.sendCard(
        chatId,
        {
          config: { wide_screen_mode: true },
          header: {
            title: {
              content: '🧪 Thread Reply Card',
              tag: 'plain_text',
            },
            template: 'purple',
          },
          elements: [
            {
              tag: 'markdown',
              content: 'This card is a thread reply.',
            },
          ],
        },
        threadId,
        'Card thread reply test'
      );

      expect(result.success).toBe(true);
    },
    INTEGRATION_TIMEOUT
  );
});
