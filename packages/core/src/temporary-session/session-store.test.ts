/**
 * Tests for Temporary Session Store.
 *
 * Issue #1391: Simplified temporary session management using JSON files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  createSession,
  readSession,
  writeSession,
  updateSessionStatus,
  activateSession,
  respondToSession,
  expireSession,
  listSessions,
  listTimedOutSessions,
  findSessionByMessageId,
  deleteSession,
  getSessionDir,
  getSessionFilePath,
  ensureSessionDir,
} from './session-store.js';
import type { TemporarySession, CreateTemporarySessionOptions } from './types.js';

describe('session-store', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('getSessionDir', () => {
    it('should return workspace/temporary-sessions with default base', () => {
      const dir = getSessionDir(testDir);
      expect(dir).toBe(path.join(testDir, 'temporary-sessions'));
    });
  });

  describe('getSessionFilePath', () => {
    it('should return correct file path', () => {
      const filePath = getSessionFilePath('test-session', testDir);
      expect(filePath).toBe(path.join(testDir, 'temporary-sessions', 'test-session.json'));
    });
  });

  describe('ensureSessionDir', () => {
    it('should create session directory', async () => {
      await ensureSessionDir(testDir);
      const stat = await fs.stat(getSessionDir(testDir));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('createSession', () => {
    const baseOptions: CreateTemporarySessionOptions = {
      id: 'test-session',
      message: 'Test message',
      options: [
        { value: 'yes', text: 'Yes' },
        { value: 'no', text: 'No' },
      ],
    };

    it('should create a session with default timeout', async () => {
      const session = await createSession(baseOptions, testDir);

      expect(session.id).toBe('test-session');
      expect(session.status).toBe('pending');
      expect(session.chatId).toBeNull();
      expect(session.messageId).toBeNull();
      expect(session.message).toBe('Test message');
      expect(session.options).toHaveLength(2);
      expect(session.response).toBeNull();
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
    });

    it('should create a session with custom timeout', async () => {
      const session = await createSession({
        ...baseOptions,
        timeoutMinutes: 30,
      }, testDir);

      const createdAt = new Date(session.createdAt).getTime();
      const expiresAt = new Date(session.expiresAt).getTime();
      const diffMinutes = (expiresAt - createdAt) / (1000 * 60);

      expect(diffMinutes).toBe(30);
    });

    it('should create a session with createGroup config', async () => {
      const session = await createSession({
        ...baseOptions,
        createGroup: {
          name: 'Test Group',
          members: ['ou_user1'],
        },
      }, testDir);

      expect(session.createGroup?.name).toBe('Test Group');
      expect(session.createGroup?.members).toEqual(['ou_user1']);
    });

    it('should create a session with context', async () => {
      const session = await createSession({
        ...baseOptions,
        context: { prNumber: 123, repo: 'test/repo' },
      }, testDir);

      expect(session.context).toEqual({ prNumber: 123, repo: 'test/repo' });
    });

    it('should write session file to disk', async () => {
      await createSession(baseOptions, testDir);

      const content = await fs.readFile(
        getSessionFilePath('test-session', testDir),
        'utf-8'
      );
      const parsed = JSON.parse(content);
      expect(parsed.id).toBe('test-session');
      expect(parsed.status).toBe('pending');
    });
  });

  describe('readSession', () => {
    it('should read an existing session', async () => {
      await createSession({ id: 'test-read', message: 'Hello' }, testDir);

      const session = await readSession('test-read', testDir);
      expect(session).not.toBeNull();
      expect(session!.id).toBe('test-read');
      expect(session!.message).toBe('Hello');
    });

    it('should return null for non-existent session', async () => {
      const session = await readSession('non-existent', testDir);
      expect(session).toBeNull();
    });

    it('should return null for invalid session file', async () => {
      await ensureSessionDir(testDir);
      await fs.writeFile(getSessionFilePath('invalid', testDir), 'not json');

      const session = await readSession('invalid', testDir);
      expect(session).toBeNull();
    });
  });

  describe('writeSession', () => {
    it('should write session atomically', async () => {
      await ensureSessionDir(testDir);

      const session: TemporarySession = {
        id: 'atomic-test',
        status: 'pending',
        chatId: null,
        messageId: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        message: 'Test',
        response: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await writeSession(session, testDir);

      const content = await fs.readFile(
        getSessionFilePath('atomic-test', testDir),
        'utf-8'
      );
      const parsed = JSON.parse(content);
      expect(parsed.id).toBe('atomic-test');
    });
  });

  describe('updateSessionStatus', () => {
    it('should update session status', async () => {
      await createSession({ id: 'status-test', message: 'Hello' }, testDir);

      const updated = await updateSessionStatus('status-test', 'active', testDir);
      expect(updated!.status).toBe('active');
    });

    it('should return null for non-existent session', async () => {
      const result = await updateSessionStatus('non-existent', 'active', testDir);
      expect(result).toBeNull();
    });
  });

  describe('activateSession', () => {
    it('should activate a session with chatId and messageId', async () => {
      await createSession({ id: 'activate-test', message: 'Hello' }, testDir);

      const activated = await activateSession(
        'activate-test',
        'oc_new_group',
        'om_card_message',
        testDir
      );

      expect(activated!.status).toBe('active');
      expect(activated!.chatId).toBe('oc_new_group');
      expect(activated!.messageId).toBe('om_card_message');
    });

    it('should return null for non-existent session', async () => {
      const result = await activateSession(
        'non-existent',
        'oc_test',
        'om_test',
        testDir
      );
      expect(result).toBeNull();
    });
  });

  describe('respondToSession', () => {
    it('should record user response and expire session', async () => {
      await createSession({ id: 'respond-test', message: 'Hello' }, testDir);

      const responded = await respondToSession(
        'respond-test',
        'approve',
        'ou_responder',
        testDir
      );

      expect(responded!.status).toBe('expired');
      expect(responded!.response).not.toBeNull();
      expect(responded!.response!.selectedValue).toBe('approve');
      expect(responded!.response!.responder).toBe('ou_responder');
      expect(responded!.response!.repliedAt).toBeDefined();
    });
  });

  describe('expireSession', () => {
    it('should expire a session without response', async () => {
      await createSession({ id: 'expire-test', message: 'Hello' }, testDir);

      const expired = await expireSession('expire-test', testDir);

      expect(expired!.status).toBe('expired');
      expect(expired!.response).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should list all sessions', async () => {
      await createSession({ id: 'session-1', message: 'First' }, testDir);
      await createSession({ id: 'session-2', message: 'Second' }, testDir);

      const sessions = await listSessions(undefined, testDir);
      expect(sessions).toHaveLength(2);
    });

    it('should filter by status', async () => {
      await createSession({ id: 'pending-1', message: 'Pending' }, testDir);
      await createSession({ id: 'active-1', message: 'Active' }, testDir);
      await updateSessionStatus('active-1', 'active', testDir);

      const pending = await listSessions('pending', testDir);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('pending-1');

      const active = await listSessions('active', testDir);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('active-1');
    });

    it('should sort by creation time (newest first)', async () => {
      await createSession({ id: 'old-session', message: 'Old' }, testDir);
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      await createSession({ id: 'new-session', message: 'New' }, testDir);

      const sessions = await listSessions(undefined, testDir);
      expect(sessions[0].id).toBe('new-session');
      expect(sessions[1].id).toBe('old-session');
    });

    it('should return empty array for non-existent directory', async () => {
      const sessions = await listSessions(undefined, testDir);
      expect(sessions).toEqual([]);
    });
  });

  describe('listTimedOutSessions', () => {
    it('should list sessions past their expiration time', async () => {
      // Create a session that already expired
      await createSession({
        id: 'timed-out',
        message: 'Expired',
        timeoutMinutes: -1, // Negative = already expired
      }, testDir);

      const timedOut = await listTimedOutSessions(testDir);
      expect(timedOut.length).toBeGreaterThanOrEqual(1);
      expect(timedOut.some(s => s.id === 'timed-out')).toBe(true);
    });

    it('should not include already expired sessions', async () => {
      await createSession({
        id: 'already-expired',
        message: 'Done',
        timeoutMinutes: -1,
      }, testDir);
      await updateSessionStatus('already-expired', 'expired', testDir);

      const timedOut = await listTimedOutSessions(testDir);
      expect(timedOut.some(s => s.id === 'already-expired')).toBe(false);
    });
  });

  describe('findSessionByMessageId', () => {
    it('should find an active session by message ID', async () => {
      await createSession({ id: 'msg-test', message: 'Hello' }, testDir);
      await activateSession('msg-test', 'oc_group', 'om_specific_msg', testDir);

      const found = await findSessionByMessageId('om_specific_msg', testDir);
      expect(found).not.toBeNull();
      expect(found!.id).toBe('msg-test');
    });

    it('should return null if no active session matches', async () => {
      const found = await findSessionByMessageId('om_nonexistent', testDir);
      expect(found).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('should delete an existing session', async () => {
      await createSession({ id: 'delete-test', message: 'Hello' }, testDir);

      const deleted = await deleteSession('delete-test', testDir);
      expect(deleted).toBe(true);

      const session = await readSession('delete-test', testDir);
      expect(session).toBeNull();
    });

    it('should return false for non-existent session', async () => {
      const deleted = await deleteSession('non-existent', testDir);
      expect(deleted).toBe(false);
    });
  });
});
