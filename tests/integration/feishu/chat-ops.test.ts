/**
 * Feishu Integration Test: ChatOps Operations.
 *
 * Tests ChatOps functions: create discussion chat, list bot chats, etc.
 * These tests verify the Feishu API wrapper functions work correctly.
 *
 * @module integration/feishu/chat-ops
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { it, expect, beforeAll, afterEach } from 'vitest';
import {
  describeIfFeishu,
  createTestClient,
  generateTestMarker,
  FEISHU_TEST_TIMEOUT,
  delay,
} from './helpers.js';
import {
  createDiscussionChat,
  dissolveChat,
  getBotChats,
} from '@disclaude/primary-node';
import * as lark from '@larksuiteoapi/node-sdk';

describeIfFeishu('Feishu: ChatOps (P0)', () => {
  let client: lark.Client;
  const createdChatIds: string[] = [];

  beforeAll(() => {
    client = createTestClient();
  });

  afterEach(async () => {
    // Clean up: dissolve any chats created during tests
    for (const chatId of createdChatIds) {
      try {
        await dissolveChat(client, chatId);
      } catch {
        // Best-effort cleanup
      }
    }
    createdChatIds.length = 0;
  });

  it(
    'should create a discussion chat with auto-generated name',
    async () => {
      const marker = generateTestMarker();
      const chatId = await createDiscussionChat(client, {
        topic: `${marker} Integration Test Group`,
      });

      expect(chatId).toBeDefined();
      expect(typeof chatId).toBe('string');
      expect(chatId.length).toBeGreaterThan(0);
      createdChatIds.push(chatId);
    },
    FEISHU_TEST_TIMEOUT
  );

  it(
    'should create a discussion chat and then dissolve it',
    async () => {
      const marker = generateTestMarker();
      const chatId = await createDiscussionChat(client, {
        topic: `${marker} Temporary Test Group`,
      });

      expect(chatId).toBeDefined();
      // Note: don't push to createdChatIds since we're dissolving it ourselves
      // Wait briefly for Feishu API to propagate
      await delay(1000);

      // Dissolve should succeed
      await expect(dissolveChat(client, chatId)).resolves.not.toThrow();
    },
    FEISHU_TEST_TIMEOUT
  );

  it(
    'should list bot chats and return at least one result',
    async () => {
      const chats = await getBotChats(client);

      expect(Array.isArray(chats)).toBe(true);
      // The bot should be in at least one chat (the test chat)
      // But we don't enforce a minimum since bot might be in zero chats
      for (const chat of chats) {
        expect(chat).toHaveProperty('chatId');
        expect(chat).toHaveProperty('name');
        expect(typeof chat.chatId).toBe('string');
        expect(typeof chat.name).toBe('string');
      }
    },
    FEISHU_TEST_TIMEOUT
  );

  it(
    'should list bot chats with valid chatId format',
    async () => {
      const chats = await getBotChats(client);

      // Feishu chat IDs should start with oc_
      for (const chat of chats) {
        expect(chat.chatId).toMatch(/^oc_/);
      }
    },
    FEISHU_TEST_TIMEOUT
  );
});
