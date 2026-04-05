/**
 * Feishu Integration Tests: text message send/receive end-to-end.
 *
 * Tests the IPC sendMessage complete chain via the real Feishu API:
 * 1. Send a text message to the test chat
 * 2. Verify the API response contains a valid message_id
 * 3. Send a reply (thread) message
 *
 * Priority: P1 (Issue #1626)
 *
 * @see Issue #1619 — thread reply support
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  getTestClient,
  allowFeishuHosts,
  extractMessageId,
  testMarker,
} from './helpers.js';

describeIfFeishu('Feishu Integration: sendMessage', () => {
  let client: ReturnType<typeof getTestClient>;
  let chatId: string;

  beforeAll(() => {
    allowFeishuHosts();
    client = getTestClient();
    chatId = getTestChatId();
  });

  describe('text message sending', () => {
    it('should send a plain text message and receive a valid message_id', async () => {
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: testMarker('plain-text') }),
        },
      });

      expect(response).toBeDefined();
      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
      expect(typeof messageId).toBe('string');
    });

    it('should send a message with special characters', async () => {
      const specialContent = 'Special chars: <>&"\'\\n\\t🎉 中文 emoji';
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: specialContent }),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
    });

    it('should send a long text message', async () => {
      const longText = 'A'.repeat(2000);
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: `${testMarker('long-text')}\n${longText}` }),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
    });
  });

  describe('thread reply (Issue #1619)', () => {
    it('should reply to an existing message in a thread', async () => {
      // First, send a root message
      const rootResponse = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: testMarker('thread-root-reply') }),
        },
      });

      const rootMessageId = extractMessageId(rootResponse);
      expect(rootMessageId).toBeTruthy();

      // Reply to the root message
      const replyResponse = await client.im.message.reply({
        path: { message_id: rootMessageId! },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Thread reply message.' }),
        },
      });

      const replyMessageId = extractMessageId(replyResponse);
      expect(replyMessageId).toBeTruthy();
      expect(replyMessageId).not.toBe(rootMessageId);
    });

    it('should send multiple replies in the same thread', async () => {
      // Root message
      const rootResponse = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: testMarker('multi-reply-root') }),
        },
      });

      const rootMessageId = extractMessageId(rootResponse);
      expect(rootMessageId).toBeTruthy();

      // Send 3 replies
      const replyIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const replyResponse = await client.im.message.reply({
          path: { message_id: rootMessageId! },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text: `Reply ${i + 1} in thread.` }),
          },
        });

        const replyId = extractMessageId(replyResponse);
        expect(replyId).toBeTruthy();
        replyIds.push(replyId!);
      }

      // All reply IDs should be unique
      const uniqueIds = new Set(replyIds);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('post message (receive_id_type variants)', () => {
    it('should send a message using chat_id receive_id_type', async () => {
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: testMarker('chat-id-type') }),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
    });
  });
});
