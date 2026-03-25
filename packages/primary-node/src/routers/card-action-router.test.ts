/**
 * Tests for CardActionRouter.
 *
 * Issue #1629: Verify resolvedPrompt is passed through when routing
 * card actions to remote Worker Nodes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CardActionRouter } from './card-action-router.js';
import type { CardActionMessage } from '@disclaude/core';

describe('CardActionRouter', () => {
  let router: CardActionRouter;
  let sendToRemoteNode: ReturnType<typeof vi.fn>;
  let isNodeConnected: ReturnType<typeof vi.fn>;

  const baseMessage: CardActionMessage = {
    type: 'card_action',
    chatId: 'chat-1',
    cardMessageId: 'card-msg-1',
    actionType: 'button',
    actionValue: 'confirm',
    actionText: 'Confirm',
  };

  beforeEach(() => {
    sendToRemoteNode = vi.fn().mockResolvedValue(true);
    isNodeConnected = vi.fn().mockReturnValue(true);
    router = new CardActionRouter({
      sendToRemoteNode,
      isNodeConnected,
    });
  });

  afterEach(() => {
    router.dispose();
  });

  describe('registerChatContext / unregisterChatContext', () => {
    it('should register a chat context', () => {
      router.registerChatContext('chat-1', 'node-1', true);
      const ctx = router.getChatContext('chat-1');
      expect(ctx).toEqual({ nodeId: 'node-1', isRemote: true });
    });

    it('should unregister a chat context', () => {
      router.registerChatContext('chat-1', 'node-1', true);
      router.unregisterChatContext('chat-1');
      const ctx = router.getChatContext('chat-1');
      expect(ctx).toBeUndefined();
    });
  });

  describe('routeCardAction', () => {
    it('should return false when no context is registered', async () => {
      const result = await router.routeCardAction(baseMessage);
      expect(result).toBe(false);
      expect(sendToRemoteNode).not.toHaveBeenCalled();
    });

    it('should return false for local node (no routing needed)', async () => {
      router.registerChatContext('chat-1', 'node-1', false);
      const result = await router.routeCardAction(baseMessage);
      expect(result).toBe(false);
      expect(sendToRemoteNode).not.toHaveBeenCalled();
    });

    it('should route card action to remote node', async () => {
      router.registerChatContext('chat-1', 'node-1', true);
      const result = await router.routeCardAction(baseMessage);
      expect(result).toBe(true);
      expect(sendToRemoteNode).toHaveBeenCalledWith('node-1', baseMessage);
    });

    it('should fall back to local when remote node is disconnected', async () => {
      router.registerChatContext('chat-1', 'node-1', true);
      isNodeConnected.mockReturnValue(false);
      const result = await router.routeCardAction(baseMessage);
      expect(result).toBe(false);
      expect(sendToRemoteNode).not.toHaveBeenCalled();
    });

    it('should fall back to local when sendToRemoteNode fails', async () => {
      router.registerChatContext('chat-1', 'node-1', true);
      sendToRemoteNode.mockResolvedValue(false);
      const result = await router.routeCardAction(baseMessage);
      expect(result).toBe(false);
    });

    it('should fall back to local when sendToRemoteNode throws', async () => {
      router.registerChatContext('chat-1', 'node-1', true);
      sendToRemoteNode.mockRejectedValue(new Error('Network error'));
      const result = await router.routeCardAction(baseMessage);
      expect(result).toBe(false);
    });
  });

  describe('Issue #1629: resolvedPrompt passthrough', () => {
    it('should pass resolvedPrompt through to remote node', async () => {
      router.registerChatContext('chat-1', 'node-1', true);

      const messageWithPrompt: CardActionMessage = {
        ...baseMessage,
        resolvedPrompt: 'User wants to proceed with deployment to production',
      };

      const result = await router.routeCardAction(messageWithPrompt);
      expect(result).toBe(true);
      expect(sendToRemoteNode).toHaveBeenCalledWith('node-1', messageWithPrompt);
      // Verify the message passed to remote node contains resolvedPrompt
      const sentMessage = sendToRemoteNode.mock.calls[0][1] as CardActionMessage;
      expect(sentMessage.resolvedPrompt).toBe('User wants to proceed with deployment to production');
    });

    it('should pass message without resolvedPrompt when not set', async () => {
      router.registerChatContext('chat-1', 'node-1', true);

      const result = await router.routeCardAction(baseMessage);
      expect(result).toBe(true);
      const sentMessage = sendToRemoteNode.mock.calls[0][1] as CardActionMessage;
      expect(sentMessage.resolvedPrompt).toBeUndefined();
    });

    it('should forward full CardActionMessage including action details', async () => {
      router.registerChatContext('chat-1', 'node-1', true);

      const fullMessage: CardActionMessage = {
        ...baseMessage,
        userId: 'user-123',
        resolvedPrompt: 'Custom prompt with {{actionText}} replacement',
        action: {
          type: 'button',
          value: 'confirm',
          text: 'Confirm',
          trigger: 'button',
        },
      };

      await router.routeCardAction(fullMessage);
      expect(sendToRemoteNode).toHaveBeenCalledWith('node-1', fullMessage);
    });
  });
});
