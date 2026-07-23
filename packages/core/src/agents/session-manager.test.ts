/**
 * Unit tests for SessionManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager, buildSessionKey } from './session-manager.js';
import { MessageChannel } from './message-channel.js';
import type { QueryHandle } from '../sdk/index.js';
import type { Logger } from '../utils/logger.js';

// Create mock logger
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    bindings: vi.fn().mockReturnValue({}),
    flush: vi.fn(),
  } as unknown as Logger;
}

// Create mock QueryHandle
function createMockHandle(): QueryHandle {
  return {
    close: vi.fn(),
    cancel: vi.fn(),
    sessionId: 'test-session-id',
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    manager = new SessionManager({ logger: mockLogger });
  });

  afterEach(() => {
    manager.closeAll();
  });

  describe('constructor', () => {
    it('should create a SessionManager with empty sessions', () => {
      expect(manager.size()).toBe(0);
    });
  });

  describe('has', () => {
    it('should return false for non-existent chatId', () => {
      expect(manager.has('non-existent')).toBe(false);
    });

    it('should return true for existing session', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      manager.create('chat-1', handle, channel);

      expect(manager.has('chat-1')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent chatId', () => {
      expect(manager.get('non-existent')).toBeUndefined();
    });

    it('should return the session for existing chatId', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      const session = manager.create('chat-1', handle, channel);

      expect(manager.get('chat-1')).toBe(session);
    });
  });

  describe('getHandle', () => {
    it('should return undefined for non-existent chatId', () => {
      expect(manager.getHandle('non-existent')).toBeUndefined();
    });

    it('should return the QueryHandle for existing session', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      manager.create('chat-1', handle, channel);

      expect(manager.getHandle('chat-1')).toBe(handle);
    });
  });

  describe('getChannel', () => {
    it('should return undefined for non-existent chatId', () => {
      expect(manager.getChannel('non-existent')).toBeUndefined();
    });

    it('should return the MessageChannel for existing session', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      manager.create('chat-1', handle, channel);

      expect(manager.getChannel('chat-1')).toBe(channel);
    });
  });

  describe('create', () => {
    it('should create a new session', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      const session = manager.create('chat-1', handle, channel);

      expect(session).toBeDefined();
      expect(session.handle).toBe(handle);
      expect(session.channel).toBe(channel);
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(manager.size()).toBe(1);
    });

    it('should replace existing session for same chatId', () => {
      const handle1 = createMockHandle();
      const channel1 = new MessageChannel();
      const handle2 = createMockHandle();
      const channel2 = new MessageChannel();

      manager.create('chat-1', handle1, channel1);
      const session2 = manager.create('chat-1', handle2, channel2);

      expect(manager.size()).toBe(1);
      expect(manager.get('chat-1')).toBe(session2);
      // Note: old session resources are NOT closed automatically
    });

    it('should create separate sessions for different chatIds', () => {
      const handle1 = createMockHandle();
      const channel1 = new MessageChannel();
      const handle2 = createMockHandle();
      const channel2 = new MessageChannel();

      manager.create('chat-1', handle1, channel1);
      manager.create('chat-2', handle2, channel2);

      expect(manager.size()).toBe(2);
      expect(manager.getHandle('chat-1')).toBe(handle1);
      expect(manager.getHandle('chat-2')).toBe(handle2);
    });
  });

  describe('delete', () => {
    it('should return false for non-existent chatId', () => {
      expect(manager.delete('non-existent')).toBe(false);
    });

    it('should delete session and close resources', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      manager.create('chat-1', handle, channel);

      const result = manager.delete('chat-1');

      expect(result).toBe(true);
      expect(manager.has('chat-1')).toBe(false);
      expect(handle.close).toHaveBeenCalled();
      expect(channel.isClosed()).toBe(true);
      expect(manager.size()).toBe(0);
    });

    it('should only delete once even if called multiple times', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      manager.create('chat-1', handle, channel);

      manager.delete('chat-1');
      manager.delete('chat-1');

      expect(handle.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteTracking', () => {
    it('should return false for non-existent chatId', () => {
      expect(manager.deleteTracking('non-existent')).toBe(false);
    });

    it('should remove tracking without closing resources', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      manager.create('chat-1', handle, channel);

      const result = manager.deleteTracking('chat-1');

      expect(result).toBe(true);
      expect(manager.has('chat-1')).toBe(false);
      expect(handle.close).not.toHaveBeenCalled();
      expect(channel.isClosed()).toBe(false);
    });
  });

  describe('closeChannel', () => {
    it('should return false for non-existent chatId', () => {
      expect(manager.closeChannel('non-existent')).toBe(false);
    });

    it('should close channel and remove session tracking', () => {
      const handle = createMockHandle();
      const channel = new MessageChannel();
      manager.create('chat-1', handle, channel);

      const result = manager.closeChannel('chat-1');

      expect(result).toBe(true);
      expect(manager.has('chat-1')).toBe(false);
      expect(handle.close).not.toHaveBeenCalled();
      expect(channel.isClosed()).toBe(true);
    });
  });

  describe('size', () => {
    it('should return 0 for empty manager', () => {
      expect(manager.size()).toBe(0);
    });

    it('should return correct count of sessions', () => {
      manager.create('chat-1', createMockHandle(), new MessageChannel());
      manager.create('chat-2', createMockHandle(), new MessageChannel());
      manager.create('chat-3', createMockHandle(), new MessageChannel());

      expect(manager.size()).toBe(3);
    });

    it('should decrease after deletion', () => {
      manager.create('chat-1', createMockHandle(), new MessageChannel());
      manager.create('chat-2', createMockHandle(), new MessageChannel());
      manager.delete('chat-1');

      expect(manager.size()).toBe(1);
    });
  });

  describe('getActiveChatIds', () => {
    it('should return empty array for empty manager', () => {
      expect(manager.getActiveChatIds()).toEqual([]);
    });

    it('should return all active chatIds', () => {
      manager.create('chat-1', createMockHandle(), new MessageChannel());
      manager.create('chat-2', createMockHandle(), new MessageChannel());
      manager.create('chat-3', createMockHandle(), new MessageChannel());

      const chatIds = manager.getActiveChatIds();
      expect(chatIds).toHaveLength(3);
      expect(chatIds).toContain('chat-1');
      expect(chatIds).toContain('chat-2');
      expect(chatIds).toContain('chat-3');
    });

    it('should not include deleted chatIds', () => {
      manager.create('chat-1', createMockHandle(), new MessageChannel());
      manager.create('chat-2', createMockHandle(), new MessageChannel());
      manager.delete('chat-1');

      const chatIds = manager.getActiveChatIds();
      expect(chatIds).toHaveLength(1);
      expect(chatIds).toContain('chat-2');
    });
  });

  describe('closeAll', () => {
    it('should close all sessions and clear tracking', () => {
      const handle1 = createMockHandle();
      const channel1 = new MessageChannel();
      const handle2 = createMockHandle();
      const channel2 = new MessageChannel();

      manager.create('chat-1', handle1, channel1);
      manager.create('chat-2', handle2, channel2);

      manager.closeAll();

      expect(handle1.close).toHaveBeenCalled();
      expect(handle2.close).toHaveBeenCalled();
      expect(channel1.isClosed()).toBe(true);
      expect(channel2.isClosed()).toBe(true);
      expect(manager.size()).toBe(0);
      expect(manager.getActiveChatIds()).toEqual([]);
    });

    it('should not throw when called on empty manager', () => {
      expect(() => manager.closeAll()).not.toThrow();
    });
  });

  describe('ChatAgentSession', () => {
    it('should have correct createdAt timestamp', () => {
      const before = Date.now();
      const handle = createMockHandle();
      const channel = new MessageChannel();
      const session = manager.create('chat-1', handle, channel);
      const after = Date.now();

      const createdAt = session.createdAt.getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);
    });
  });

  describe('buildSessionKey (Issue #4305 part 1)', () => {
    // Key-derivation primitive for per-thread session isolation. Part 1
    // introduces the helper + tests; wiring it into SessionManager methods and
    // ChatAgent routing is part 2. These lock the contract that part 2 depends
    // on: p2p chats (no threadRoot) keep the existing chatId-only key, while
    // topic-group threads get a composite key — and the two never collide.

    it('returns chatId unchanged when threadRoot is omitted (p2p / non-topic chats)', () => {
      expect(buildSessionKey('oc_chat1')).toBe('oc_chat1');
    });

    it('returns chatId unchanged when threadRoot is undefined', () => {
      expect(buildSessionKey('oc_chat1', undefined)).toBe('oc_chat1');
    });

    it('treats an empty-string threadRoot as "no thread" (p2p fallback)', () => {
      // A falsy threadRoot must collapse to the chatId-only key so an absent
      // thread anchor never produces a trailing separator.
      expect(buildSessionKey('oc_chat1', '')).toBe('oc_chat1');
    });

    it('combines chatId + threadRoot with a "::" separator when threadRoot is present', () => {
      expect(buildSessionKey('oc_chat1', 'om_threadA')).toBe('oc_chat1::om_threadA');
    });

    it('is stable: the same inputs always produce the same key', () => {
      expect(buildSessionKey('oc_chat1', 'om_threadA'))
        .toBe(buildSessionKey('oc_chat1', 'om_threadA'));
    });

    it('isolates threads: same chatId, different threadRoots → different keys', () => {
      // The core #4305 invariant — thread A and thread B in the same topic
      // group must map to distinct sessions. If these collided, threads would
      // share a session and context would leak across threads.
      const keyA = buildSessionKey('oc_chat1', 'om_threadA');
      const keyB = buildSessionKey('oc_chat1', 'om_threadB');
      expect(keyA).not.toBe(keyB);
      expect(keyA).toBe('oc_chat1::om_threadA');
      expect(keyB).toBe('oc_chat1::om_threadB');
    });

    it('never collides between a thread-less session and a thread session of the same chat', () => {
      // A p2p session (chatId) and a thread session (chatId::threadRoot) for the
      // same chat must be distinct keys, so a chat that is both addressed p2p
      // and as a thread can't have one clobber the other.
      const p2p = buildSessionKey('oc_chat1');
      const threaded = buildSessionKey('oc_chat1', 'om_threadA');
      expect(p2p).not.toBe(threaded);
    });

    it('isolates chats: same threadRoot, different chatIds → different keys', () => {
      expect(buildSessionKey('oc_chat1', 'om_threadA'))
        .not.toBe(buildSessionKey('oc_chat2', 'om_threadA'));
    });
  });
});
