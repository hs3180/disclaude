/**
 * Feishu Integration Tests: InteractiveContextStore multi-card coexistence.
 *
 * Validates the #1625 fix (LRU multi-value cache) in a realistic scenario
 * where multiple interactive cards are sent to the same chat from different
 * sources (IPC scripts, Agent responses).
 *
 * Unlike the unit tests (interactive-context.test.ts), these tests use
 * REAL message IDs from the Feishu API to ensure the store behaves
 * correctly with actual API-returned identifiers.
 *
 * Priority: P0 (Issue #1626)
 *
 * @see Issue #1625 — IPC sendInteractive actionPrompts overwritten by newer card
 * @see InteractiveContextStore — LRU cache with inverted index for cross-card lookup
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
import { InteractiveContextStore } from '../../../interactive-context.js';

describeIfFeishu('Feishu Integration: InteractiveContextStore (#1625)', () => {
  let client: ReturnType<typeof getTestClient>;
  let chatId: string;

  beforeAll(() => {
    allowFeishuHosts();
    client = getTestClient();
    chatId = getTestChatId();
  });

  describe('real message ID registration', () => {
    it('should store and retrieve prompts using real Feishu message IDs', async () => {
      const store = new InteractiveContextStore();

      // Send a real card to get a real message ID
      const card = {
        config: { wide_screen_mode: true },
        elements: [
          { tag: 'markdown', content: testMarker('real-msgid-test') },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Action 1' },
                value: 'action_1',
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

      const realMessageId = extractMessageId(response);
      expect(realMessageId).toBeTruthy();

      // Register with the real message ID
      store.register(realMessageId!, chatId, {
        action_1: '[用户操作] 触发了 Action 1',
      });

      // Verify retrieval by exact messageId
      const prompts = store.getActionPrompts(realMessageId!);
      expect(prompts).toEqual({ action_1: '[用户操作] 触发了 Action 1' });

      // Verify retrieval by chatId
      const chatPrompts = store.getActionPromptsByChatId(chatId);
      expect(chatPrompts).toEqual({ action_1: '[用户操作] 触发了 Action 1' });

      // Verify prompt generation
      const generated = store.generatePrompt(realMessageId!, chatId, 'action_1', 'Action 1');
      expect(generated).toBe('[用户操作] 触发了 Action 1');

      store.clear();
    });

    it('should handle real message IDs that differ between send and callback', async () => {
      const store = new InteractiveContextStore();

      // Send a card
      const card = {
        config: { wide_screen_mode: true },
        elements: [
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: 'Callback Test' },
                value: 'callback_test',
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

      const sentMessageId = extractMessageId(response);
      expect(sentMessageId).toBeTruthy();

      // Register with the sent message ID
      store.register(sentMessageId!, chatId, {
        callback_test: '[用户操作] 回调测试成功',
      });

      // Simulate Feishu callback with a DIFFERENT message ID
      // (Feishu sometimes uses different IDs in callbacks vs send responses)
      const feishuCallbackId = `callback_${sentMessageId}`;
      const prompt = store.generatePrompt(feishuCallbackId, chatId, 'callback_test', 'Callback Test');

      // Should fall back to chatId-based lookup
      expect(prompt).toBe('[用户操作] 回调测试成功');

      store.clear();
    });
  });

  describe('multi-card with real API message IDs', () => {
    it('should maintain separate contexts for multiple real cards', async () => {
      const store = new InteractiveContextStore();

      // Send 3 cards rapidly
      const messageIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const card = {
          config: { wide_screen_mode: true },
          elements: [
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: `Card ${i + 1} Action` },
                  value: `card${i}_action`,
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

        const msgId = extractMessageId(response);
        expect(msgId).toBeTruthy();
        messageIds.push(msgId!);

        // Register with unique prompts for each card
        store.register(msgId!, chatId, {
          [`card${i}_action`]: `[用户操作] 用户选择了 Card ${i + 1}`,
        });
      }

      // All 3 contexts should be stored
      expect(store.size).toBe(3);

      // Each card's prompts should be independently accessible
      for (let i = 0; i < 3; i++) {
        const prompts = store.getActionPrompts(messageIds[i]);
        expect(prompts).toEqual({
          [`card${i}_action`]: `[用户操作] 用户选择了 Card ${i + 1}`,
        });
      }

      // Cross-card lookup should work for any action value
      const card0Prompt = store.generatePrompt('unknown', chatId, 'card0_action', 'Card 1');
      expect(card0Prompt).toBe('[用户操作] 用户选择了 Card 1');

      const card2Prompt = store.generatePrompt('unknown', chatId, 'card2_action', 'Card 3');
      expect(card2Prompt).toBe('[用户操作] 用户选择了 Card 3');

      store.clear();
    });
  });

  describe('LRU eviction with real message IDs', () => {
    it('should evict oldest entries when maxEntriesPerChat is exceeded', async () => {
      // Use a small max to trigger eviction
      const store = new InteractiveContextStore(24 * 60 * 60 * 1000, 3);

      // Send 4 cards (max is 3, so the 1st should be evicted)
      const messageIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const card = {
          config: { wide_screen_mode: true },
          elements: [
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: `LRU ${i}` },
                  value: `lru_${i}`,
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

        const msgId = extractMessageId(response);
        expect(msgId).toBeTruthy();
        messageIds.push(msgId!);

        store.register(msgId!, chatId, {
          [`lru_${i}`]: `Prompt ${i}`,
        });
      }

      // Only 3 should remain
      expect(store.size).toBe(3);

      // The first card should be evicted
      expect(store.getActionPrompts(messageIds[0])).toBeUndefined();

      // The remaining cards should be accessible
      expect(store.getActionPrompts(messageIds[1])).toBeDefined();
      expect(store.getActionPrompts(messageIds[2])).toBeDefined();
      expect(store.getActionPrompts(messageIds[3])).toBeDefined();

      // Cross-card lookup should NOT find evicted card's action
      expect(store.findActionPromptsByChatId(chatId, 'lru_0')).toBeUndefined();

      // But should find non-evicted cards' actions
      expect(store.findActionPromptsByChatId(chatId, 'lru_1')).toBeDefined();
      expect(store.findActionPromptsByChatId(chatId, 'lru_3')).toBeDefined();

      store.clear();
    });
  });
});
