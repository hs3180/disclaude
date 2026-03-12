/**
 * Tests for InteractionManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InteractionManager } from './interaction-manager.js';
import type { FeishuCardActionEvent } from '@disclaude/core';

describe('InteractionManager', () => {
  let manager: InteractionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new InteractionManager({ cleanupInterval: 1000 });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('register', () => {
    it('should register an interaction context', () => {
      const context = manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: ['confirm', 'cancel'],
      });

      expect(context.id).toBe('test-1');
      expect(context.chatId).toBe('chat-1');
      expect(context.messageId).toBe('msg-1');
      expect(context.expectedActions).toEqual(['confirm', 'cancel']);
      expect(context.createdAt).toBeGreaterThan(0);
      expect(context.expiresAt).toBeGreaterThan(context.createdAt);
    });

    it('should use custom timeout', () => {
      const customManager = new InteractionManager({ defaultTimeout: 10000 });
      const context = customManager.register({
        id: 'test-2',
        chatId: 'chat-1',
        messageId: 'msg-2',
        expectedActions: [],
      });

      expect(context.expiresAt - context.createdAt).toBe(10000);
      customManager.dispose();
    });
  });

  describe('unregister', () => {
    it('should unregister an interaction', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
      });

      const result = manager.unregister('test-1');
      expect(result).toBe(true);
      expect(manager.get('test-1')).toBeUndefined();
    });

    it('should return false for non-existent interaction', () => {
      const result = manager.unregister('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('get', () => {
    it('should return registered interaction', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
      });

      const context = manager.get('test-1');
      expect(context).toBeDefined();
      expect(context?.id).toBe('test-1');
    });

    it('should return undefined for non-existent interaction', () => {
      const context = manager.get('non-existent');
      expect(context).toBeUndefined();
    });
  });

  describe('findByMessageId', () => {
    it('should find interaction by message ID', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
      });

      const context = manager.findByMessageId('msg-1');
      expect(context).toBeDefined();
      expect(context?.id).toBe('test-1');
    });

    it('should return undefined if not found', () => {
      const context = manager.findByMessageId('non-existent');
      expect(context).toBeUndefined();
    });
  });

  describe('findByChatId', () => {
    it('should find all interactions for a chat', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
      });
      manager.register({
        id: 'test-2',
        chatId: 'chat-1',
        messageId: 'msg-2',
        expectedActions: [],
      });
      manager.register({
        id: 'test-3',
        chatId: 'chat-2',
        messageId: 'msg-3',
        expectedActions: [],
      });

      const contexts = manager.findByChatId('chat-1');
      expect(contexts).toHaveLength(2);
      expect(contexts.map((c) => c.id)).toContain('test-1');
      expect(contexts.map((c) => c.id)).toContain('test-2');
    });

    it('should return empty array if no interactions found', () => {
      const contexts = manager.findByChatId('non-existent');
      expect(contexts).toHaveLength(0);
    });
  });

  describe('handleAction', () => {
    it('should call registered handler for matching action', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: ['confirm', 'cancel'],
        handler,
      });

      const event: FeishuCardActionEvent = {
        action: { type: 'button', value: 'confirm', trigger: 'button' },
        message_id: 'msg-1',
        chat_id: 'chat-1',
        user: { sender_id: { open_id: 'user-1' } },
      };

      const result = await manager.handleAction(event);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should reject unexpected action key', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: ['confirm', 'cancel'],
        handler,
      });

      const event: FeishuCardActionEvent = {
        action: { type: 'button', value: 'unknown', trigger: 'button' },
        message_id: 'msg-1',
        chat_id: 'chat-1',
        user: { sender_id: { open_id: 'user-1' } },
      };

      const result = await manager.handleAction(event);
      expect(result).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should accept any action when expectedActions is empty', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
        handler,
      });

      const event: FeishuCardActionEvent = {
        action: { type: 'button', value: 'any-action', trigger: 'button' },
        message_id: 'msg-1',
        chat_id: 'chat-1',
        user: { sender_id: { open_id: 'user-1' } },
      };

      const result = await manager.handleAction(event);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should use default handler when no registered handler found', async () => {
      const defaultHandler = vi.fn().mockResolvedValue(undefined);

      const event: FeishuCardActionEvent = {
        action: { type: 'button', value: 'confirm', trigger: 'button' },
        message_id: 'msg-1',
        chat_id: 'chat-1',
        user: { sender_id: { open_id: 'user-1' } },
      };

      const result = await manager.handleAction(event, defaultHandler);
      expect(result).toBe(true);
      expect(defaultHandler).toHaveBeenCalledWith(event);
    });

    it('should return false when no handler found and no default', async () => {
      const event: FeishuCardActionEvent = {
        action: { type: 'button', value: 'confirm', trigger: 'button' },
        message_id: 'msg-1',
        chat_id: 'chat-1',
        user: { sender_id: { open_id: 'user-1' } },
      };

      const result = await manager.handleAction(event);
      expect(result).toBe(false);
    });

    it('should reject expired interactions', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: ['confirm'],
        handler,
        expiresAt: Date.now() - 1000, // Already expired
      });

      const event: FeishuCardActionEvent = {
        action: { type: 'button', value: 'confirm', trigger: 'button' },
        message_id: 'msg-1',
        chat_id: 'chat-1',
        user: { sender_id: { open_id: 'user-1' } },
      };

      const result = await manager.handleAction(event);
      expect(result).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update existing interaction', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: ['confirm'],
      });

      const updated = manager.update('test-1', {
        expectedActions: ['confirm', 'cancel', 'retry'],
      });

      expect(updated?.expectedActions).toEqual(['confirm', 'cancel', 'retry']);
    });

    it('should return undefined for non-existent interaction', () => {
      const updated = manager.update('non-existent', { expectedActions: [] });
      expect(updated).toBeUndefined();
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired interactions', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
        expiresAt: Date.now() - 1000, // Expired
      });

      manager.register({
        id: 'test-2',
        chatId: 'chat-1',
        messageId: 'msg-2',
        expectedActions: [],
        expiresAt: Date.now() + 10000, // Not expired
      });

      expect(manager.count).toBe(2);

      manager.cleanupExpired();

      expect(manager.count).toBe(1);
      expect(manager.get('test-1')).toBeUndefined();
      expect(manager.get('test-2')).toBeDefined();
    });
  });

  describe('getAll', () => {
    it('should return all interactions', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
      });
      manager.register({
        id: 'test-2',
        chatId: 'chat-1',
        messageId: 'msg-2',
        expectedActions: [],
      });

      const all = manager.getAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('count', () => {
    it('should return correct count', () => {
      expect(manager.count).toBe(0);

      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
      });
      expect(manager.count).toBe(1);

      manager.register({
        id: 'test-2',
        chatId: 'chat-1',
        messageId: 'msg-2',
        expectedActions: [],
      });
      expect(manager.count).toBe(2);

      manager.unregister('test-1');
      expect(manager.count).toBe(1);
    });
  });

  describe('dispose', () => {
    it('should clear all interactions and cleanup timer', () => {
      manager.register({
        id: 'test-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        expectedActions: [],
      });

      manager.dispose();
      expect(manager.count).toBe(0);
    });
  });
});
