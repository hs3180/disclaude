/**
 * Tests for CardActionRouter.
 *
 * Issue #1629: Tests that resolvedPrompt is correctly passed through
 * when routing card actions to remote Worker Nodes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CardActionRouter } from './card-action-router.js';
import type { CardActionMessage } from '@disclaude/core';

describe('CardActionRouter', () => {
  let router: CardActionRouter;
  let sendToRemoteNode: ReturnType<typeof vi.fn>;
  let isNodeConnected: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendToRemoteNode = vi.fn().mockResolvedValue(true);
    isNodeConnected = vi.fn().mockReturnValue(true);

    router = new CardActionRouter({
      sendToRemoteNode,
      isNodeConnected,
    });
  });

  describe('routeCardAction with resolvedPrompt', () => {
    it('should pass resolvedPrompt to remote node', async () => {
      router.registerChatContext('chat-1', 'worker-1', true);

      const message: CardActionMessage = {
        type: 'card_action',
        chatId: 'chat-1',
        cardMessageId: 'msg-1',
        actionType: 'button',
        actionValue: 'confirm',
        actionText: '确认',
        resolvedPrompt: '[用户操作] 用户选择了「确认」',
      };

      const routed = await router.routeCardAction(message);

      expect(routed).toBe(true);
      expect(sendToRemoteNode).toHaveBeenCalledWith('worker-1', expect.objectContaining({
        resolvedPrompt: '[用户操作] 用户选择了「确认」',
      }));
    });

    it('should pass message without resolvedPrompt when not provided', async () => {
      router.registerChatContext('chat-1', 'worker-1', true);

      const message: CardActionMessage = {
        type: 'card_action',
        chatId: 'chat-1',
        cardMessageId: 'msg-1',
        actionType: 'button',
        actionValue: 'confirm',
        actionText: '确认',
      };

      const routed = await router.routeCardAction(message);

      expect(routed).toBe(true);
      expect(sendToRemoteNode).toHaveBeenCalledWith('worker-1', message);
      // Verify resolvedPrompt is not in the forwarded message
      const forwardedMsg = sendToRemoteNode.mock.calls[0][1] as CardActionMessage;
      expect(forwardedMsg.resolvedPrompt).toBeUndefined();
    });

    it('should pass full CardActionMessage including action data', async () => {
      router.registerChatContext('chat-1', 'worker-1', true);

      const message: CardActionMessage = {
        type: 'card_action',
        chatId: 'chat-1',
        cardMessageId: 'msg-1',
        actionType: 'button',
        actionValue: 'submit',
        actionText: '提交',
        userId: 'user-123',
        action: {
          type: 'button',
          value: 'submit',
          text: '提交',
          trigger: 'button',
        },
        resolvedPrompt: '[用户操作] 用户提交了表单',
      };

      const routed = await router.routeCardAction(message);

      expect(routed).toBe(true);
      expect(sendToRemoteNode).toHaveBeenCalledWith('worker-1', {
        type: 'card_action',
        chatId: 'chat-1',
        cardMessageId: 'msg-1',
        actionType: 'button',
        actionValue: 'submit',
        actionText: '提交',
        userId: 'user-123',
        action: {
          type: 'button',
          value: 'submit',
          text: '提交',
          trigger: 'button',
        },
        resolvedPrompt: '[用户操作] 用户提交了表单',
      });
    });
  });

  describe('routeCardAction fallback behavior', () => {
    it('should return false for unregistered chatId (local handling)', async () => {
      const message: CardActionMessage = {
        type: 'card_action',
        chatId: 'unknown-chat',
        cardMessageId: 'msg-1',
        actionType: 'button',
        actionValue: 'ok',
        resolvedPrompt: 'some prompt',
      };

      const routed = await router.routeCardAction(message);
      expect(routed).toBe(false);
      expect(sendToRemoteNode).not.toHaveBeenCalled();
    });

    it('should return false for local node (no routing needed)', async () => {
      router.registerChatContext('chat-1', 'local-1', false);

      const message: CardActionMessage = {
        type: 'card_action',
        chatId: 'chat-1',
        cardMessageId: 'msg-1',
        actionType: 'button',
        actionValue: 'ok',
        resolvedPrompt: 'some prompt',
      };

      const routed = await router.routeCardAction(message);
      expect(routed).toBe(false);
      expect(sendToRemoteNode).not.toHaveBeenCalled();
    });

    it('should return false and fall back when remote node disconnected', async () => {
      router.registerChatContext('chat-1', 'worker-1', true);
      isNodeConnected.mockReturnValue(false);

      const message: CardActionMessage = {
        type: 'card_action',
        chatId: 'chat-1',
        cardMessageId: 'msg-1',
        actionType: 'button',
        actionValue: 'ok',
        resolvedPrompt: 'some prompt',
      };

      const routed = await router.routeCardAction(message);
      expect(routed).toBe(false);
      expect(sendToRemoteNode).not.toHaveBeenCalled();
    });
  });
});
