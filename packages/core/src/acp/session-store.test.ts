/**
 * Unit tests for AcpSessionStore
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AcpSessionStore } from './session-store.js';

describe('AcpSessionStore', () => {
  let store: AcpSessionStore;

  beforeEach(() => {
    store = new AcpSessionStore();
  });

  describe('create', () => {
    it('should create a session with default values', () => {
      const session = store.create();

      expect(session.sessionId).toBeDefined();
      expect(session.state).toBe('idle');
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
      expect(session.sessionId).toMatch(/^[0-9a-f-]+$/);
    });

    it('should create a session with options', () => {
      const session = store.create({
        cwd: '/workspace',
        mode: 'code',
        model: 'claude-3-opus',
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
      });

      expect(session.cwd).toBe('/workspace');
      expect(session.mode).toBe('code');
    });

    it('should generate unique session IDs', () => {
      const s1 = store.create();
      const s2 = store.create();
      expect(s1.sessionId).not.toBe(s2.sessionId);
    });
  });

  describe('get', () => {
    it('should get an existing session', () => {
      const created = store.create({ cwd: '/workspace' });
      const retrieved = store.get(created.sessionId);

      expect(retrieved.sessionId).toBe(created.sessionId);
      expect(retrieved.cwd).toBe('/workspace');
    });

    it('should throw for non-existent session', () => {
      expect(() => store.get('non-existent')).toThrow('Session not found');
    });
  });

  describe('has', () => {
    it('should return true for existing session', () => {
      const session = store.create();
      expect(store.has(session.sessionId)).toBe(true);
    });

    it('should return false for non-existent session', () => {
      expect(store.has('non-existent')).toBe(false);
    });
  });

  describe('updateState', () => {
    it('should update session state', () => {
      const session = store.create();
      const updated = store.updateState(session.sessionId, 'running');

      expect(updated.state).toBe('running');
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(session.updatedAt).getTime()
      );
    });

    it('should throw for non-existent session', () => {
      expect(() => store.updateState('non-existent', 'running')).toThrow('Session not found');
    });
  });

  describe('updateTitle', () => {
    it('should update session title', () => {
      const session = store.create();
      const updated = store.updateTitle(session.sessionId, 'My Session');

      expect(updated.title).toBe('My Session');
    });
  });

  describe('updateMode', () => {
    it('should update session mode', () => {
      const session = store.create({ mode: 'code' });
      const updated = store.updateMode(session.sessionId, 'ask');

      expect(updated.mode).toBe('ask');
    });
  });

  describe('delete', () => {
    it('should delete an existing session', () => {
      const session = store.create();
      expect(store.delete(session.sessionId)).toBe(true);
      expect(store.has(session.sessionId)).toBe(false);
    });

    it('should return false for non-existent session', () => {
      expect(store.delete('non-existent')).toBe(false);
    });
  });

  describe('list', () => {
    it('should list all sessions', () => {
      store.create({ cwd: '/a' });
      store.create({ cwd: '/b' });
      store.create({ cwd: '/c' });

      const result = store.list();
      expect(result.sessions).toHaveLength(3);
    });

    it('should filter by cwd', () => {
      store.create({ cwd: '/workspace' });
      store.create({ cwd: '/other' });
      store.create({ cwd: '/workspace' });

      const result = store.list({ cwd: '/workspace' });
      expect(result.sessions).toHaveLength(2);
    });

    it('should respect limit', () => {
      store.create();
      store.create();
      store.create();

      const result = store.list({ limit: 2 });
      expect(result.sessions).toHaveLength(2);
      expect(result.nextCursor).toBeDefined();
    });

    it('should sort by updatedAt descending', () => {
      const s1 = store.create();
      // Small delay to ensure different timestamps
      const start = Date.now();
      while (Date.now() === start) {
        // spin
      }
      const s2 = store.create();

      const result = store.list();
      expect(result.sessions[0].sessionId).toBe(s2.sessionId);
      expect(result.sessions[1].sessionId).toBe(s1.sessionId);
    });

    it('should return empty list for no sessions', () => {
      const result = store.list();
      expect(result.sessions).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should clear all sessions', () => {
      store.create();
      store.create();
      store.create();

      expect(store.size).toBe(3);
      store.clear();
      expect(store.size).toBe(0);
    });
  });

  describe('sdk session ID management', () => {
    it('should store and retrieve SDK session ID', () => {
      const session = store.create();
      store.setSdkSessionId(session.sessionId, 'sdk-123');

      expect(store.getSdkSessionId(session.sessionId)).toBe('sdk-123');
    });

    it('should return undefined for non-existent SDK session ID', () => {
      const session = store.create();
      expect(store.getSdkSessionId(session.sessionId)).toBeUndefined();
    });

    it('should throw when setting SDK session ID for non-existent session', () => {
      expect(() => store.setSdkSessionId('non-existent', 'sdk-123')).toThrow('Session not found');
    });
  });

  describe('getOptions', () => {
    it('should retrieve session options', () => {
      const options = { cwd: '/workspace', model: 'claude-3' };
      store.create(options);

      const retrieved = store.getOptions(
        store.list().sessions[0].sessionId
      );
      expect(retrieved.cwd).toBe('/workspace');
      expect(retrieved.model).toBe('claude-3');
    });

    it('should throw for non-existent session', () => {
      expect(() => store.getOptions('non-existent')).toThrow('Session not found');
    });
  });
});
