/**
 * Unit tests for ConversationOrchestrator
 *
 * Issue #1617 Phase 2: Tests for conversation orchestration layer.
 *
 * Tests cover:
 * - processMessage: message routing, thread tracking, queue management
 * - Session lifecycle: hasSession, reset, resetAll, shutdown
 * - Thread root management: set, get, delete
 * - Session statistics: getSessionStats, getActiveSessionCount, getActiveChatIds
 * - Edge cases: closed session rejection, non-existent session handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { QueuedMessage, SessionCallbacks } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockLogger() {
  return pino({ level: 'silent' }) as unknown as pino.Logger;
}

function makeMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    text: 'hello world',
    messageId: 'msg-1',
    ...overrides,
  };
}

function createMockCallbacks(): SessionCallbacks {
  return {
    onMessage: async () => {},
    onFile: async () => {},
    onDone: async () => {},
    onError: async () => {},
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    orchestrator = new ConversationOrchestrator({
      logger,
      callbacks: createMockCallbacks(),
    });
  });

  describe('constructor', () => {
    it('should create orchestrator with session manager', () => {
      expect(orchestrator).toBeDefined();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should work without callbacks', () => {
      const noCbOrchestrator = new ConversationOrchestrator({ logger });
      expect(noCbOrchestrator).toBeDefined();
    });
  });

  describe('processMessage', () => {
    it('should process message and return success result', () => {
      const result = orchestrator.processMessage('chat-1', makeMessage());

      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should set thread root to message ID', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'thread-root-1' }));

      expect(orchestrator.getThreadRoot('chat-1')).toBe('thread-root-1');
    });

    it('should create session on first message', () => {
      expect(orchestrator.hasSession('chat-new')).toBe(false);

      orchestrator.processMessage('chat-new', makeMessage());

      expect(orchestrator.hasSession('chat-new')).toBe(true);
    });

    it('should queue multiple messages and increment queue length', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-3' }));

      const stats = orchestrator.getSessionStats('chat-1');
      expect(stats?.queueLength).toBe(3);
    });

    it('should return failure when session is closed', () => {
      // First create and close the session
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.reset('chat-1');

      // Now process a message - this creates a new session, so it succeeds
      // To test closed session rejection, we need to close via session manager
      const sessionManager = orchestrator.getSessionManager();
      orchestrator.processMessage('chat-closed', makeMessage({ messageId: 'msg-1' }));
      // Get the session and close it directly
      const session = sessionManager.get('chat-closed');
      if (session) {
        session.closed = true;
        const result = orchestrator.processMessage('chat-closed', makeMessage({ messageId: 'msg-2' }));
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error?.message).toBe('Session is closed');
      }
    });

    it('should update thread root with latest message ID', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      expect(orchestrator.getThreadRoot('chat-1')).toBe('msg-1');

      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      expect(orchestrator.getThreadRoot('chat-1')).toBe('msg-2');
    });

    it('should handle messages for independent chats', () => {
      orchestrator.processMessage('chat-a', makeMessage({ messageId: 'msg-a1' }));
      orchestrator.processMessage('chat-b', makeMessage({ messageId: 'msg-b1' }));

      expect(orchestrator.getThreadRoot('chat-a')).toBe('msg-a1');
      expect(orchestrator.getThreadRoot('chat-b')).toBe('msg-b1');
      expect(orchestrator.getSessionStats('chat-a')?.queueLength).toBe(1);
      expect(orchestrator.getSessionStats('chat-b')?.queueLength).toBe(1);
    });
  });

  describe('session lifecycle', () => {
    it('hasSession should return false for unknown chatId', () => {
      expect(orchestrator.hasSession('unknown')).toBe(false);
    });

    it('hasSession should return true after message processing', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      expect(orchestrator.hasSession('chat-1')).toBe(true);
    });

    it('reset should clear session and return true', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      expect(orchestrator.hasSession('chat-1')).toBe(true);

      const result = orchestrator.reset('chat-1');
      expect(result).toBe(true);
      expect(orchestrator.hasSession('chat-1')).toBe(false);
    });

    it('reset should return false for non-existent session', () => {
      expect(orchestrator.reset('unknown')).toBe(false);
    });

    it('reset should clear thread root and queued messages', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-3' }));

      orchestrator.reset('chat-1');

      // After reset, a new message should start fresh
      const result = orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-new' }));
      expect(result.queueLength).toBe(1);
      expect(orchestrator.getThreadRoot('chat-1')).toBe('msg-new');
    });

    it('resetAll should clear all sessions', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());
      orchestrator.processMessage('chat-3', makeMessage());

      orchestrator.resetAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.hasSession('chat-1')).toBe(false);
      expect(orchestrator.hasSession('chat-2')).toBe(false);
      expect(orchestrator.hasSession('chat-3')).toBe(false);
    });

    it('clearAll should be an alias for resetAll', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.clearAll();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('shutdown should close all sessions', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());

      orchestrator.shutdown();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('thread root management', () => {
    it('getThreadRoot should return undefined for unknown chat', () => {
      expect(orchestrator.getThreadRoot('unknown')).toBeUndefined();
    });

    it('setThreadRoot should set and return value', () => {
      orchestrator.setThreadRoot('chat-1', 'root-123');
      expect(orchestrator.getThreadRoot('chat-1')).toBe('root-123');
    });

    it('deleteThreadRoot should return true when root exists', () => {
      orchestrator.setThreadRoot('chat-1', 'root-123');
      const result = orchestrator.deleteThreadRoot('chat-1');
      expect(result).toBe(true);
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('deleteThreadRoot should return false when no root exists', () => {
      expect(orchestrator.deleteThreadRoot('unknown')).toBe(false);
    });

    it('setThreadRoot should create session if not exists', () => {
      orchestrator.setThreadRoot('chat-new', 'root-456');
      expect(orchestrator.hasSession('chat-new')).toBe(true);
      expect(orchestrator.getThreadRoot('chat-new')).toBe('root-456');
    });
  });

  describe('session statistics', () => {
    it('getSessionStats should return undefined for unknown chat', () => {
      expect(orchestrator.getSessionStats('unknown')).toBeUndefined();
    });

    it('getSessionStats should return correct stats after messages', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      orchestrator.setThreadRoot('chat-1', 'thread-123');

      const stats = orchestrator.getSessionStats('chat-1');
      expect(stats).toBeDefined();
      expect(stats!.chatId).toBe('chat-1');
      expect(stats!.queueLength).toBe(2);
      expect(stats!.isClosed).toBe(false);
      expect(stats!.threadRootId).toBe('thread-123');
      expect(stats!.createdAt).toBeGreaterThan(0);
      expect(stats!.lastActivity).toBeGreaterThan(0);
    });

    it('getActiveSessionCount should return 0 initially', () => {
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('getActiveSessionCount should count sessions correctly', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());
      orchestrator.processMessage('chat-3', makeMessage());

      expect(orchestrator.getActiveSessionCount()).toBe(3);
    });

    it('size should be an alias for getActiveSessionCount', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      expect(orchestrator.size()).toBe(orchestrator.getActiveSessionCount());
    });

    it('getActiveChatIds should return all active chat IDs', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());

      const ids = orchestrator.getActiveChatIds();
      expect(ids).toContain('chat-1');
      expect(ids).toContain('chat-2');
      expect(ids).toHaveLength(2);
    });

    it('getActiveChatIds should return empty array when no sessions', () => {
      expect(orchestrator.getActiveChatIds()).toEqual([]);
    });
  });

  describe('getSessionManager', () => {
    it('should return the underlying session manager', () => {
      const manager = orchestrator.getSessionManager();
      expect(manager).toBeDefined();
    });

    it('should allow direct session manipulation through manager', () => {
      orchestrator.processMessage('chat-1', makeMessage());

      const manager = orchestrator.getSessionManager();
      expect(manager.has('chat-1')).toBe(true);
      expect(manager.size()).toBe(1);
    });
  });
});
