/**
 * Feishu Integration Test: Text Message Send/Receive.
 *
 * Tests the end-to-end flow of sending text messages via Feishu API.
 * Verifies that the API accepts the request and returns a valid message ID.
 *
 * @module integration/feishu/send-message
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

describeIfFeishu('Feishu: Send Text Message (P1)', () => {
  let client: lark.Client;
  let chatId: string;
  const sentMessageIds: string[] = [];

  beforeAll(() => {
    client = createTestClient();
    chatId = getTestChatId();
  });

  afterAll(async () => {
    // Clean up: recall sent messages if possible
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
    'should send a plain text message and receive a valid message_id',
    async () => {
      const marker = generateTestMarker();
      const text = `${marker} Integration test: plain text message`;

      const response = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      const messageId = response?.data?.message_id;
      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe('string');
      expect(messageId!.length).toBeGreaterThan(0);

      // Save for cleanup
      sentMessageIds.push(messageId!);
    },
    FEISHU_TEST_TIMEOUT
  );

  it(
    'should send a message and retrieve it by message_id',
    async () => {
      const marker = generateTestMarker();
      const text = `${marker} Integration test: message retrieval`;

      // Send message
      const sendResponse = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      const messageId = sendResponse?.data?.message_id;
      expect(messageId).toBeDefined();
      sentMessageIds.push(messageId!);

      // Retrieve the message
      const getResponse = await client.im.message.get({
        path: { message_id: messageId! },
        params: { message_id_type: 'message_id' },
      });

      const items = getResponse?.data?.items;
      expect(items).toBeDefined();
      expect(items!.length).toBeGreaterThan(0);

      const retrievedMessage = items![0];
      expect(retrievedMessage.msg_type).toBe('text');

      const content = JSON.parse(retrievedMessage.body?.content || '{}');
      expect(content.text).toContain(marker);
    },
    FEISHU_TEST_TIMEOUT
  );

  it(
    'should reject sending to an invalid chat_id',
    async () => {
      const marker = generateTestMarker();
      const invalidChatId = 'oc_invalid_chat_id_that_does_not_exist';

      await expect(
        client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: invalidChatId,
            msg_type: 'text',
            content: JSON.stringify({ text: `${marker} Should fail` }),
          },
        })
      ).rejects.toThrow();
    },
    FEISHU_TEST_TIMEOUT
  );
});
