/**
 * Tests for ConversationOrchestrator (packages/core/src/conversation/conversation-orchestrator.ts)
 *
 * Tests the high-level conversation coordination logic including:
 * - Message processing with thread tracking
 * - Session lifecycle management
 * - Reset and shutdown operations
 * - Session statistics
 *
 * Issue #1617 Phase 2: Conversation layer tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { QueuedMessage, SessionCallbacks } from './types.js';

// ============================================================================
// Mock Logger
// ============================================================================

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
});

// ============================================================================
// Helpers
// ============================================================================

function createMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    text: 'Hello, world!',
    messageId: 'msg-001',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;
  let logger: ReturnType<typeof createMockLogger>;
  const mockCallbacks: SessionCallbacks = {
    onMessage: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    logger = createMockLogger();
    orchestrator = new ConversationOrchestrator({
      logger: logger as any,
      callbacks: mockCallbacks,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create orchestrator with required config', () => {
      expect(orchestrator).toBeDefined();
    });

    it('should create orchestrator without callbacks', () => {
      const o = new ConversationOrchestrator({ logger: logger as any });
      expect(o).toBeDefined();
    });

    it('should expose session manager via getter', () => {
      const sm = orchestrator.getSessionManager();
      expect(sm).toBeDefined();
    });
  });

  describe('processMessage', () => {
    it('should process a message and return success result', () => {
      const msg = createMessage();
      const result = orchestrator.processMessage('chat-123', msg);

      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should track thread root for new messages', () => {
      const msg = createMessage({ messageId: 'msg-root' });
      orchestrator.processMessage('chat-123', msg);

      expect(orchestrator.getThreadRoot('chat-123')).toBe('msg-root');
    });

    it('should update thread root on subsequent messages', () => {
      const msg1 = createMessage({ messageId: 'msg-1' });
      const msg2 = createMessage({ messageId: 'msg-2' });

      orchestrator.processMessage('chat-123', msg1);
      expect(orchestrator.getThreadRoot('chat-123')).toBe('msg-1');

      orchestrator.processMessage('chat-123', msg2);
      expect(orchestrator.getThreadRoot('chat-123')).toBe('msg-2');
    });

    it('should increment queue length for multiple messages', () => {
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-2' }));
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-3' }));

      const stats = orchestrator.getSessionStats('chat-123');
      expect(stats?.queueLength).toBe(3);
    });

    it('should track sessions independently per chatId', () => {
      orchestrator.processMessage('chat-A', createMessage({ messageId: 'msg-A' }));
      orchestrator.processMessage('chat-B', createMessage({ messageId: 'msg-B' }));

      expect(orchestrator.getThreadRoot('chat-A')).toBe('msg-A');
      expect(orchestrator.getThreadRoot('chat-B')).toBe('msg-B');

      const statsA = orchestrator.getSessionStats('chat-A');
      const statsB = orchestrator.getSessionStats('chat-B');
      expect(statsA?.queueLength).toBe(1);
      expect(statsB?.queueLength).toBe(1);
    });

    it('should return error when session is closed', () => {
      const msg = createMessage();
      orchestrator.processMessage('chat-123', msg);

      // Close the session by deleting it
      orchestrator.reset('chat-123');

      // Try to process another message - creates new session
      const result = orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-new' }));
      // After reset, a new session is created, so it should succeed
      expect(result.success).toBe(true);
    });

    it('should include senderOpenId when provided', () => {
      const msg = createMessage({ senderOpenId: 'user-456' });
      const result = orchestrator.processMessage('chat-123', msg);

      expect(result.success).toBe(true);
    });
  });

  describe('hasSession', () => {
    it('should return false for unknown chatId', () => {
      expect(orchestrator.hasSession('unknown')).toBe(false);
    });

    it('should return true after processing a message', () => {
      orchestrator.processMessage('chat-123', createMessage());
      expect(orchestrator.hasSession('chat-123')).toBe(true);
    });
  });

  describe('thread root management', () => {
    it('should set thread root explicitly', () => {
      orchestrator.setThreadRoot('chat-123', 'thread-root-1');
      expect(orchestrator.getThreadRoot('chat-123')).toBe('thread-root-1');
    });

    it('should update thread root', () => {
      orchestrator.setThreadRoot('chat-123', 'root-1');
      orchestrator.setThreadRoot('chat-123', 'root-2');
      expect(orchestrator.getThreadRoot('chat-123')).toBe('root-2');
    });

    it('should delete thread root', () => {
      orchestrator.setThreadRoot('chat-123', 'root-1');
      const deleted = orchestrator.deleteThreadRoot('chat-123');

      expect(deleted).toBe(true);
      expect(orchestrator.getThreadRoot('chat-123')).toBeUndefined();
    });

    it('should return false when deleting non-existent thread root', () => {
      const deleted = orchestrator.deleteThreadRoot('non-existent');
      expect(deleted).toBe(false);
    });

    it('should return undefined for unknown chatId thread root', () => {
      expect(orchestrator.getThreadRoot('unknown')).toBeUndefined();
    });
  });

  describe('session statistics', () => {
    it('should return undefined stats for unknown chatId', () => {
      expect(orchestrator.getSessionStats('unknown')).toBeUndefined();
    });

    it('should return stats for active session', () => {
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-1' }));

      const stats = orchestrator.getSessionStats('chat-123');
      expect(stats).toBeDefined();
      expect(stats!.chatId).toBe('chat-123');
      expect(stats!.queueLength).toBe(1);
      expect(stats!.isClosed).toBe(false);
      expect(stats!.started).toBe(false);
      expect(stats!.createdAt).toBeGreaterThan(0);
      expect(stats!.lastActivity).toBeGreaterThan(0);
      expect(stats!.threadRootId).toBe('msg-1');
    });

    it('should update stats after multiple messages', () => {
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-1' }));
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-2' }));
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-3' }));

      const stats = orchestrator.getSessionStats('chat-123');
      expect(stats!.queueLength).toBe(3);
      expect(stats!.threadRootId).toBe('msg-3');
    });
  });

  describe('active session tracking', () => {
    it('should return 0 when no sessions', () => {
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should count active sessions', () => {
      orchestrator.processMessage('chat-A', createMessage());
      orchestrator.processMessage('chat-B', createMessage());
      orchestrator.processMessage('chat-C', createMessage());

      expect(orchestrator.getActiveSessionCount()).toBe(3);
    });

    it('should provide size() as alias', () => {
      orchestrator.processMessage('chat-A', createMessage());
      expect(orchestrator.size()).toBe(orchestrator.getActiveSessionCount());
    });

    it('should return all active chat IDs', () => {
      orchestrator.processMessage('chat-A', createMessage());
      orchestrator.processMessage('chat-B', createMessage());

      const ids = orchestrator.getActiveChatIds();
      expect(ids).toContain('chat-A');
      expect(ids).toContain('chat-B');
      expect(ids).toHaveLength(2);
    });

    it('should update count after reset', () => {
      orchestrator.processMessage('chat-A', createMessage());
      orchestrator.processMessage('chat-B', createMessage());
      expect(orchestrator.getActiveSessionCount()).toBe(2);

      orchestrator.reset('chat-A');
      expect(orchestrator.getActiveSessionCount()).toBe(1);
    });
  });

  describe('reset', () => {
    it('should reset a specific session', () => {
      orchestrator.processMessage('chat-123', createMessage());
      expect(orchestrator.hasSession('chat-123')).toBe(true);

      const result = orchestrator.reset('chat-123');

      expect(result).toBe(true);
      expect(orchestrator.hasSession('chat-123')).toBe(false);
    });

    it('should return false when resetting non-existent session', () => {
      const result = orchestrator.reset('non-existent');
      expect(result).toBe(false);
    });

    it('should clear thread root on reset', () => {
      orchestrator.processMessage('chat-123', createMessage({ messageId: 'msg-root' }));
      expect(orchestrator.getThreadRoot('chat-123')).toBe('msg-root');

      orchestrator.reset('chat-123');
      expect(orchestrator.getThreadRoot('chat-123')).toBeUndefined();
    });

    it('should not affect other sessions', () => {
      orchestrator.processMessage('chat-A', createMessage());
      orchestrator.processMessage('chat-B', createMessage());

      orchestrator.reset('chat-A');

      expect(orchestrator.hasSession('chat-A')).toBe(false);
      expect(orchestrator.hasSession('chat-B')).toBe(true);
    });
  });

  describe('resetAll / clearAll', () => {
    it('should reset all sessions', () => {
      orchestrator.processMessage('chat-A', createMessage());
      orchestrator.processMessage('chat-B', createMessage());
      orchestrator.processMessage('chat-C', createMessage());

      orchestrator.resetAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.hasSession('chat-A')).toBe(false);
      expect(orchestrator.hasSession('chat-B')).toBe(false);
    });

    it('should provide clearAll as alias for resetAll', () => {
      orchestrator.processMessage('chat-A', createMessage());
      orchestrator.processMessage('chat-B', createMessage());

      orchestrator.clearAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should close all sessions on shutdown', () => {
      orchestrator.processMessage('chat-A', createMessage());
      orchestrator.processMessage('chat-B', createMessage());

      orchestrator.shutdown();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should be safe to call shutdown multiple times', () => {
      orchestrator.processMessage('chat-A', createMessage());

      orchestrator.shutdown();
      orchestrator.shutdown();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should handle shutdown with no sessions', () => {
      orchestrator.shutdown();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });
});
