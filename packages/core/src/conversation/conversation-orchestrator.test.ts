/**
 * Tests for ConversationOrchestrator - high-level conversation management.
 *
 * Issue #1617 Phase 2/3: Tests for ConversationOrchestrator covering
 * message processing, session lifecycle, thread tracking, and statistics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type pino from 'pino';

function createMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
  } as unknown as pino.Logger;
}

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;
  let logger: pino.Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    orchestrator = new ConversationOrchestrator({ logger });
  });

  describe('constructor', () => {
    it('should create orchestrator with logger', () => {
      expect(orchestrator).toBeDefined();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('processMessage', () => {
    it('should queue a message and return success', () => {
      const result = orchestrator.processMessage('oc_chat_1', {
        text: 'Hello',
        messageId: 'msg_001',
      });

      expect(result.success).toBe(true);
      expect(result.queueLength).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should track thread root for the message', () => {
      orchestrator.processMessage('oc_chat_1', {
        text: 'Hello',
        messageId: 'msg_001',
      });

      expect(orchestrator.getThreadRoot('oc_chat_1')).toBe('msg_001');
    });

    it('should update thread root on subsequent messages', () => {
      orchestrator.processMessage('oc_chat_1', {
        text: 'First',
        messageId: 'msg_001',
      });
      orchestrator.processMessage('oc_chat_1', {
        text: 'Second',
        messageId: 'msg_002',
      });

      expect(orchestrator.getThreadRoot('oc_chat_1')).toBe('msg_002');
      expect(orchestrator.getSessionStats('oc_chat_1')?.queueLength).toBe(2);
    });

    it('should handle messages with attachments', () => {
      const result = orchestrator.processMessage('oc_chat_1', {
        text: 'Check this file',
        messageId: 'msg_003',
        attachments: [{ id: 'file_1', fileName: 'test.pdf', localPath: '/tmp/test.pdf', mimeType: 'application/pdf' }],
      });

      expect(result.success).toBe(true);
    });

    it('should create separate sessions for different chatIds', () => {
      orchestrator.processMessage('oc_chat_1', { text: 'Hello 1', messageId: 'msg_001' });
      orchestrator.processMessage('oc_chat_2', { text: 'Hello 2', messageId: 'msg_002' });

      expect(orchestrator.getActiveSessionCount()).toBe(2);
      expect(orchestrator.getSessionStats('oc_chat_1')?.queueLength).toBe(1);
      expect(orchestrator.getSessionStats('oc_chat_2')?.queueLength).toBe(1);
    });
  });

  describe('hasSession', () => {
    it('should return false for non-existent session', () => {
      expect(orchestrator.hasSession('oc_nonexistent')).toBe(false);
    });

    it('should return true after processing a message', () => {
      orchestrator.processMessage('oc_chat_1', { text: 'Hello', messageId: 'msg_001' });
      expect(orchestrator.hasSession('oc_chat_1')).toBe(true);
    });
  });

  describe('getThreadRoot / setThreadRoot / deleteThreadRoot', () => {
    it('should return undefined for non-existent session', () => {
      expect(orchestrator.getThreadRoot('oc_nonexistent')).toBeUndefined();
    });

    it('should set thread root directly', () => {
      orchestrator.setThreadRoot('oc_chat_1', 'msg_root');
      expect(orchestrator.getThreadRoot('oc_chat_1')).toBe('msg_root');
    });

    it('should delete thread root', () => {
      orchestrator.setThreadRoot('oc_chat_1', 'msg_root');
      const deleted = orchestrator.deleteThreadRoot('oc_chat_1');
      expect(deleted).toBe(true);
      expect(orchestrator.getThreadRoot('oc_chat_1')).toBeUndefined();
    });

    it('should return false when deleting non-existent thread root', () => {
      expect(orchestrator.deleteThreadRoot('oc_nonexistent')).toBe(false);
    });
  });

  describe('getSessionStats', () => {
    it('should return undefined for non-existent session', () => {
      expect(orchestrator.getSessionStats('oc_nonexistent')).toBeUndefined();
    });

    it('should return correct stats after processing messages', () => {
      orchestrator.processMessage('oc_chat_1', { text: 'Hello', messageId: 'msg_001' });
      orchestrator.processMessage('oc_chat_1', { text: 'World', messageId: 'msg_002' });

      const stats = orchestrator.getSessionStats('oc_chat_1');
      expect(stats).toBeDefined();
      expect(stats!.chatId).toBe('oc_chat_1');
      expect(stats!.queueLength).toBe(2);
      expect(stats!.isClosed).toBe(false);
      expect(stats!.started).toBe(false);
    });
  });

  describe('getActiveSessionCount / size', () => {
    it('should return 0 initially', () => {
      expect(orchestrator.getActiveSessionCount()).toBe(0);
      expect(orchestrator.size()).toBe(0);
    });

    it('should count active sessions correctly', () => {
      orchestrator.processMessage('oc_1', { text: 'a', messageId: 'm1' });
      orchestrator.processMessage('oc_2', { text: 'b', messageId: 'm2' });
      orchestrator.processMessage('oc_3', { text: 'c', messageId: 'm3' });

      expect(orchestrator.getActiveSessionCount()).toBe(3);
      expect(orchestrator.size()).toBe(3);
    });
  });

  describe('getActiveChatIds', () => {
    it('should return empty array initially', () => {
      expect(orchestrator.getActiveChatIds()).toEqual([]);
    });

    it('should return all active chat IDs', () => {
      orchestrator.processMessage('oc_1', { text: 'a', messageId: 'm1' });
      orchestrator.processMessage('oc_2', { text: 'b', messageId: 'm2' });

      const ids = orchestrator.getActiveChatIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('oc_1');
      expect(ids).toContain('oc_2');
    });
  });

  describe('reset', () => {
    it('should reset a specific session', () => {
      orchestrator.processMessage('oc_1', { text: 'a', messageId: 'm1' });
      orchestrator.processMessage('oc_2', { text: 'b', messageId: 'm2' });

      const deleted = orchestrator.reset('oc_1');
      expect(deleted).toBe(true);
      expect(orchestrator.hasSession('oc_1')).toBe(false);
      expect(orchestrator.hasSession('oc_2')).toBe(true);
    });

    it('should return false for non-existent session', () => {
      expect(orchestrator.reset('oc_nonexistent')).toBe(false);
    });
  });

  describe('resetAll / clearAll', () => {
    it('should reset all sessions', () => {
      orchestrator.processMessage('oc_1', { text: 'a', messageId: 'm1' });
      orchestrator.processMessage('oc_2', { text: 'b', messageId: 'm2' });

      orchestrator.resetAll();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('clearAll should be alias for resetAll', () => {
      orchestrator.processMessage('oc_1', { text: 'a', messageId: 'm1' });
      orchestrator.clearAll();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should close all sessions on shutdown', () => {
      orchestrator.processMessage('oc_1', { text: 'a', messageId: 'm1' });
      orchestrator.processMessage('oc_2', { text: 'b', messageId: 'm2' });

      orchestrator.shutdown();
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should handle shutdown when no sessions exist', () => {
      expect(() => orchestrator.shutdown()).not.toThrow();
    });
  });

  describe('getSessionManager', () => {
    it('should return the underlying session manager', () => {
      const sm = orchestrator.getSessionManager();
      expect(sm).toBeDefined();
    });
  });
});
