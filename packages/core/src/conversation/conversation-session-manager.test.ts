/**
 * Tests for ConversationSessionManager (packages/core/src/conversation/conversation-session-manager.ts)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationSessionManager } from './conversation-session-manager.js';
import type { QueuedMessage } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock logger. */
function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info' as const,
    get msgPrefix() { return ''; },
  };
}

/** Create a basic QueuedMessage. */
function makeMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    text: 'hello',
    messageId: 'msg-1',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationSessionManager', () => {
  let manager: ConversationSessionManager;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    manager = new ConversationSessionManager({ logger: logger as any });
  });

  describe('has', () => {
    it('should return false for unknown chatId', () => {
      expect(manager.has('unknown')).toBe(false);
    });

    it('should return true after session creation', () => {
      manager.getOrCreate('chat-1');
      expect(manager.has('chat-1')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined for unknown chatId', () => {
      expect(manager.get('unknown')).toBeUndefined();
    });

    it('should return session after creation', () => {
      const session = manager.getOrCreate('chat-1');
      expect(manager.get('chat-1')).toBe(session);
    });
  });

  describe('getOrCreate', () => {
    it('should create a new session with default state', () => {
      const session = manager.getOrCreate('chat-1');
      expect(session.closed).toBe(false);
      expect(session.started).toBe(false);
      expect(session.messageQueue).toEqual([]);
      expect(session.lastActivity).toBeGreaterThan(0);
    });

    it('should return existing session on subsequent calls', () => {
      const session1 = manager.getOrCreate('chat-1');
      const session2 = manager.getOrCreate('chat-1');
      expect(session1).toBe(session2);
    });

    it('should create independent sessions for different chatIds', () => {
      const session1 = manager.getOrCreate('chat-1');
      const session2 = manager.getOrCreate('chat-2');
      expect(session1).not.toBe(session2);
    });
  });

  describe('setThreadRoot / getThreadRoot / deleteThreadRoot', () => {
    it('should set and get thread root', () => {
      manager.setThreadRoot('chat-1', 'thread-msg-123');
      expect(manager.getThreadRoot('chat-1')).toBe('thread-msg-123');
    });

    it('should return undefined for thread root when not set', () => {
      expect(manager.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should delete thread root and return true', () => {
      manager.setThreadRoot('chat-1', 'thread-msg-123');
      const result = manager.deleteThreadRoot('chat-1');
      expect(result).toBe(true);
      expect(manager.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should return false when deleting non-existent thread root', () => {
      expect(manager.deleteThreadRoot('chat-1')).toBe(false);
    });

    it('should return false for unknown chat when deleting thread root', () => {
      expect(manager.deleteThreadRoot('unknown')).toBe(false);
    });

    it('should create session if not exists when setting thread root', () => {
      manager.setThreadRoot('chat-new', 'thread-123');
      expect(manager.has('chat-new')).toBe(true);
      expect(manager.getThreadRoot('chat-new')).toBe('thread-123');
    });
  });

  describe('queueMessage', () => {
    it('should queue a message and return true', () => {
      const result = manager.queueMessage('chat-1', makeMessage());
      expect(result).toBe(true);
      const session = manager.get('chat-1')!;
      expect(session.messageQueue).toHaveLength(1);
      expect(session.messageQueue[0].text).toBe('hello');
    });

    it('should create session if not exists', () => {
      manager.queueMessage('chat-new', makeMessage({ text: 'new chat' }));
      expect(manager.has('chat-new')).toBe(true);
    });

    it('should return false for closed session', () => {
      const session = manager.getOrCreate('chat-1');
      session.closed = true;
      const result = manager.queueMessage('chat-1', makeMessage());
      expect(result).toBe(false);
      expect(session.messageQueue).toHaveLength(0);
    });

    it('should trigger messageResolver if set', () => {
      const resolver = vi.fn();
      const session = manager.getOrCreate('chat-1');
      session.messageResolver = resolver;
      manager.queueMessage('chat-1', makeMessage());
      expect(resolver).toHaveBeenCalled();
      // Resolver should be cleared after triggering
      expect(session.messageResolver).toBeUndefined();
    });

    it('should queue multiple messages', () => {
      manager.queueMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      manager.queueMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      manager.queueMessage('chat-1', makeMessage({ messageId: 'msg-3' }));
      expect(manager.get('chat-1')!.messageQueue).toHaveLength(3);
    });
  });

  describe('markStarted', () => {
    it('should set started to true', () => {
      manager.getOrCreate('chat-1');
      manager.markStarted('chat-1');
      expect(manager.get('chat-1')!.started).toBe(true);
    });

    it('should update lastActivity', () => {
      const session = manager.getOrCreate('chat-1');
      const before = session.lastActivity;
      // Advance time slightly
      vi.spyOn(Date, 'now').mockReturnValue(before + 100);
      manager.markStarted('chat-1');
      expect(manager.get('chat-1')!.lastActivity).toBe(before + 100);
      vi.restoreAllMocks();
    });

    it('should not throw for non-existent session', () => {
      expect(() => manager.markStarted('unknown')).not.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete existing session and return true', () => {
      manager.getOrCreate('chat-1');
      expect(manager.delete('chat-1')).toBe(true);
      expect(manager.has('chat-1')).toBe(false);
    });

    it('should return false for non-existent session', () => {
      expect(manager.delete('unknown')).toBe(false);
    });

    it('should resolve pending resolver on delete', () => {
      const resolver = vi.fn();
      const session = manager.getOrCreate('chat-1');
      session.messageResolver = resolver;
      manager.delete('chat-1');
      expect(resolver).toHaveBeenCalled();
    });

    it('should mark session as closed before deleting', () => {
      manager.getOrCreate('chat-1');
      // We can't directly observe the closed state since it's deleted,
      // but we can verify the session was removed
      manager.delete('chat-1');
      expect(manager.has('chat-1')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return undefined for non-existent session', () => {
      expect(manager.getStats('unknown')).toBeUndefined();
    });

    it('should return correct stats for a session', () => {
      manager.getOrCreate('chat-1');
      manager.queueMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      manager.queueMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      manager.setThreadRoot('chat-1', 'thread-123');
      manager.markStarted('chat-1');

      const stats = manager.getStats('chat-1');
      expect(stats).toBeDefined();
      expect(stats!.chatId).toBe('chat-1');
      expect(stats!.queueLength).toBe(2);
      expect(stats!.isClosed).toBe(false);
      expect(stats!.started).toBe(true);
      expect(stats!.threadRootId).toBe('thread-123');
      expect(stats!.createdAt).toBeGreaterThan(0);
      expect(stats!.lastActivity).toBeGreaterThan(0);
    });
  });

  describe('size', () => {
    it('should return 0 initially', () => {
      expect(manager.size()).toBe(0);
    });

    it('should return correct count', () => {
      manager.getOrCreate('chat-1');
      manager.getOrCreate('chat-2');
      manager.getOrCreate('chat-3');
      expect(manager.size()).toBe(3);
    });
  });

  describe('getActiveChatIds', () => {
    it('should return empty array initially', () => {
      expect(manager.getActiveChatIds()).toEqual([]);
    });

    it('should return all chat IDs', () => {
      manager.getOrCreate('chat-1');
      manager.getOrCreate('chat-2');
      const ids = manager.getActiveChatIds();
      expect(ids).toContain('chat-1');
      expect(ids).toContain('chat-2');
      expect(ids).toHaveLength(2);
    });
  });

  describe('closeAll', () => {
    it('should close all sessions', () => {
      manager.getOrCreate('chat-1');
      manager.getOrCreate('chat-2');
      manager.closeAll();
      expect(manager.size()).toBe(0);
    });

    it('should resolve pending resolvers for all sessions', () => {
      const resolver1 = vi.fn();
      const resolver2 = vi.fn();
      manager.getOrCreate('chat-1').messageResolver = resolver1;
      manager.getOrCreate('chat-2').messageResolver = resolver2;
      manager.closeAll();
      expect(resolver1).toHaveBeenCalled();
      expect(resolver2).toHaveBeenCalled();
    });
  });
});
