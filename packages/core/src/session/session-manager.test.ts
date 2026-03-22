/**
 * Unit tests for TemporarySessionManager.
 *
 * @module core/session/session-manager.test
 * @see Issue #1391
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TemporarySessionManager } from './session-manager.js';
import type { CreateTemporarySessionOptions, SessionResponse } from './types.js';

describe('TemporarySessionManager', () => {
  let tmpDir: string;
  let manager: TemporarySessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    manager = new TemporarySessionManager({ baseDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const defaultOptions: CreateTemporarySessionOptions = {
    id: 'test-session',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
    message: 'Please review this item',
    options: [
      { value: 'approve', text: '✅ Approve' },
      { value: 'reject', text: '❌ Reject' },
    ],
  };

  describe('create', () => {
    it('should create a new session with pending status', () => {
      const session = manager.create(defaultOptions);

      expect(session.id).toBe('test-session');
      expect(session.status).toBe('pending');
      expect(session.chatId).toBeNull();
      expect(session.messageId).toBeNull();
      expect(session.message).toBe('Please review this item');
      expect(session.options).toHaveLength(2);
      expect(session.response).toBeNull();
      expect(session.expiry).toBeNull();
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
    });

    it('should create session with createGroup config', () => {
      const options: CreateTemporarySessionOptions = {
        ...defaultOptions,
        id: 'group-session',
        createGroup: {
          name: 'Test Group',
          members: ['ou_user1', 'ou_user2'],
        },
      };

      const session = manager.create(options);

      expect(session.createGroup).toBeDefined();
      expect(session.createGroup!.name).toBe('Test Group');
      expect(session.createGroup!.members).toEqual(['ou_user1', 'ou_user2']);
    });

    it('should create session with context', () => {
      const options: CreateTemporarySessionOptions = {
        ...defaultOptions,
        id: 'context-session',
        context: { prNumber: 123, repository: 'test/repo' },
      };

      const session = manager.create(options);

      expect(session.context).toEqual({ prNumber: 123, repository: 'test/repo' });
    });

    it('should throw if session with same ID already exists', () => {
      manager.create(defaultOptions);

      expect(() => manager.create(defaultOptions)).toThrow(
        "Session 'test-session' already exists"
      );
    });

    it('should persist session file to disk', () => {
      manager.create(defaultOptions);

      const sessionDir = manager.getSessionDir();
      const files = fs.readdirSync(sessionDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe('test-session.json');

      const content = JSON.parse(fs.readFileSync(path.join(sessionDir, files[0]), 'utf-8'));
      expect(content.id).toBe('test-session');
      expect(content.status).toBe('pending');
    });
  });

  describe('read', () => {
    it('should read an existing session', () => {
      const created = manager.create(defaultOptions);
      const read = manager.read('test-session');

      expect(read).not.toBeNull();
      expect(read!.id).toBe(created.id);
      expect(read!.status).toBe(created.status);
    });

    it('should return null for non-existent session', () => {
      const result = manager.read('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('activate', () => {
    it('should activate a pending session', () => {
      manager.create(defaultOptions);
      const activated = manager.activate('test-session', 'oc_new_chat', 'om_new_msg');

      expect(activated).not.toBeNull();
      expect(activated!.status).toBe('active');
      expect(activated!.chatId).toBe('oc_new_chat');
      expect(activated!.messageId).toBe('om_new_msg');
    });

    it('should throw if session is not pending', () => {
      manager.create(defaultOptions);
      manager.activate('test-session', 'oc_chat', 'om_msg');

      expect(() => manager.activate('test-session', 'oc_other', 'om_other')).toThrow(
        "Cannot activate session 'test-session': status is 'active'"
      );
    });

    it('should return null for non-existent session', () => {
      const result = manager.activate('non-existent', 'oc_chat', 'om_msg');
      expect(result).toBeNull();
    });

    it('should update the file on disk', () => {
      manager.create(defaultOptions);
      manager.activate('test-session', 'oc_chat', 'om_msg');

      const session = manager.read('test-session');
      expect(session!.chatId).toBe('oc_chat');
      expect(session!.messageId).toBe('om_msg');
    });
  });

  describe('respond', () => {
    function createActivatedSession() {
      manager.create(defaultOptions);
      manager.activate('test-session', 'oc_chat', 'om_msg');
    }

    it('should record a response and expire the session', () => {
      createActivatedSession();

      const response: SessionResponse = {
        selectedValue: 'approve',
        selectedText: '✅ Approve',
        responder: 'ou_user1',
        repliedAt: new Date().toISOString(),
      };

      const result = manager.respond('test-session', response);

      expect(result).not.toBeNull();
      expect(result!.status).toBe('expired');
      expect(result!.response).toEqual(response);
      expect(result!.expiry).not.toBeNull();
      expect(result!.expiry!.reason).toBe('response');
    });

    it('should throw if session is not active', () => {
      manager.create(defaultOptions);

      expect(() => manager.respond('test-session', {
        selectedValue: 'approve',
        responder: 'ou_user1',
        repliedAt: new Date().toISOString(),
      })).toThrow(
        "Cannot record response for session 'test-session': status is 'pending'"
      );
    });

    it('should return null for non-existent session', () => {
      const result = manager.respond('non-existent', {
        selectedValue: 'approve',
        responder: 'ou_user1',
        repliedAt: new Date().toISOString(),
      });
      expect(result).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should cancel a pending session', () => {
      manager.create(defaultOptions);
      const result = manager.cancel('test-session');

      expect(result!.status).toBe('expired');
      expect(result!.expiry!.reason).toBe('cancelled');
    });

    it('should cancel an active session', () => {
      manager.create(defaultOptions);
      manager.activate('test-session', 'oc_chat', 'om_msg');
      const result = manager.cancel('test-session');

      expect(result!.status).toBe('expired');
      expect(result!.expiry!.reason).toBe('cancelled');
    });

    it('should be a no-op for already expired sessions', () => {
      manager.create(defaultOptions);
      manager.cancel('test-session');
      const result = manager.cancel('test-session');

      expect(result!.expiry!.reason).toBe('cancelled');
    });

    it('should return null for non-existent session', () => {
      const result = manager.cancel('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('checkTimeouts', () => {
    it('should expire active sessions past their expiration time', () => {
      manager.create({
        ...defaultOptions,
        id: 'expired-session',
        expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      });
      manager.activate('expired-session', 'oc_chat', 'om_msg');

      const expired = manager.checkTimeouts();

      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('expired-session');
      expect(expired[0].status).toBe('expired');
      expect(expired[0].expiry!.reason).toBe('timeout');

      // Verify persisted
      const session = manager.read('expired-session');
      expect(session!.status).toBe('expired');
      expect(session!.expiry!.reason).toBe('timeout');
    });

    it('should not expire sessions that are still valid', () => {
      manager.create({
        ...defaultOptions,
        id: 'valid-session',
        expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
      });
      manager.activate('valid-session', 'oc_chat', 'om_msg');

      const expired = manager.checkTimeouts();
      expect(expired).toHaveLength(0);
    });

    it('should not expire non-active sessions', () => {
      manager.create({
        ...defaultOptions,
        id: 'pending-session',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      const expired = manager.checkTimeouts();
      expect(expired).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('should list all sessions', () => {
      manager.create({ ...defaultOptions, id: 's1' });
      manager.create({ ...defaultOptions, id: 's2' });

      const sessions = manager.list();
      expect(sessions).toHaveLength(2);
    });

    it('should filter sessions by status', () => {
      manager.create({ ...defaultOptions, id: 'pending-1' });
      manager.create({ ...defaultOptions, id: 'pending-2' });
      manager.create({ ...defaultOptions, id: 'active-1' });
      manager.activate('active-1', 'oc_chat', 'om_msg');

      const activeSessions = manager.list('active');
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].id).toBe('active-1');

      const pendingSessions = manager.list('pending');
      expect(pendingSessions).toHaveLength(2);
    });

    it('should return correct summary fields', () => {
      manager.create({ ...defaultOptions, id: 'summary-test' });

      const sessions = manager.list();
      const summary = sessions[0];

      expect(summary.id).toBe('summary-test');
      expect(summary.status).toBe('pending');
      expect(summary.chatId).toBeNull();
      expect(summary.hasResponse).toBe(false);
      expect(summary.endReason).toBeUndefined();
      expect(summary.createdAt).toBeDefined();
      expect(summary.updatedAt).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should delete an existing session', () => {
      manager.create(defaultOptions);
      const result = manager.delete('test-session');

      expect(result).toBe(true);
      expect(manager.read('test-session')).toBeNull();
    });

    it('should return false for non-existent session', () => {
      const result = manager.delete('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clean up expired sessions older than maxAge', () => {
      // Create and expire a session
      manager.create({ ...defaultOptions, id: 'old-expired' });
      manager.cancel('old-expired');

      // Manually set updatedAt to the past
      const session = manager.read('old-expired')!;
      session.updatedAt = new Date(Date.now() - 48 * 3600000).toISOString(); // 48 hours ago
      const sessionPath = path.join(manager.getSessionDir(), 'old-expired.json');
      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));

      const cleaned = manager.cleanup(24 * 3600000); // 24 hours max age
      expect(cleaned).toBe(1);
      expect(manager.read('old-expired')).toBeNull();
    });

    it('should not clean up recent expired sessions', () => {
      manager.create({ ...defaultOptions, id: 'recent-expired' });
      manager.cancel('recent-expired');

      const cleaned = manager.cleanup(24 * 3600000);
      expect(cleaned).toBe(0);
      expect(manager.read('recent-expired')).not.toBeNull();
    });

    it('should not clean up non-expired sessions', () => {
      manager.create({ ...defaultOptions, id: 'active-session' });
      manager.activate('active-session', 'oc_chat', 'om_msg');

      const cleaned = manager.cleanup(0); // Clean all expired
      expect(cleaned).toBe(0);
      expect(manager.read('active-session')).not.toBeNull();
    });
  });

  describe('getSessionDir', () => {
    it('should return the correct session directory path', () => {
      const dir = manager.getSessionDir();
      expect(dir).toContain('temporary-sessions');
      expect(dir).toContain(tmpDir);
    });
  });
});
