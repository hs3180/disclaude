/**
 * Tests for Input MessageRouter.
 *
 * Verifies routing logic: messages are dispatched to the correct handler
 * method based on their source type, and edge cases are handled properly.
 *
 * Issue #3580: Message types (UserMessage + SystemMessage) and MessageRouter
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessageRouter,
  MessageRoutingError,
  type IAgentMessageHandler,
} from './message-router.js';
import { isUserMessage, isSystemMessage, type UserMessage, type SystemMessage, type Message } from '../types/message.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createUserMessage(overrides?: Partial<UserMessage>): UserMessage {
  return {
    id: 'msg-user-1',
    source: 'user',
    payload: 'Hello!',
    chatId: 'oc_chat123',
    messageId: 'feishu-msg-1',
    createdAt: '2026-05-14T00:00:00Z',
    ...overrides,
  };
}

function createSystemMessage(overrides?: Partial<SystemMessage>): SystemMessage {
  return {
    id: 'msg-sys-1',
    source: 'system',
    payload: 'Run daily maintenance',
    chatId: 'oc_chat456',
    trigger: 'scheduled',
    taskName: 'daily-maintenance',
    createdAt: '2026-05-14T00:00:00Z',
    ...overrides,
  };
}

function createMockHandler(): IAgentMessageHandler {
  return {
    handleUserMessage: vi.fn().mockResolvedValue(undefined),
    handleSystemMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Type Guards
// ============================================================================

describe('Type Guards', () => {
  it('isUserMessage should return true for UserMessage', () => {
    const msg = createUserMessage();
    expect(isUserMessage(msg)).toBe(true);
  });

  it('isUserMessage should return false for SystemMessage', () => {
    const msg = createSystemMessage();
    expect(isUserMessage(msg)).toBe(false);
  });

  it('isSystemMessage should return true for SystemMessage', () => {
    const msg = createSystemMessage();
    expect(isSystemMessage(msg)).toBe(true);
  });

  it('isSystemMessage should return false for UserMessage', () => {
    const msg = createUserMessage();
    expect(isSystemMessage(msg)).toBe(false);
  });
});

// ============================================================================
// MessageRouter — Routing Logic
// ============================================================================

describe('MessageRouter', () => {
  describe('route() with UserMessage', () => {
    it('should route UserMessage to handleUserMessage', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = createUserMessage();

      await router.route(msg);

      expect(handler.handleUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_chat123',
          payload: 'Hello!',
          messageId: 'feishu-msg-1',
        }),
      );
    });

    it('should pass all UserMessage fields to handler', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = createUserMessage({
        senderOpenId: 'ou_sender1',
        chatHistoryContext: 'previous messages...',
      });

      await router.route(msg);

      expect(handler.handleUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_chat123',
          payload: 'Hello!',
          messageId: 'feishu-msg-1',
          senderOpenId: 'ou_sender1',
          chatHistoryContext: 'previous messages...',
        }),
      );
    });

    it('should pass chatType and threadContext to handler (Issue #3641)', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = createUserMessage({
        chatType: 'topic',
        threadContext: 'User: Hello\nBot: Hi there',
      });

      await router.route(msg);

      expect(handler.handleUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_chat123',
          payload: 'Hello!',
          messageId: 'feishu-msg-1',
          chatType: 'topic',
          threadContext: 'User: Hello\nBot: Hi there',
        }),
      );
    });

    it('should pass attachments to handler', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const attachments = [{ id: 'file-1', fileName: 'test.pdf', source: 'user' as const, createdAt: Date.now() }];
      const msg = createUserMessage({ attachments });

      await router.route(msg);

      expect(handler.handleUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_chat123',
          payload: 'Hello!',
          messageId: 'feishu-msg-1',
          attachments,
        }),
      );
    });

    it('should pass chatType and threadContext to handler', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = createUserMessage({
        chatType: 'topic',
        threadContext: 'User: Hello\nBot: Hi!',
      });

      await router.route(msg);

      expect(handler.handleUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_chat123',
          payload: 'Hello!',
          messageId: 'feishu-msg-1',
          chatType: 'topic',
          threadContext: 'User: Hello\nBot: Hi!',
        }),
      );
    });
  });

  describe('route() with SystemMessage', () => {
    it('should route SystemMessage to handleSystemMessage', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = createSystemMessage();

      await router.route(msg);

      expect(handler.handleSystemMessage).toHaveBeenCalledWith(
        'oc_chat456',
        'Run daily maintenance',
        'msg-sys-1',
        { waitForCompletion: undefined }
      );
    });

    it('should route SystemMessage with different triggers', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });

      for (const trigger of ['scheduled', 'signal', 'command'] as const) {
        const msg = createSystemMessage({ trigger });
        await router.route(msg);

        expect(handler.handleSystemMessage).toHaveBeenCalledWith(
          'oc_chat456',
          'Run daily maintenance',
          'msg-sys-1',
          { waitForCompletion: undefined }
        );
      }

      expect(handler.handleSystemMessage).toHaveBeenCalledTimes(3);
    });
  });

  describe('route() with multiple messages', () => {
    it('should route each message to the correct handler', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });

      const userMsg = createUserMessage();
      const sysMsg = createSystemMessage();

      await router.route(userMsg);
      await router.route(sysMsg);

      expect(handler.handleUserMessage).toHaveBeenCalledTimes(1);
      expect(handler.handleSystemMessage).toHaveBeenCalledTimes(1);
    });

    it('should route messages to different chatIds', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });

      const msg1 = createUserMessage({ chatId: 'oc_chatA' });
      const msg2 = createUserMessage({ chatId: 'oc_chatB', id: 'msg-user-2', messageId: 'feishu-msg-2' });

      await router.route(msg1);
      await router.route(msg2);

      expect(handler.handleUserMessage).toHaveBeenCalledTimes(2);
      expect(handler.handleUserMessage).toHaveBeenNthCalledWith(
        1, expect.objectContaining({ chatId: 'oc_chatA', payload: 'Hello!', messageId: 'feishu-msg-1' })
      );
      expect(handler.handleUserMessage).toHaveBeenNthCalledWith(
        2, expect.objectContaining({ chatId: 'oc_chatB', payload: 'Hello!', messageId: 'feishu-msg-2' })
      );
    });
  });

  describe('route() edge cases', () => {
    it('should throw MessageRoutingError when chatId is empty', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = createUserMessage({ chatId: '' });

      await expect(router.route(msg)).rejects.toThrow(MessageRoutingError);
      await expect(router.route(msg)).rejects.toThrow('missing chatId');
    });

    it('should throw MessageRoutingError when chatId is missing', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = { id: 'x', source: 'user' as const, payload: 'hi', createdAt: '' } as Message;

      await expect(router.route(msg)).rejects.toThrow(MessageRoutingError);
    });

    it('should throw MessageRoutingError for unknown source', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = { id: 'x', source: 'unknown' as any, payload: 'hi', chatId: 'oc_1', createdAt: '' } as Message;

      await expect(router.route(msg)).rejects.toThrow(MessageRoutingError);
      await expect(router.route(msg)).rejects.toThrow('Unknown message source');
    });

    it('should wrap handler errors in MessageRoutingError', async () => {
      const handler = createMockHandler();
      handler.handleUserMessage = vi.fn().mockRejectedValue(new Error('Agent pool full'));
      const router = new MessageRouter({ handler });
      const msg = createUserMessage();

      await expect(router.route(msg)).rejects.toThrow(MessageRoutingError);
      await expect(router.route(msg)).rejects.toThrow('Failed to route message');
    });

    it('should not wrap MessageRoutingError in another MessageRoutingError', async () => {
      const handler = createMockHandler();
      const router = new MessageRouter({ handler });
      const msg = { id: 'x', source: 'unknown' as any, payload: 'hi', chatId: 'oc_1', createdAt: '' } as Message;

      try {
        await router.route(msg);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MessageRoutingError);
        // Should not be double-wrapped
        expect((err as Error).message).not.toContain('Failed to route message');
        expect((err as Error).message).toContain('Unknown message source');
      }
    });
  });

  describe('MessageRoutingError', () => {
    it('should have correct name', () => {
      const err = new MessageRoutingError('test');
      expect(err.name).toBe('MessageRoutingError');
    });

    it('should preserve cause', () => {
      const cause = new Error('original');
      const err = new MessageRoutingError('wrapper', cause);
      expect(err.cause).toBe(cause);
    });
  });
});
