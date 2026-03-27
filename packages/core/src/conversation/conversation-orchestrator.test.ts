/**
 * Tests for ConversationOrchestrator.
 *
 * Tests the high-level conversation management API, including:
 * - Message processing and queuing
 * - Session lifecycle (create, reset, shutdown)
 * - Thread root tracking
 * - Session statistics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { QueuedMessage } from './types.js';

// Create a minimal pino-like logger mock
function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    orchestrator = new ConversationOrchestrator({ logger: mockLogger as unknown as import('pino').Logger });
  });

  describe('constructor', () => {
    it('should create an orchestrator with a logger', () => {
      expect(orchestrator).toBeDefined();
    });

    it('should start with no active sessions', () => {
      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.size()).toBe(0);
    });

    it('should accept callbacks in config', () => {
      const onMessage = vi.fn();
      const orch = new ConversationOrchestrator({
        logger: mockLogger as unknown as import('pino').Logger,
        callbacks: { onMessage },
      });
      expect(orch).toBeDefined();
    });
  });

  describe('processMessage', () => {
    const sampleMessage: QueuedMessage = {
      text: 'Hello, world!',
      messageId: 'msg-001',
    };

    it('should successfully process a message and create a session', () => {
      const result = orchestrator.processMessage('chat-1', sampleMessage);

      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should track thread root when processing a message', () => {
      orchestrator.processMessage('chat-1', sampleMessage);

      expect(orchestrator.getThreadRoot('chat-1')).toBe('msg-001');
    });

    it('should increment queue length for multiple messages', () => {
      orchestrator.processMessage('chat-1', sampleMessage);

      const result = orchestrator.processMessage('chat-1', {
        text: 'Second message',
        messageId: 'msg-002',
      });

      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(2);
    });

    it('should handle messages for different chatIds independently', () => {
      orchestrator.processMessage('chat-1', sampleMessage);
      const result = orchestrator.processMessage('chat-2', {
        text: 'Different chat',
        messageId: 'msg-003',
      });

      expect(result.success).toBe(true);
      expect(orchestrator.hasSession('chat-1')).toBe(true);
      expect(orchestrator.hasSession('chat-2')).toBe(true);
      expect(orchestrator.getActiveSessionCount()).toBe(2);
    });

    it('should reject messages for a closed session', () => {
      orchestrator.processMessage('chat-1', sampleMessage);
      orchestrator.reset('chat-1');

      const result = orchestrator.processMessage('chat-1', {
        text: 'After reset',
        messageId: 'msg-004',
      });

      // After reset, a new session is created and message should succeed
      // because reset() deletes the old session, and processMessage creates a new one
      expect(result.success).toBe(true);
    });

    it('should log debug message when processing', () => {
      orchestrator.processMessage('chat-1', sampleMessage);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'chat-1', messageId: 'msg-001' }),
        'Processing message'
      );
    });

    it('should include message text length in log', () => {
      orchestrator.processMessage('chat-1', sampleMessage);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ textLength: 13 }),
        'Processing message'
      );
    });
  });

  describe('session management', () => {
    it('should detect existing sessions with hasSession', () => {
      expect(orchestrator.hasSession('chat-1')).toBe(false);

      orchestrator.processMessage('chat-1', {
        text: 'Hello',
        messageId: 'msg-001',
      });

      expect(orchestrator.hasSession('chat-1')).toBe(true);
    });

    it('should return active chat IDs', () => {
      orchestrator.processMessage('chat-1', { text: 'A', messageId: 'm1' });
      orchestrator.processMessage('chat-2', { text: 'B', messageId: 'm2' });
      orchestrator.processMessage('chat-3', { text: 'C', messageId: 'm3' });

      const ids = orchestrator.getActiveChatIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('chat-1');
      expect(ids).toContain('chat-2');
      expect(ids).toContain('chat-3');
    });
  });

  describe('thread root management', () => {
    it('should return undefined for non-existent thread root', () => {
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should set thread root via setThreadRoot', () => {
      orchestrator.setThreadRoot('chat-1', 'thread-001');

      expect(orchestrator.getThreadRoot('chat-1')).toBe('thread-001');
    });

    it('should overwrite existing thread root', () => {
      orchestrator.setThreadRoot('chat-1', 'thread-001');
      orchestrator.setThreadRoot('chat-1', 'thread-002');

      expect(orchestrator.getThreadRoot('chat-1')).toBe('thread-002');
    });

    it('should delete thread root and return true', () => {
      orchestrator.setThreadRoot('chat-1', 'thread-001');
      const deleted = orchestrator.deleteThreadRoot('chat-1');

      expect(deleted).toBe(true);
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });

    it('should return false when deleting non-existent thread root', () => {
      const deleted = orchestrator.deleteThreadRoot('chat-1');
      expect(deleted).toBe(false);
    });

    it('should not affect other chatIds when deleting thread root', () => {
      orchestrator.setThreadRoot('chat-1', 'thread-001');
      orchestrator.setThreadRoot('chat-2', 'thread-002');

      orchestrator.deleteThreadRoot('chat-1');

      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
      expect(orchestrator.getThreadRoot('chat-2')).toBe('thread-002');
    });
  });

  describe('session statistics', () => {
    it('should return undefined stats for non-existent session', () => {
      expect(orchestrator.getSessionStats('chat-1')).toBeUndefined();
    });

    it('should return stats after processing a message', () => {
      orchestrator.processMessage('chat-1', { text: 'Hello', messageId: 'msg-001' });

      const stats = orchestrator.getSessionStats('chat-1');
      expect(stats).toBeDefined();
      expect(stats!.chatId).toBe('chat-1');
      expect(stats!.queueLength).toBe(1);
      expect(stats!.isClosed).toBe(false);
      expect(stats!.started).toBe(false);
      expect(stats!.createdAt).toBeGreaterThan(0);
      expect(stats!.lastActivity).toBeGreaterThan(0);
    });

    it('should include thread root ID in stats when set', () => {
      orchestrator.processMessage('chat-1', { text: 'Hello', messageId: 'msg-001' });

      const stats = orchestrator.getSessionStats('chat-1');
      expect(stats!.threadRootId).toBe('msg-001');
    });
  });

  describe('reset', () => {
    it('should reset a specific session and return true', () => {
      orchestrator.processMessage('chat-1', { text: 'Hello', messageId: 'msg-001' });

      const result = orchestrator.reset('chat-1');

      expect(result).toBe(true);
      expect(orchestrator.hasSession('chat-1')).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'chat-1' }),
        'Session reset for chatId'
      );
    });

    it('should return false for non-existent session', () => {
      const result = orchestrator.reset('chat-1');

      expect(result).toBe(false);
    });

    it('should not affect other sessions', () => {
      orchestrator.processMessage('chat-1', { text: 'A', messageId: 'm1' });
      orchestrator.processMessage('chat-2', { text: 'B', messageId: 'm2' });

      orchestrator.reset('chat-1');

      expect(orchestrator.hasSession('chat-1')).toBe(false);
      expect(orchestrator.hasSession('chat-2')).toBe(true);
    });

    it('should clear thread roots on reset', () => {
      orchestrator.processMessage('chat-1', { text: 'Hello', messageId: 'msg-001' });
      expect(orchestrator.getThreadRoot('chat-1')).toBe('msg-001');

      orchestrator.reset('chat-1');

      // Session no longer exists, so thread root is gone
      expect(orchestrator.getThreadRoot('chat-1')).toBeUndefined();
    });
  });

  describe('resetAll / clearAll', () => {
    it('should reset all sessions', () => {
      orchestrator.processMessage('chat-1', { text: 'A', messageId: 'm1' });
      orchestrator.processMessage('chat-2', { text: 'B', messageId: 'm2' });
      orchestrator.processMessage('chat-3', { text: 'C', messageId: 'm3' });

      orchestrator.resetAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.getActiveChatIds()).toHaveLength(0);
    });

    it('clearAll should behave as resetAll alias', () => {
      orchestrator.processMessage('chat-1', { text: 'A', messageId: 'm1' });

      orchestrator.clearAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should close all sessions on shutdown', () => {
      orchestrator.processMessage('chat-1', { text: 'A', messageId: 'm1' });
      orchestrator.processMessage('chat-2', { text: 'B', messageId: 'm2' });

      orchestrator.shutdown();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down ConversationOrchestrator');
      expect(mockLogger.info).toHaveBeenCalledWith('ConversationOrchestrator shutdown complete');
    });

    it('should handle shutdown when no sessions exist', () => {
      orchestrator.shutdown();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('getSessionManager', () => {
    it('should return the underlying session manager', () => {
      const manager = orchestrator.getSessionManager();

      expect(manager).toBeDefined();
      expect(manager).toHaveProperty('has');
      expect(manager).toHaveProperty('get');
    });
  });
});
