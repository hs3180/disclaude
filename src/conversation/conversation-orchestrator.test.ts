import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { QueuedMessage, SessionCallbacks } from './types.js';
import type pino from 'pino';

describe('ConversationOrchestrator', () => {
  let orchestrator: ConversationOrchestrator;
  let mockLogger: pino.Logger;
  let mockCallbacks: SessionCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as pino.Logger;

    mockCallbacks = {
      onMessage: vi.fn(),
      onFile: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };

    orchestrator = new ConversationOrchestrator({ logger: mockLogger });
  });

  describe('processMessage', () => {
    it('should create new session and return true', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      const isNewSession = await orchestrator.processMessage('chat1', message, mockCallbacks);

      expect(isNewSession).toBe(true);
      expect(orchestrator.hasSession('chat1')).toBe(true);
    });

    it('should return false for existing session', async () => {
      const message1: QueuedMessage = { text: 'Hello', messageId: '1' };
      const message2: QueuedMessage = { text: 'World', messageId: '2' };

      await orchestrator.processMessage('chat1', message1, mockCallbacks);
      const isNewSession = await orchestrator.processMessage('chat1', message2, mockCallbacks);

      expect(isNewSession).toBe(false);
    });

    it('should set thread root for new session', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: 'msg1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      expect(orchestrator.getThreadRoot('chat1')).toBe('msg1');
    });

    it('should update thread root for existing session', async () => {
      const message1: QueuedMessage = { text: 'Hello', messageId: 'msg1' };
      const message2: QueuedMessage = { text: 'World', messageId: 'msg2' };

      await orchestrator.processMessage('chat1', message1, mockCallbacks);
      await orchestrator.processMessage('chat1', message2, mockCallbacks);

      expect(orchestrator.getThreadRoot('chat1')).toBe('msg2');
    });

    it('should queue message', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      const queue = orchestrator.getQueue('chat1');
      expect(queue?.size()).toBe(1);
    });

    it('should call onCreateSession callback for new session', async () => {
      const onCreateSession = vi.fn();
      orchestrator.setOnCreateSession(onCreateSession);

      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      expect(onCreateSession).toHaveBeenCalledWith(
        'chat1',
        expect.anything(),
        mockCallbacks
      );
    });
  });

  describe('setThreadRoot', () => {
    it('should create session if it does not exist', () => {
      orchestrator.setThreadRoot('chat1', 'msg1');

      expect(orchestrator.hasSession('chat1')).toBe(true);
      expect(orchestrator.getThreadRoot('chat1')).toBe('msg1');
    });

    it('should update thread root for existing session', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: 'msg1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      orchestrator.setThreadRoot('chat1', 'msg2');

      expect(orchestrator.getThreadRoot('chat1')).toBe('msg2');
    });
  });

  describe('reset', () => {
    it('should return false when no session exists', () => {
      expect(orchestrator.reset('chat1')).toBe(false);
    });

    it('should return true and remove session', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      const result = orchestrator.reset('chat1');

      expect(result).toBe(true);
      expect(orchestrator.hasSession('chat1')).toBe(false);
    });
  });

  describe('getActiveSessionCount', () => {
    it('should return 0 when no sessions', () => {
      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('should return correct count', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);
      await orchestrator.processMessage('chat2', message, mockCallbacks);

      expect(orchestrator.getActiveSessionCount()).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return stats for no sessions', () => {
      const stats = orchestrator.getStats();

      expect(stats.activeSessions).toBe(0);
      expect(stats.totalQueuedMessages).toBe(0);
      expect(stats.activeChatIds).toEqual([]);
    });

    it('should return correct stats', async () => {
      const message1: QueuedMessage = { text: 'Hello', messageId: '1' };
      const message2: QueuedMessage = { text: 'World', messageId: '2' };

      await orchestrator.processMessage('chat1', message1, mockCallbacks);
      await orchestrator.processMessage('chat1', message2, mockCallbacks);
      await orchestrator.processMessage('chat2', message1, mockCallbacks);

      const stats = orchestrator.getStats();

      expect(stats.activeSessions).toBe(2);
      expect(stats.totalQueuedMessages).toBe(3);
      expect(stats.activeChatIds).toContain('chat1');
      expect(stats.activeChatIds).toContain('chat2');
    });
  });

  describe('shutdown', () => {
    it('should close all sessions', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);
      await orchestrator.processMessage('chat2', message, mockCallbacks);

      await orchestrator.shutdown();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });
  });

  describe('backward compatibility', () => {
    it('size should return session count', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      expect(orchestrator.size()).toBe(1);
    });

    it('clearAll should close all sessions', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      orchestrator.clearAll();

      expect(orchestrator.getActiveSessionCount()).toBe(0);
    });

    it('deleteThreadRoot should work', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: 'msg1' };
      await orchestrator.processMessage('chat1', message, mockCallbacks);

      const result = orchestrator.deleteThreadRoot('chat1');

      expect(result).toBe(true);
      expect(orchestrator.getThreadRoot('chat1')).toBeUndefined();
    });
  });
});
