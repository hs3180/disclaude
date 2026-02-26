import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationContext } from './conversation-context.js';
import type pino from 'pino';

describe('ConversationContext', () => {
  let context: ConversationContext;
  let mockLogger: pino.Logger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as pino.Logger;

    context = new ConversationContext({ logger: mockLogger });
  });

  describe('setThreadRoot', () => {
    it('should set thread root for a chatId', () => {
      context.setThreadRoot('chat1', 'msg123');

      expect(context.getThreadRoot('chat1')).toBe('msg123');
    });

    it('should overwrite existing thread root', () => {
      context.setThreadRoot('chat1', 'msg123');
      context.setThreadRoot('chat1', 'msg456');

      expect(context.getThreadRoot('chat1')).toBe('msg456');
    });

    it('should log thread root set', () => {
      context.setThreadRoot('chat1', 'msg123');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: 'chat1', messageId: 'msg123' },
        'Thread root set'
      );
    });
  });

  describe('getThreadRoot', () => {
    it('should return undefined when no thread root exists', () => {
      expect(context.getThreadRoot('chat1')).toBeUndefined();
    });

    it('should return the thread root when it exists', () => {
      context.setThreadRoot('chat1', 'msg123');
      expect(context.getThreadRoot('chat1')).toBe('msg123');
    });
  });

  describe('deleteThreadRoot', () => {
    it('should return false when no thread root exists', () => {
      expect(context.deleteThreadRoot('chat1')).toBe(false);
    });

    it('should delete thread root and return true', () => {
      context.setThreadRoot('chat1', 'msg123');
      const result = context.deleteThreadRoot('chat1');

      expect(result).toBe(true);
      expect(context.getThreadRoot('chat1')).toBeUndefined();
    });

    it('should log thread root deletion', () => {
      context.setThreadRoot('chat1', 'msg123');
      context.deleteThreadRoot('chat1');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: 'chat1' },
        'Thread root deleted'
      );
    });
  });

  describe('clearAll', () => {
    it('should clear all thread roots', () => {
      context.setThreadRoot('chat1', 'msg123');
      context.setThreadRoot('chat2', 'msg456');

      context.clearAll();

      expect(context.size()).toBe(0);
      expect(context.getThreadRoot('chat1')).toBeUndefined();
      expect(context.getThreadRoot('chat2')).toBeUndefined();
    });

    it('should log clearing', () => {
      context.clearAll();

      expect(mockLogger.debug).toHaveBeenCalledWith('All thread roots cleared');
    });
  });

  describe('size', () => {
    it('should return 0 when no thread roots', () => {
      expect(context.size()).toBe(0);
    });

    it('should return correct count', () => {
      context.setThreadRoot('chat1', 'msg123');
      context.setThreadRoot('chat2', 'msg456');
      expect(context.size()).toBe(2);
    });
  });
});
