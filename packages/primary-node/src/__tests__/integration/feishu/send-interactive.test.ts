/**
 * Feishu Integration Tests: IPC sendInteractive end-to-end chain.
 *
 * Tests the complete interactive card flow:
 * 1. Send an interactive card via real Feishu API
 * 2. Verify API response contains a valid message_id
 * 3. Register action prompts in InteractiveContextStore
 * 4. Simulate card action callback and verify prompt resolution
 *
 * Priority: P0 (Issue #1626)
 *
 * @see Issue #1625 — InteractiveContextStore multi-card coexistence fix
 * @see Issue #1570 — sendInteractive IPC flow
 * @see Issue #1572 — InteractiveContextStore migration to Primary Node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIfFeishu,
  getTestChatId,
  getTestClient,
  allowFeishuHosts,
  extractMessageId,
  testMarker,
} from './helpers.js';
import { InteractiveContextStore } from '../../../interactive-context.js';

describeIfFeishu('Feishu Integration: sendInteractive', () => {
  let client: ReturnType<typeof getTestClient>;
  let chatId: string;
  let store: InteractiveContextStore;

  beforeAll(() => {
    allowFeishuHosts();
    client = getTestClient();
    chatId = getTestChatId();
    store = new InteractiveContextStore();
  });

  afterAll(() => {
    store.clear();
  });

  describe('card sending via real Feishu API', () => {
    it('should send an interactive card and receive a valid message_id', async () => {
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '🧪 Integration Test Card' },
          template: 'blue',
        },
        elements: [
          { tag: 'markdown', content: testMarker('basic-card-send') },
          {
            tag: 'note',
            elements: [
              {
                tag: 'plain_text',
                content: 'This is an automated integration test message. Safe to ignore.',
              },
            ],
          },
        ],
      };

      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      expect(response).toBeDefined();
      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
      expect(typeof messageId).toBe('string');
    });

    it('should send a card with action buttons', async () => {
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '🧪 Action Buttons Test' },
          template: 'green',
        },
        elements: [
          { tag: 'markdown', content: testMarker('action-buttons') },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Option A' },
                value: 'option_a',
                type: 'primary' as const,
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Option B' },
                value: 'option_b',
              },
            ],
          },
        ],
      };

      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();
    });

    it('should send a card with thread reply support', async () => {
      // First, send a root message
      const rootResponse = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: testMarker('thread-root') }),
        },
      });

      const rootMessageId = extractMessageId(rootResponse);
      expect(rootMessageId).toBeTruthy();

      // Then reply with an interactive card in the thread
      const card = {
        config: { wide_screen_mode: true },
        elements: [
          { tag: 'markdown', content: 'Thread reply with interactive card.' },
        ],
      };

      const replyResponse = await client.im.message.reply({
        path: { message_id: rootMessageId! },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const replyMessageId = extractMessageId(replyResponse);
      expect(replyMessageId).toBeTruthy();
    });
  });

  describe('actionPrompts registration and resolution', () => {
    it('should register action prompts after sending a card and resolve them', async () => {
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '🧪 Prompt Registration Test' },
          template: 'purple',
        },
        elements: [
          { tag: 'markdown', content: testMarker('prompt-registration') },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Confirm' },
                value: 'confirm_action',
                type: 'primary' as const,
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Cancel' },
                value: 'cancel_action',
              },
            ],
          },
        ],
      };

      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const messageId = extractMessageId(response);
      expect(messageId).toBeTruthy();

      // Register action prompts (simulating what IPC sendInteractive does)
      store.register(messageId!, chatId, {
        confirm_action: '[用户操作] 用户确认了操作',
        cancel_action: '[用户操作] 用户取消了操作',
      });

      // Verify registration
      const prompts = store.getActionPrompts(messageId!);
      expect(prompts).toEqual({
        confirm_action: '[用户操作] 用户确认了操作',
        cancel_action: '[用户操作] 用户取消了操作',
      });

      // Simulate card action callback — exact messageId match
      const confirmPrompt = store.generatePrompt(
        messageId!, chatId, 'confirm_action', '确认',
      );
      expect(confirmPrompt).toBe('[用户操作] 用户确认了操作');

      // Simulate callback with unknown messageId (Feishu may send different IDs)
      const cancelFallback = store.generatePrompt(
        'unknown_feishu_callback_id', chatId, 'cancel_action', '取消',
      );
      expect(cancelFallback).toBe('[用户操作] 用户取消了操作');
    });
  });

  describe('multi-card coexistence (#1625)', () => {
    it('should handle action prompts across multiple cards in the same chat', async () => {
      // Send Card A (e.g., from an IPC script)
      const cardA = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '🧪 Card A — IPC Script' },
          template: 'blue',
        },
        elements: [
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Explain AI' },
                value: 'explain_ai',
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'AI Apps' },
                value: 'ai_applications',
              },
            ],
          },
        ],
      };

      const respA = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(cardA),
        },
      });
      const msgIdA = extractMessageId(respA);
      expect(msgIdA).toBeTruthy();

      // Send Card B (e.g., from Agent)
      const cardB = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: '🧪 Card B — Agent' },
          template: 'green',
        },
        elements: [
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Yes' },
                value: 'yes',
                type: 'primary' as const,
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'No' },
                value: 'no',
              },
            ],
          },
        ],
      };

      const respB = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(cardB),
        },
      });
      const msgIdB = extractMessageId(respB);
      expect(msgIdB).toBeTruthy();

      // Register both cards' action prompts
      store.register(msgIdA!, chatId, {
        explain_ai: '[用户操作] 用户想了解AI解释',
        ai_applications: '[用户操作] 用户想看AI应用',
      });
      store.register(msgIdB!, chatId, {
        yes: '[用户操作] 用户确认了',
        no: '[用户操作] 用户拒绝了',
      });

      // Verify cross-card lookup (#1625 fix: inverted index search)
      const aiPrompt = store.generatePrompt(
        'unknown_callback', chatId, 'explain_ai', 'AI解释',
      );
      expect(aiPrompt).toBe('[用户操作] 用户想了解AI解释');

      const confirmPrompt = store.generatePrompt(
        'unknown_callback', chatId, 'yes', '确认',
      );
      expect(confirmPrompt).toBe('[用户操作] 用户确认了');

      // Verify both cards are stored
      expect(store.size).toBeGreaterThanOrEqual(2);
    });
  });
});
