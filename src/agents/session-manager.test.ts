import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from './session-manager.js';
import type { QueryHandle } from '../sdk/types.js';
import { MessageChannel } from './message-channel.js';
import type pino from 'pino';

// Mock dependencies
vi.mock('./message-channel.js');

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockLogger: pino.Logger;
  let mockHandle: QueryHandle;
  let mockChannel: MessageChannel;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as pino.Logger;

    mockHandle = {
      close: vi.fn(),
      cancel: vi.fn(),
    } as unknown as QueryHandle;

    mockChannel = {
      close: vi.fn(),
      push: vi.fn(),
      generator: vi.fn(),
    } as unknown as MessageChannel;

    sessionManager = new SessionManager({ logger: mockLogger });
  });

  describe('has', () => {
    it('should return false when no session exists', () => {
      expect(sessionManager.has('chat1')).toBe(false);
    });

    it('should return true when session exists', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      expect(sessionManager.has('chat1')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined when no session exists', () => {
      expect(sessionManager.get('chat1')).toBeUndefined();
    });

    it('should return session when it exists', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      const session = sessionManager.get('chat1');
      expect(session).toBeDefined();
      expect(session?.handle).toBe(mockHandle);
      expect(session?.channel).toBe(mockChannel);
      expect(session?.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('getHandle', () => {
    it('should return undefined when no session exists', () => {
      expect(sessionManager.getHandle('chat1')).toBeUndefined();
    });

    it('should return handle when session exists', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      expect(sessionManager.getHandle('chat1')).toBe(mockHandle);
    });
  });

  describe('getChannel', () => {
    it('should return undefined when no session exists', () => {
      expect(sessionManager.getChannel('chat1')).toBeUndefined();
    });

    it('should return channel when session exists', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      expect(sessionManager.getChannel('chat1')).toBe(mockChannel);
    });
  });

  describe('create', () => {
    it('should create a new session', () => {
      const session = sessionManager.create('chat1', mockHandle, mockChannel);

      expect(session.handle).toBe(mockHandle);
      expect(session.channel).toBe(mockChannel);
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(sessionManager.has('chat1')).toBe(true);
    });

    it('should log session creation', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { chatId: 'chat1' },
        'Session created'
      );
    });

    it('should overwrite existing session', () => {
      const mockHandle2 = { close: vi.fn(), cancel: vi.fn() } as unknown as QueryHandle;
      sessionManager.create('chat1', mockHandle, mockChannel);
      sessionManager.create('chat1', mockHandle2, mockChannel);

      expect(sessionManager.getHandle('chat1')).toBe(mockHandle2);
    });
  });

  describe('delete', () => {
    it('should return false when no session exists', () => {
      expect(sessionManager.delete('chat1')).toBe(false);
    });

    it('should delete session and close resources', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      const result = sessionManager.delete('chat1');

      expect(result).toBe(true);
      expect(sessionManager.has('chat1')).toBe(false);
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockHandle.close).toHaveBeenCalled();
    });

    it('should delete from map before closing resources', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);

      // Check that has() returns false before close() is called
      let hasDuringClose = true;
      vi.mocked(mockChannel.close).mockImplementation(() => {
        hasDuringClose = sessionManager.has('chat1');
      });

      sessionManager.delete('chat1');

      expect(hasDuringClose).toBe(false);
    });
  });

  describe('deleteTracking', () => {
    it('should return false when no session exists', () => {
      expect(sessionManager.deleteTracking('chat1')).toBe(false);
    });

    it('should remove tracking without closing resources', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      const result = sessionManager.deleteTracking('chat1');

      expect(result).toBe(true);
      expect(sessionManager.has('chat1')).toBe(false);
      expect(mockChannel.close).not.toHaveBeenCalled();
      expect(mockHandle.close).not.toHaveBeenCalled();
    });
  });

  describe('closeChannel', () => {
    it('should return false when no session exists', () => {
      expect(sessionManager.closeChannel('chat1')).toBe(false);
    });

    it('should close channel and remove tracking', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      const result = sessionManager.closeChannel('chat1');

      expect(result).toBe(true);
      expect(sessionManager.has('chat1')).toBe(false);
      expect(mockChannel.close).toHaveBeenCalled();
      // Handle should NOT be closed
      expect(mockHandle.close).not.toHaveBeenCalled();
    });
  });

  describe('size', () => {
    it('should return 0 when no sessions', () => {
      expect(sessionManager.size()).toBe(0);
    });

    it('should return correct count', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      sessionManager.create('chat2', mockHandle, mockChannel);
      expect(sessionManager.size()).toBe(2);
    });
  });

  describe('getActiveChatIds', () => {
    it('should return empty array when no sessions', () => {
      expect(sessionManager.getActiveChatIds()).toEqual([]);
    });

    it('should return all active chatIds', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      sessionManager.create('chat2', mockHandle, mockChannel);

      const chatIds = sessionManager.getActiveChatIds();
      expect(chatIds).toContain('chat1');
      expect(chatIds).toContain('chat2');
      expect(chatIds.length).toBe(2);
    });
  });

  describe('closeAll', () => {
    it('should close all sessions', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);
      sessionManager.create('chat2', mockHandle, mockChannel);

      sessionManager.closeAll();

      expect(sessionManager.size()).toBe(0);
      expect(mockChannel.close).toHaveBeenCalledTimes(2);
      expect(mockHandle.close).toHaveBeenCalledTimes(2);
    });

    it('should clear map before closing resources', () => {
      sessionManager.create('chat1', mockHandle, mockChannel);

      let sizeDuringClose = -1;
      vi.mocked(mockChannel.close).mockImplementation(() => {
        sizeDuringClose = sessionManager.size();
      });

      sessionManager.closeAll();

      expect(sizeDuringClose).toBe(0);
    });
  });
});
