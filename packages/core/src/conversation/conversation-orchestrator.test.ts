/**
 * Tests for ConversationOrchestrator (packages/core/src/conversation/conversation-orchestrator.ts)
 *
 * Issue #1617 Phase 2: Tests for the high-level conversation coordination layer.
 * Covers session management, message processing, thread tracking, and lifecycle operations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    onMessage: vi.fn().mockResolvedValue(undefined),
    onFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn().mockResolvedValue(undefined),
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
    orchestrator = new ConversationOrchestrator({ logger });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('should create an orchestrator without callbacks', () => {
      expect(orchestrator).toBeDefined();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should create an orchestrator with callbacks', () => {
      const callbacks = createMockCallbacks();
      const orch = new ConversationOrchestrator({ logger, callbacks });
      expect(orch).toBeDefined();
    });

    it('should expose the underlying session manager', () => {
      const sm = orchestrator.getSessionManager();
      expect(sm).toBeDefined();
      expect(sm.size()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // processMessage
  // -------------------------------------------------------------------------
  describe('processMessage', () => {
    it('should successfully queue a message and return success result', () => {
      const result = orchestrator.processMessage('chat-1', makeMessage());
      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should increment queue length for each message', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-3' }));

      const result = orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-4' }));
      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(4);
    });

    it('should track the first message as thread root', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'thread-root-msg' }));
      expect(orchestrator.getThreadRoot('chat-1')).toBe('thread-root-msg');
    });

    it('should update thread root on each message', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      expect(orchestrator.getThreadRoot('chat-1')).toBe('msg-1');

      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      expect(orchestrator.getThreadRoot('chat-1')).toBe('msg-2');
    });

    it('should handle messages for different chat IDs independently', () => {
      const r1 = orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-a' }));
      const r2 = orchestrator.processMessage('chat-2', makeMessage({ messageId: 'msg-b' }));

      expect(r1.success).toBe(true);
      expect(r1.queueLength).toBe(1);
      expect(r2.success).toBe(true);
      expect(r2.queueLength).toBe(1);
    });

    it('should return failure when session is closed', () => {
      // Create a session by processing a message
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));

      // Close the session via the session manager (without deleting it)
      const sm = orchestrator.getSessionManager();
      const session = sm.get('chat-1')!;
      session.closed = true;

      // Now processMessage will setThreadRoot (updating existing session)
      // but queueMessage will fail because session is closed
      const result = orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-after-close' }));
      expect(result.success).toBe(false);
      // queueLength reflects the existing queue (1 from first message)
      expect(result.queueLength).toBe(1);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toBe('Session is closed');
    });

    it('should auto-create session when processing message for new chat', () => {
      orchestrator.processMessage('chat-new', makeMessage());
      expect(orchestrator.hasSession('chat-new')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // hasSession
  // -------------------------------------------------------------------------
  describe('hasSession', () => {
    it('should return false for unknown chatId', () => {
      expect(orchestrator.hasSession('unknown')).toBe(false);
    });

    it('should return true after processing a message', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      expect(orchestrator.hasSession('chat-1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Thread root management
  // -------------------------------------------------------------------------
  describe('getThreadRoot / setThreadRoot / deleteThreadRoot', () => {
    it('should set and get thread root', () => {
      orchestrator.setThreadRoot('chat-1', 'root-123');
      expect(orchestrator.getThreadRoot('chat-1')).toBe('root-123');
    });

    it('should return undefined for unset thread root', () => {
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should delete thread root and return true', () => {
      orchestrator.setThreadRoot('chat-1', 'root-123');
      expect(orchestrator.deleteThreadRoot('chat-1')).toBe(true);
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should return false when deleting non-existent thread root', () => {
      expect(orchestrator.deleteThreadRoot('chat-1')).toBe(false);
    });

    it('should return false when deleting thread root for unknown chat', () => {
      expect(orchestrator.deleteThreadRoot('unknown-chat')).toBe(false);
    });

    it('should auto-create session when setting thread root for new chat', () => {
      orchestrator.setThreadRoot('chat-new', 'root-abc');
      expect(orchestrator.hasSession('chat-new')).toBe(true);
    });

    it('should update thread root on subsequent setThreadRoot calls', () => {
      orchestrator.setThreadRoot('chat-1', 'root-1');
      orchestrator.setThreadRoot('chat-1', 'root-2');
      expect(orchestrator.getThreadRoot('chat-1')).toBe('root-2');
    });
  });

  // -------------------------------------------------------------------------
  // getSessionStats
  // -------------------------------------------------------------------------
  describe('getSessionStats', () => {
    it('should return undefined for non-existent session', () => {
      expect(orchestrator.getSessionStats('unknown')).toBeUndefined();
    });

    it('should return correct stats after processing messages', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));
      orchestrator.setThreadRoot('chat-1', 'thread-root');

      const stats = orchestrator.getSessionStats('chat-1');
      expect(stats).toBeDefined();
      expect(stats!.chatId).toBe('chat-1');
      expect(stats!.queueLength).toBe(2);
      expect(stats!.isClosed).toBe(false);
      expect(stats!.threadRootId).toBe('thread-root');
      expect(stats!.createdAt).toBeGreaterThan(0);
      expect(stats!.lastActivity).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // getActiveSessionCount / size
  // -------------------------------------------------------------------------
  describe('getActiveSessionCount / size', () => {
    it('should return 0 initially', () => {
      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.size()).toBe(0);
    });

    it('should count sessions created by message processing', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());
      orchestrator.processMessage('chat-3', makeMessage());

      expect(orchestrator.getActiveSessionCount()).toBe(3);
      expect(orchestrator.size()).toBe(3);
    });

    it('size should be an alias for getActiveSessionCount', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      expect(orchestrator.size()).toBe(orchestrator.getActiveSessionCount());
    });
  });

  // -------------------------------------------------------------------------
  // getActiveChatIds
  // -------------------------------------------------------------------------
  describe('getActiveChatIds', () => {
    it('should return empty array initially', () => {
      expect(orchestrator.getActiveChatIds()).toEqual([]);
    });

    it('should return all active chat IDs', () => {
      orchestrator.processMessage('chat-a', makeMessage());
      orchestrator.processMessage('chat-b', makeMessage());
      orchestrator.processMessage('chat-c', makeMessage());

      const ids = orchestrator.getActiveChatIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('chat-a');
      expect(ids).toContain('chat-b');
      expect(ids).toContain('chat-c');
    });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------
  describe('reset', () => {
    it('should reset an existing session and return true', () => {
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-1', makeMessage({ messageId: 'msg-2' }));

      expect(orchestrator.reset('chat-1')).toBe(true);
      expect(orchestrator.hasSession('chat-1')).toBe(false);
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should return false for non-existent session', () => {
      expect(orchestrator.reset('unknown')).toBe(false);
    });

    it('should not affect other sessions', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());

      orchestrator.reset('chat-1');
      expect(orchestrator.hasSession('chat-1')).toBe(false);
      expect(orchestrator.hasSession('chat-2')).toBe(true);
      expect(orchestrator.getActiveSessionCount()).toBe(1);
    });

    it('should clear thread roots on reset', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.setThreadRoot('chat-1', 'thread-123');
      orchestrator.reset('chat-1');

      // After reset, thread root should be gone since the session is deleted
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // resetAll / clearAll
  // -------------------------------------------------------------------------
  describe('resetAll / clearAll', () => {
    it('should reset all sessions', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());
      orchestrator.processMessage('chat-3', makeMessage());

      orchestrator.resetAll();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.getActiveChatIds()).toEqual([]);
    });

    it('clearAll should be an alias for resetAll', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.clearAll();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should handle empty state gracefully', () => {
      expect(() => orchestrator.resetAll()).not.toThrow();
      expect(() => orchestrator.clearAll()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------
  describe('shutdown', () => {
    it('should close all sessions on shutdown', () => {
      orchestrator.processMessage('chat-1', makeMessage());
      orchestrator.processMessage('chat-2', makeMessage());

      orchestrator.shutdown();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should handle shutdown with no active sessions', () => {
      expect(() => orchestrator.shutdown()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Integration: processMessage + reset lifecycle
  // -------------------------------------------------------------------------
  describe('lifecycle integration', () => {
    it('should support full lifecycle: create, process, reset, recreate', () => {
      // Create session
      const r1 = orchestrator.processMessage('chat-1', makeMessage({ messageId: 'm1' }));
      expect(r1.success).toBe(true);

      // Add more messages
      const r2 = orchestrator.processMessage('chat-1', makeMessage({ messageId: 'm2' }));
      expect(r2.queueLength).toBe(2);

      // Verify stats
      const stats = orchestrator.getSessionStats('chat-1');
      expect(stats!.queueLength).toBe(2);

      // Reset
      orchestrator.reset('chat-1');
      expect(orchestrator.hasSession('chat-1')).toBe(false);

      // Recreate
      const r3 = orchestrator.processMessage('chat-1', makeMessage({ messageId: 'm3' }));
      expect(r3.success).toBe(true);
      expect(r3.queueLength).toBe(1);

      // Shutdown
      orchestrator.shutdown();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should handle concurrent sessions independently', () => {
      // Process messages for multiple chats
      for (let i = 0; i < 5; i++) {
        orchestrator.processMessage(`chat-${i}`, makeMessage({ messageId: `msg-${i}` }));
      }

      expect(orchestrator.getActiveSessionCount()).toBe(5);

      // Reset one
      orchestrator.reset('chat-2');
      expect(orchestrator.getActiveSessionCount()).toBe(4);

      // Reset all
      orchestrator.resetAll();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });
});
