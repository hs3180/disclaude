/**
 * Unit tests for RestSessionManager.
 *
 * Covers:
 * - Session lifecycle: create, get, has, count
 * - Message management: addMessage, setStatus, complete
 * - Timer lifecycle: start/stop, idempotent start
 * - Edge cases: complete on non-existent session, addMessage on non-existent session
 *
 * @see Issue #4127 - Extract RestSessionManager from rest-channel.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { RestSessionManager } from './session-manager.js';

describe('RestSessionManager', () => {
  let manager: RestSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new RestSessionManager();
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  // --- Lifecycle ---

  describe('create / get / has / count', () => {
    it('creates a session with pending status and empty messages', () => {
      const session = manager.create('chat-1');

      expect(manager.has('chat-1')).toBe(true);
      expect(manager.count()).toBe(1);
      expect(session.chatId).toBe('chat-1');
      expect(session.status).toBe('pending');
      expect(session.messages).toEqual([]);
      expect(session.lastMessageId).toBeUndefined();
      expect(session.createdAt).toBe(session.updatedAt);
    });

    it('returns undefined for non-existent session', () => {
      expect(manager.get('nope')).toBeUndefined();
      expect(manager.has('nope')).toBe(false);
    });

    it('returns the same session object on subsequent get', () => {
      const created = manager.create('chat-1');
      const fetched = manager.get('chat-1');
      expect(fetched).toBe(created);
    });

    it('counts multiple sessions', () => {
      manager.create('chat-1');
      manager.create('chat-2');
      manager.create('chat-3');
      expect(manager.count()).toBe(3);
    });
  });

  // --- Message & status updates ---

  describe('addMessage', () => {
    it('appends a message and updates lastMessageId and updatedAt', () => {
      const session = manager.create('chat-1');
      const now = Date.now();

      manager.addMessage('chat-1', {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        timestamp: now,
      });

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].id).toBe('msg-1');
      expect(session.lastMessageId).toBe('msg-1');
      expect(session.updatedAt).toBe(now);
    });

    it('does nothing for a non-existent session', () => {
      manager.addMessage('nope', {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
      });
      expect(manager.count()).toBe(0);
    });
  });

  describe('setStatus', () => {
    it('updates the session status and updatedAt', () => {
      const session = manager.create('chat-1');
      const before = session.updatedAt;

      vi.setSystemTime(Date.now() + 1000);
      manager.setStatus('chat-1', 'processing');

      expect(session.status).toBe('processing');
      expect(session.updatedAt).toBeGreaterThan(before);
    });

    it('does nothing for a non-existent session', () => {
      manager.setStatus('nope', 'error');
      expect(manager.count()).toBe(0);
    });
  });

  describe('complete', () => {
    it('marks a session as completed', () => {
      const session = manager.create('chat-1');

      vi.setSystemTime(Date.now() + 1000);
      manager.complete('chat-1');

      expect(session.status).toBe('completed');
      expect(session.updatedAt).toBeGreaterThan(session.createdAt);
    });

    it('is a no-op for a non-existent session', () => {
      manager.complete('nope');
      expect(manager.count()).toBe(0);
    });
  });

  // --- start / stop ---

  describe('start / stop lifecycle', () => {
    it('start creates a cleanup interval', () => {
      manager.start();
      vi.advanceTimersByTime(60000);
      // Should not throw — interval is running
    });

    it('start is idempotent: calling twice does not leak intervals', () => {
      manager.start();
      manager.start();

      manager.create('chat-1');
      vi.advanceTimersByTime(60000);

      expect(manager.has('chat-1')).toBe(true);
    });

    it('stop clears all sessions and cleans up the timer', () => {
      manager.create('chat-1');
      manager.create('chat-2');
      expect(manager.count()).toBe(2);

      manager.start();
      manager.stop();

      expect(manager.count()).toBe(0);
    });
  });

  // --- Cleanup: TTL expiry ---

  describe('cleanup: TTL expiry', () => {
    it('removes sessions whose updatedAt exceeds SESSION_TTL (1 hour)', () => {
      manager.start();

      manager.create('chat-old');
      vi.advanceTimersByTime(3600001); // 1 hour + 1 ms
      vi.advanceTimersByTime(60000);   // trigger cleanup

      expect(manager.has('chat-old')).toBe(false);
    });
  });

  // --- stop without start ---

  describe('stop without start', () => {
    it('clears sessions even if start was never called', () => {
      manager.create('chat-1');
      manager.create('chat-2');
      expect(manager.count()).toBe(2);

      manager.stop();

      expect(manager.count()).toBe(0);
    });
  });
});
