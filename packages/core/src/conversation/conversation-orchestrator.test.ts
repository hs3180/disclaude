/**
 * Tests for ConversationOrchestrator.
 *
 * Verifies orchestration of session lifecycle, message processing,
 * thread management, and cleanup operations.
 *
 * Issue #1617: Phase 2 - conversation layer test coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { QueuedMessage, SessionCallbacks } from './types.js';

// Silence logger output during tests
const testLogger = pino({ level: 'silent' });

function createMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    text: 'Hello world',
    messageId: 'msg-1',
    senderOpenId: 'user-1',
    ...overrides,
  };
}

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;

  beforeEach(() => {
    orchestrator = new ConversationOrchestrator({ logger: testLogger });
  });

  describe('constructor', () => {
    it('should create orchestrator with logger', () => {
      expect(orchestrator).toBeInstanceOf(ConversationOrchestrator);
    });

    it('should create orchestrator with callbacks', () => {
      const callbacks: SessionCallbacks = {
        onMessage: vi.fn(),
      };
      const orch = new ConversationOrchestrator({ logger: testLogger, callbacks });
      expect(orch).toBeInstanceOf(ConversationOrchestrator);
    });
  });

  describe('processMessage', () => {
    it('should process message and return success result', () => {
      const result = orchestrator.processMessage('chat-1', createMessage());

      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should create a session when processing first message for a chat', () => {
      expect(orchestrator.hasSession('chat-new')).toBe(false);

      orchestrator.processMessage('chat-new', createMessage());

      expect(orchestrator.hasSession('chat-new')).toBe(true);
    });

    it('should track thread root when processing message', () => {
      orchestrator.processMessage('chat-1', createMessage({ messageId: 'thread-root-1' }));

      expect(orchestrator.getThreadRoot('chat-1')).toBe('thread-root-1');
    });

    it('should increment queue length for multiple messages', () => {
      orchestrator.processMessage('chat-1', createMessage({ messageId: 'msg-1' }));
      const result = orchestrator.processMessage('chat-1', createMessage({ messageId: 'msg-2' }));

      expect(result.queueLength).toBe(2);
    });

    it('should track messages for different chats independently', () => {
      orchestrator.processMessage('chat-1', createMessage({ messageId: 'msg-1' }));
      const result = orchestrator.processMessage('chat-2', createMessage({ messageId: 'msg-2' }));

      expect(result.queueLength).toBe(1);
      expect(orchestrator.getSessionStats('chat-1')?.queueLength).toBe(1);
    });

    it('should return failure when session is closed', () => {
      // Process a message to create the session
      orchestrator.processMessage('chat-1', createMessage());

      // Close the session via the session manager
      orchestrator.getSessionManager().getOrCreate('chat-1');
      const session = orchestrator.getSessionManager().get('chat-1');
      if (session) session.closed = true;

      const result = orchestrator.processMessage('chat-1', createMessage({ messageId: 'msg-2' }));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('closed');
    });

    it('should handle messages without senderOpenId', () => {
      const result = orchestrator.processMessage('chat-1', {
        text: 'Hello',
        messageId: 'msg-1',
      });

      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(1);
    });

    it('should handle messages with attachments', () => {
      const result = orchestrator.processMessage('chat-1', {
        text: 'Check this file',
        messageId: 'msg-1',
        attachments: [{
          id: 'att-1',
          fileName: 'test.png',
          mimeType: 'image/png',
          localPath: '/tmp/test.png',
          source: 'user',
          createdAt: Date.now(),
        }],
      });

      expect(result.success).toBe(true);
    });
  });

  describe('hasSession', () => {
    it('should return false for non-existent session', () => {
      expect(orchestrator.hasSession('nonexistent')).toBe(false);
    });

    it('should return true after processing a message', () => {
      orchestrator.processMessage('chat-1', createMessage());
      expect(orchestrator.hasSession('chat-1')).toBe(true);
    });
  });

  describe('getThreadRoot / setThreadRoot / deleteThreadRoot', () => {
    it('should return undefined for non-existent session', () => {
      expect(orchestrator.getThreadRoot('nonexistent')).toBeUndefined();
    });

    it('should set and get thread root', () => {
      orchestrator.setThreadRoot('chat-1', 'root-1');
      expect(orchestrator.getThreadRoot('chat-1')).toBe('root-1');
    });

    it('should update thread root on subsequent sets', () => {
      orchestrator.setThreadRoot('chat-1', 'root-1');
      orchestrator.setThreadRoot('chat-1', 'root-2');
      expect(orchestrator.getThreadRoot('chat-1')).toBe('root-2');
    });

    it('should delete thread root and return true', () => {
      orchestrator.setThreadRoot('chat-1', 'root-1');
      const deleted = orchestrator.deleteThreadRoot('chat-1');

      expect(deleted).toBe(true);
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should return false when deleting non-existent thread root', () => {
      const deleted = orchestrator.deleteThreadRoot('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('getSessionStats', () => {
    it('should return undefined for non-existent session', () => {
      expect(orchestrator.getSessionStats('nonexistent')).toBeUndefined();
    });

    it('should return stats after processing a message', () => {
      orchestrator.processMessage('chat-1', createMessage());
      const stats = orchestrator.getSessionStats('chat-1');

      expect(stats).toBeDefined();
      expect(stats?.chatId).toBe('chat-1');
      expect(stats?.queueLength).toBe(1);
      expect(stats?.isClosed).toBe(false);
      expect(stats?.started).toBe(false);
      expect(stats?.createdAt).toBeGreaterThan(0);
      expect(stats?.lastActivity).toBeGreaterThan(0);
    });

    it('should include threadRootId when set', () => {
      orchestrator.processMessage('chat-1', createMessage({ messageId: 'thread-root' }));
      const stats = orchestrator.getSessionStats('chat-1');

      expect(stats?.threadRootId).toBe('thread-root');
    });
  });

  describe('getActiveSessionCount / size', () => {
    it('should return 0 for no sessions', () => {
      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.size()).toBe(0);
    });

    it('should return correct count after processing messages', () => {
      orchestrator.processMessage('chat-1', createMessage());
      orchestrator.processMessage('chat-2', createMessage());
      orchestrator.processMessage('chat-3', createMessage());

      expect(orchestrator.getActiveSessionCount()).toBe(3);
      expect(orchestrator.size()).toBe(3);
    });

    it('should decrease count after reset', () => {
      orchestrator.processMessage('chat-1', createMessage());
      orchestrator.processMessage('chat-2', createMessage());
      orchestrator.reset('chat-1');

      expect(orchestrator.getActiveSessionCount()).toBe(1);
    });
  });

  describe('getActiveChatIds', () => {
    it('should return empty array for no sessions', () => {
      expect(orchestrator.getActiveChatIds()).toEqual([]);
    });

    it('should return all active chat IDs', () => {
      orchestrator.processMessage('chat-a', createMessage());
      orchestrator.processMessage('chat-b', createMessage());
      orchestrator.processMessage('chat-c', createMessage());

      const ids = orchestrator.getActiveChatIds();
      expect(ids).toContain('chat-a');
      expect(ids).toContain('chat-b');
      expect(ids).toContain('chat-c');
      expect(ids).toHaveLength(3);
    });
  });

  describe('reset', () => {
    it('should return false for non-existent session', () => {
      expect(orchestrator.reset('nonexistent')).toBe(false);
    });

    it('should return true and remove existing session', () => {
      orchestrator.processMessage('chat-1', createMessage());
      expect(orchestrator.hasSession('chat-1')).toBe(true);

      const result = orchestrator.reset('chat-1');

      expect(result).toBe(true);
      expect(orchestrator.hasSession('chat-1')).toBe(false);
    });

    it('should clear thread roots on reset', () => {
      orchestrator.processMessage('chat-1', createMessage({ messageId: 'thread-root' }));
      orchestrator.reset('chat-1');

      // Re-create session and check thread root is cleared
      orchestrator.processMessage('chat-1', createMessage({ messageId: 'new-root' }));
      // After reset, the thread root should be the new one
      expect(orchestrator.getThreadRoot('chat-1')).toBe('new-root');
    });
  });

  describe('resetAll / clearAll', () => {
    it('should clear all sessions', () => {
      orchestrator.processMessage('chat-1', createMessage());
      orchestrator.processMessage('chat-2', createMessage());
      orchestrator.processMessage('chat-3', createMessage());

      orchestrator.resetAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.hasSession('chat-1')).toBe(false);
    });

    it('clearAll should be an alias for resetAll', () => {
      orchestrator.processMessage('chat-1', createMessage());
      orchestrator.processMessage('chat-2', createMessage());

      orchestrator.clearAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should close all sessions on shutdown', () => {
      orchestrator.processMessage('chat-1', createMessage());
      orchestrator.processMessage('chat-2', createMessage());

      orchestrator.shutdown();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should handle shutdown with no active sessions', () => {
      expect(() => orchestrator.shutdown()).not.toThrow();
    });
  });

  describe('getSessionManager', () => {
    it('should return the underlying session manager', () => {
      const manager = orchestrator.getSessionManager();
      expect(manager).toBeDefined();
      expect(manager).toHaveProperty('has');
      expect(manager).toHaveProperty('get');
      expect(manager).toHaveProperty('delete');
    });

    it('should return the same manager instance', () => {
      const m1 = orchestrator.getSessionManager();
      const m2 = orchestrator.getSessionManager();
      expect(m1).toBe(m2);
    });
  });
});
