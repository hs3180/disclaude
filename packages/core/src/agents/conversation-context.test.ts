/**
 * Unit tests for ConversationContext
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationContext } from './conversation-context.js';
import { createLogger } from '../utils/logger.js';

describe('ConversationContext', () => {
  let ctx: ConversationContext;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger('TestConversationContext');
    ctx = new ConversationContext({ logger });
  });

  describe('constructor', () => {
    it('should create a ConversationContext instance', () => {
      expect(ctx).toBeDefined();
      expect(ctx.size()).toBe(0);
    });
  });

  describe('setThreadRoot', () => {
    it('should set thread root for a chatId', () => {
      ctx.setThreadRoot('chat-1', 'msg-root-1');
      expect(ctx.getThreadRoot('chat-1')).toBe('msg-root-1');
      expect(ctx.size()).toBe(1);
    });

    it('should overwrite existing thread root for same chatId', () => {
      ctx.setThreadRoot('chat-1', 'msg-root-1');
      ctx.setThreadRoot('chat-1', 'msg-root-2');
      expect(ctx.getThreadRoot('chat-1')).toBe('msg-root-2');
      expect(ctx.size()).toBe(1);
    });

    it('should track multiple chatIds independently', () => {
      ctx.setThreadRoot('chat-1', 'msg-root-1');
      ctx.setThreadRoot('chat-2', 'msg-root-2');
      ctx.setThreadRoot('chat-3', 'msg-root-3');
      expect(ctx.size()).toBe(3);
      expect(ctx.getThreadRoot('chat-1')).toBe('msg-root-1');
      expect(ctx.getThreadRoot('chat-2')).toBe('msg-root-2');
      expect(ctx.getThreadRoot('chat-3')).toBe('msg-root-3');
    });
  });

  describe('getThreadRoot', () => {
    it('should return undefined for non-existent chatId', () => {
      expect(ctx.getThreadRoot('non-existent')).toBeUndefined();
    });

    it('should return the correct thread root for existing chatId', () => {
      ctx.setThreadRoot('chat-1', 'msg-123');
      expect(ctx.getThreadRoot('chat-1')).toBe('msg-123');
    });
  });

  describe('deleteThreadRoot', () => {
    it('should return false for non-existent chatId', () => {
      expect(ctx.deleteThreadRoot('non-existent')).toBe(false);
    });

    it('should delete and return true for existing chatId', () => {
      ctx.setThreadRoot('chat-1', 'msg-root');
      expect(ctx.deleteThreadRoot('chat-1')).toBe(true);
      expect(ctx.getThreadRoot('chat-1')).toBeUndefined();
      expect(ctx.size()).toBe(0);
    });

    it('should not affect other chatIds', () => {
      ctx.setThreadRoot('chat-1', 'msg-1');
      ctx.setThreadRoot('chat-2', 'msg-2');
      ctx.deleteThreadRoot('chat-1');
      expect(ctx.getThreadRoot('chat-2')).toBe('msg-2');
      expect(ctx.size()).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('should clear all thread roots', () => {
      ctx.setThreadRoot('chat-1', 'msg-1');
      ctx.setThreadRoot('chat-2', 'msg-2');
      ctx.setThreadRoot('chat-3', 'msg-3');
      expect(ctx.size()).toBe(3);

      ctx.clearAll();
      expect(ctx.size()).toBe(0);
      expect(ctx.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should not throw when called on empty context', () => {
      expect(() => ctx.clearAll()).not.toThrow();
    });
  });

  describe('size', () => {
    it('should return 0 for empty context', () => {
      expect(ctx.size()).toBe(0);
    });

    it('should return correct count after operations', () => {
      ctx.setThreadRoot('chat-1', 'msg-1');
      expect(ctx.size()).toBe(1);

      ctx.setThreadRoot('chat-2', 'msg-2');
      expect(ctx.size()).toBe(2);

      ctx.deleteThreadRoot('chat-1');
      expect(ctx.size()).toBe(1);

      ctx.clearAll();
      expect(ctx.size()).toBe(0);
    });
  });
});
