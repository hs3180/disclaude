/**
 * Tests for CardActionRouter.
 *
 * Issue #2939: Simplified to single-node mode — removed remote node routing tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CardActionRouter } from './card-action-router.js';

describe('CardActionRouter', () => {
  let router: CardActionRouter;

  const baseMessage = {
    type: 'card_action' as const,
    chatId: 'chat-1',
    cardMessageId: 'card-msg-1',
    actionType: 'button',
    actionValue: 'confirm',
    actionText: 'Confirm',
  };

  beforeEach(() => {
    router = new CardActionRouter();
  });

  afterEach(() => {
    router.dispose();
  });

  describe('registerChatContext / unregisterChatContext', () => {
    it('should register a chat context', () => {
      router.registerChatContext('chat-1', 'node-1');
      const ctx = router.getChatContext('chat-1');
      expect(ctx).toEqual({ status: 'active', context: { nodeId: 'node-1' } });
    });

    it('should unregister a chat context', () => {
      router.registerChatContext('chat-1', 'node-1');
      router.unregisterChatContext('chat-1');
      const ctx = router.getChatContext('chat-1');
      expect(ctx).toEqual({ status: 'not_found' });
    });
  });

  describe('routeCardAction', () => {
    it('should return { routed: false } when no context is registered', async () => {
      const result = await router.routeCardAction(baseMessage);
      expect(result).toEqual({ routed: false });
    });

    it('should return { routed: false } for registered context (local-only mode)', async () => {
      router.registerChatContext('chat-1', 'node-1');
      const result = await router.routeCardAction(baseMessage);
      expect(result).toEqual({ routed: false });
    });
  });

  describe('maxAge expiry', () => {
    it('should return { routed: false, expired: true } when context has expired', async () => {
      // Create router with very short maxAge (1ms)
      const expiredRouter = new CardActionRouter({ maxAge: 1 });

      expiredRouter.registerChatContext('chat-expired', 'node-1');
      // Wait for entry to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      const expiredMessage = { ...baseMessage, chatId: 'chat-expired' };
      const result = await expiredRouter.routeCardAction(expiredMessage);
      expect(result).toEqual({ routed: false, expired: true });

      expiredRouter.dispose();
    });

    it('should distinguish between expired and not_found contexts (#2247)', async () => {
      const expiredRouter = new CardActionRouter({ maxAge: 1 });

      // Not registered at all
      const notFound = expiredRouter.getChatContext('chat-never');
      expect(notFound).toEqual({ status: 'not_found' });

      // Register and let expire
      expiredRouter.registerChatContext('chat-expired', 'node-1');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const expired = expiredRouter.getChatContext('chat-expired');
      expect(expired).toEqual({ status: 'expired' });

      // Active context
      const activeRouter = new CardActionRouter({ maxAge: 60 * 60 * 1000 }); // 1 hour
      activeRouter.registerChatContext('chat-active', 'node-1');
      const active = activeRouter.getChatContext('chat-active');
      expect(active).toEqual({ status: 'active', context: { nodeId: 'node-1' } });

      expiredRouter.dispose();
      activeRouter.dispose();
    });

    it('should provide getActiveChatContext convenience method (#2247)', () => {
      router.registerChatContext('chat-1', 'node-1');

      // Active context returns the nodeId
      const active = router.getActiveChatContext('chat-1');
      expect(active).toBe('node-1');

      // Unregistered returns undefined
      router.unregisterChatContext('chat-1');
      const gone = router.getActiveChatContext('chat-1');
      expect(gone).toBeUndefined();
    });

    it('should track contexts for different chatIds independently', async () => {
      router.registerChatContext('chat-a', 'node-a');
      router.registerChatContext('chat-b', 'node-b');

      const messageA = { ...baseMessage, chatId: 'chat-a' };
      const messageB = { ...baseMessage, chatId: 'chat-b' };

      const resultA = await router.routeCardAction(messageA);
      const resultB = await router.routeCardAction(messageB);

      // Both should return routed: false (local-only mode)
      expect(resultA).toEqual({ routed: false });
      expect(resultB).toEqual({ routed: false });
    });
  });

  describe('dispose', () => {
    it('should clear all contexts on dispose', () => {
      router.registerChatContext('chat-1', 'node-1');
      router.registerChatContext('chat-2', 'node-2');
      router.dispose();

      expect(router.getChatContext('chat-1')).toEqual({ status: 'not_found' });
      expect(router.getChatContext('chat-2')).toEqual({ status: 'not_found' });
    });
  });
});
