import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationSessionManager } from './session-manager.js';
import type { SessionCallbacks } from './types.js';
import type pino from 'pino';

describe('ConversationSessionManager', () => {
  let manager: ConversationSessionManager;
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

    manager = new ConversationSessionManager({ logger: mockLogger });
  });

  describe('has', () => {
    it('should return false when no session exists', () => {
      expect(manager.has('chat1')).toBe(false);
    });

    it('should return true when session exists', () => {
      manager.create('chat1', mockCallbacks);
      expect(manager.has('chat1')).toBe(true);
    });
  });

  describe('create', () => {
    it('should create a new session', () => {
      const queue = manager.create('chat1', mockCallbacks);

      expect(queue).toBeDefined();
      expect(manager.has('chat1')).toBe(true);
    });

    it('should log session creation', () => {
      manager.create('chat1', mockCallbacks);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: 'chat1' },
        'Session created'
      );
    });
  });

  describe('getQueue', () => {
    it('should return undefined when no session exists', () => {
      expect(manager.getQueue('chat1')).toBeUndefined();
    });

    it('should return queue when session exists', () => {
      manager.create('chat1', mockCallbacks);
      const queue = manager.getQueue('chat1');
      expect(queue).toBeDefined();
    });
  });

  describe('getCallbacks', () => {
    it('should return undefined when no session exists', () => {
      expect(manager.getCallbacks('chat1')).toBeUndefined();
    });

    it('should return callbacks when session exists', () => {
      manager.create('chat1', mockCallbacks);
      expect(manager.getCallbacks('chat1')).toBe(mockCallbacks);
    });
  });

  describe('thread root management', () => {
    it('should set and get thread root', () => {
      manager.create('chat1', mockCallbacks);
      manager.setThreadRoot('chat1', 'msg1');

      expect(manager.getThreadRoot('chat1')).toBe('msg1');
    });

    it('should return undefined when no thread root set', () => {
      manager.create('chat1', mockCallbacks);
      expect(manager.getThreadRoot('chat1')).toBeUndefined();
    });

    it('should no-op when setting thread root for non-existent session', () => {
      manager.setThreadRoot('chat1', 'msg1');
      expect(manager.getThreadRoot('chat1')).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should return false when no session exists', () => {
      expect(manager.delete('chat1')).toBe(false);
    });

    it('should delete session and close queue', () => {
      manager.create('chat1', mockCallbacks);
      const queue = manager.getQueue('chat1');

      const result = manager.delete('chat1');

      expect(result).toBe(true);
      expect(manager.has('chat1')).toBe(false);
      expect(queue?.isClosed()).toBe(true);
    });

    it('should delete from map before closing queue', () => {
      manager.create('chat1', mockCallbacks);

      // Verify that has() returns false before queue is closed
      let hasDuringClose = true;
      const queue = manager.getQueue('chat1');
      const originalClose = queue?.close.bind(queue);
      if (queue && originalClose) {
        queue.close = () => {
          hasDuringClose = manager.has('chat1');
          originalClose();
        };
      }

      manager.delete('chat1');

      expect(hasDuringClose).toBe(false);
    });
  });

  describe('deleteTracking', () => {
    it('should return false when no session exists', () => {
      expect(manager.deleteTracking('chat1')).toBe(false);
    });

    it('should remove tracking without closing queue', () => {
      manager.create('chat1', mockCallbacks);
      const queue = manager.getQueue('chat1');

      const result = manager.deleteTracking('chat1');

      expect(result).toBe(true);
      expect(manager.has('chat1')).toBe(false);
      expect(queue?.isClosed()).toBe(false);
    });
  });

  describe('size', () => {
    it('should return 0 when no sessions', () => {
      expect(manager.size()).toBe(0);
    });

    it('should return correct count', () => {
      manager.create('chat1', mockCallbacks);
      manager.create('chat2', mockCallbacks);
      expect(manager.size()).toBe(2);
    });
  });

  describe('getActiveChatIds', () => {
    it('should return empty array when no sessions', () => {
      expect(manager.getActiveChatIds()).toEqual([]);
    });

    it('should return all active chatIds', () => {
      manager.create('chat1', mockCallbacks);
      manager.create('chat2', mockCallbacks);

      const chatIds = manager.getActiveChatIds();
      expect(chatIds).toContain('chat1');
      expect(chatIds).toContain('chat2');
      expect(chatIds.length).toBe(2);
    });
  });

  describe('closeAll', () => {
    it('should close all sessions', () => {
      manager.create('chat1', mockCallbacks);
      manager.create('chat2', mockCallbacks);

      manager.closeAll();

      expect(manager.size()).toBe(0);
    });

    it('should close all queues', () => {
      manager.create('chat1', mockCallbacks);
      manager.create('chat2', mockCallbacks);
      const queue1 = manager.getQueue('chat1');
      const queue2 = manager.getQueue('chat2');

      manager.closeAll();

      expect(queue1?.isClosed()).toBe(true);
      expect(queue2?.isClosed()).toBe(true);
    });
  });

  describe('backward compatibility', () => {
    it('deleteThreadRoot should work', () => {
      manager.create('chat1', mockCallbacks);
      manager.setThreadRoot('chat1', 'msg1');

      const result = manager.deleteThreadRoot('chat1');

      expect(result).toBe(true);
      expect(manager.getThreadRoot('chat1')).toBeUndefined();
    });

    it('clearAll should work', () => {
      manager.create('chat1', mockCallbacks);
      manager.create('chat2', mockCallbacks);

      manager.clearAll();

      expect(manager.size()).toBe(0);
    });
  });
});
