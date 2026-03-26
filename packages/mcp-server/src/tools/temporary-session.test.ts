/**
 * Tests for temporary session file I/O utilities.
 *
 * Issue #1317: Tests the inline session file operations (no Manager class).
 * Uses a temp directory to avoid polluting the workspace.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock credentials module to use a temp directory
const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'session-test-'));

vi.mock('./credentials.js', () => ({
  getWorkspaceDir: () => tempDir,
}));

// Mock @disclaude/core logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  readSession,
  writeSession,
  updateSession,
  listSessions,
  deleteSession,
  generateSessionId,
  expireOverdueSessions,
} from './temporary-session.js';
import type { TemporarySession } from './types.js';

function createTestSession(overrides?: Partial<TemporarySession>): TemporarySession {
  return {
    sessionId: 'test-session-123',
    status: 'pending',
    chatId: null,
    messageId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    topic: 'Test Topic',
    message: 'Test message content',
    options: [
      { text: '✅ Approve', value: 'approve', type: 'primary' },
      { text: '❌ Reject', value: 'reject', type: 'danger' },
    ],
    actionPrompts: {
      approve: '[用户操作] 用户选择了 Approve',
      reject: '[用户操作] 用户选择了 Reject',
    },
    context: { prNumber: 123 },
    response: null,
    ...overrides,
  };
}

const sessionsDir = path.join(tempDir, 'temporary-sessions');

async function cleanSessionsDir(): Promise<void> {
  try {
    const files = await fsPromises.readdir(sessionsDir);
    for (const file of files) {
      await fsPromises.unlink(path.join(sessionsDir, file));
    }
  } catch {
    // Directory might not exist yet
  }
}

describe('temporary-session', () => {
  beforeEach(async () => {
    await cleanSessionsDir();
  });

  afterEach(async () => {
    await cleanSessionsDir();
  });

  describe('generateSessionId', () => {
    it('should generate a session ID from topic', () => {
      const id = generateSessionId('PR #123 Review');
      expect(id).toContain('pr-123-review');
      expect(id.length).toBeGreaterThan(20);
    });

    it('should handle special characters in topic', () => {
      const id = generateSessionId('Hello, World! @#$%');
      expect(id).toContain('hello-world');
      expect(id).not.toMatch(/[@#$%]/);
    });

    it('should truncate long topics', () => {
      const longTopic = 'A'.repeat(100);
      const id = generateSessionId(longTopic);
      // Truncated to 40 chars + timestamp + random
      expect(id.split('-').length).toBeGreaterThan(2);
    });

    it('should generate unique IDs', () => {
      const id1 = generateSessionId('Same Topic');
      const id2 = generateSessionId('Same Topic');
      expect(id1).not.toBe(id2);
    });
  });

  describe('writeSession / readSession', () => {
    it('should write and read a session file', async () => {
      const session = createTestSession();
      await writeSession(session);

      const read = await readSession('test-session-123');
      expect(read).not.toBeNull();
      expect(read!.sessionId).toBe('test-session-123');
      expect(read!.status).toBe('pending');
      expect(read!.topic).toBe('Test Topic');
      expect(read!.options).toHaveLength(2);
      expect(read!.response).toBeNull();
    });

    it('should return null for non-existent session', async () => {
      const read = await readSession('non-existent');
      expect(read).toBeNull();
    });

    it('should create the sessions directory if not exists', async () => {
      // Remove the sessions directory if it exists (afterEach cleaned files but not dir)
      try {
        await fsPromises.rmdir(sessionsDir);
      } catch {
        // Ignore
      }

      const session = createTestSession();
      await writeSession(session);

      const read = await readSession('test-session-123');
      expect(read).not.toBeNull();
    });

    it('should sanitize session ID for filename', async () => {
      const session = createTestSession({ sessionId: 'session/with/slashes' });
      await writeSession(session);

      // Should be readable with the original ID (sanitized internally)
      const read = await readSession('session/with/slashes');
      expect(read).not.toBeNull();
      expect(read!.sessionId).toBe('session/with/slashes');
    });

    it('should return null for invalid session file', async () => {
      // Write invalid JSON
      const sessionsDir = path.join(tempDir, 'temporary-sessions');
      await fsPromises.mkdir(sessionsDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(sessionsDir, 'invalid.json'),
        '{ "not": "a valid session" }',
        'utf-8'
      );

      const read = await readSession('invalid');
      expect(read).toBeNull();
    });
  });

  describe('updateSession', () => {
    it('should update specific fields', async () => {
      const fixedTime = '2026-01-01T00:00:00.000Z';
      const session = createTestSession({ updatedAt: fixedTime });
      await writeSession(session);

      const updated = await updateSession('test-session-123', {
        status: 'active',
        chatId: 'oc_new_chat',
        messageId: 'om_msg_123',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('active');
      expect(updated!.chatId).toBe('oc_new_chat');
      expect(updated!.messageId).toBe('om_msg_123');
      // Original fields should be preserved
      expect(updated!.topic).toBe('Test Topic');
      expect(updated!.options).toHaveLength(2);
      // updatedAt should be changed
      expect(updated!.updatedAt).not.toBe(session.updatedAt);
    });

    it('should return null for non-existent session', async () => {
      const result = await updateSession('non-existent', { status: 'active' });
      expect(result).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should list all sessions', async () => {
      await writeSession(createTestSession({ sessionId: 'session-1', topic: 'Topic 1' }));
      await writeSession(createTestSession({ sessionId: 'session-2', topic: 'Topic 2' }));
      await writeSession(createTestSession({ sessionId: 'session-3', topic: 'Topic 3' }));

      const sessions = await listSessions();
      expect(sessions).toHaveLength(3);
    });

    it('should filter by status', async () => {
      await writeSession(createTestSession({ sessionId: 's1', status: 'pending' }));
      await writeSession(createTestSession({ sessionId: 's2', status: 'active' }));
      await writeSession(createTestSession({ sessionId: 's3', status: 'expired' }));

      const pending = await listSessions('pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].sessionId).toBe('s1');

      const active = await listSessions('active');
      expect(active).toHaveLength(1);
      expect(active[0].sessionId).toBe('s2');
    });

    it('should return empty array when no sessions exist', async () => {
      const sessions = await listSessions();
      expect(sessions).toHaveLength(0);
    });

    it('should sort by creation time, newest first', async () => {
      const base = new Date('2026-01-01T00:00:00Z');
      await writeSession(createTestSession({
        sessionId: 'old-session',
        createdAt: base.toISOString(),
      }));
      await writeSession(createTestSession({
        sessionId: 'new-session',
        createdAt: new Date(base.getTime() + 60000).toISOString(),
      }));

      const sessions = await listSessions();
      expect(sessions[0].sessionId).toBe('new-session');
      expect(sessions[1].sessionId).toBe('old-session');
    });

    it('should skip invalid session files', async () => {
      await writeSession(createTestSession({ sessionId: 'valid-1' }));

      // Write an invalid file
      const sessionsDir = path.join(tempDir, 'temporary-sessions');
      await fsPromises.mkdir(sessionsDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(sessionsDir, 'corrupt.json'),
        'not valid json{{{',
        'utf-8'
      );

      const sessions = await listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('valid-1');
    });
  });

  describe('deleteSession', () => {
    it('should delete an existing session', async () => {
      await writeSession(createTestSession());
      expect(await readSession('test-session-123')).not.toBeNull();

      const deleted = await deleteSession('test-session-123');
      expect(deleted).toBe(true);
      expect(await readSession('test-session-123')).toBeNull();
    });

    it('should return false for non-existent session', async () => {
      const deleted = await deleteSession('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('expireOverdueSessions', () => {
    it('should mark expired active sessions', async () => {
      await writeSession(createTestSession({
        sessionId: 'overdue-active',
        status: 'active',
        expiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
      }));
      await writeSession(createTestSession({
        sessionId: 'valid-active',
        status: 'active',
        expiresAt: new Date(Date.now() + 3600000).toISOString(), // expires in 1h
      }));

      const count = await expireOverdueSessions();
      expect(count).toBe(1);

      const overdue = await readSession('overdue-active');
      expect(overdue!.status).toBe('expired');

      const valid = await readSession('valid-active');
      expect(valid!.status).toBe('active');
    });

    it('should mark expired pending sessions', async () => {
      await writeSession(createTestSession({
        sessionId: 'overdue-pending',
        status: 'pending',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }));

      const count = await expireOverdueSessions();
      expect(count).toBe(1);

      const overdue = await readSession('overdue-pending');
      expect(overdue!.status).toBe('expired');
    });

    it('should not re-expire already expired sessions', async () => {
      await writeSession(createTestSession({
        sessionId: 'already-expired',
        status: 'expired',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }));

      const count = await expireOverdueSessions();
      expect(count).toBe(0);
    });

    it('should return 0 when no sessions are overdue', async () => {
      await writeSession(createTestSession({
        sessionId: 'future-session',
        status: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }));

      const count = await expireOverdueSessions();
      expect(count).toBe(0);
    });
  });

  describe('full lifecycle', () => {
    it('should handle pending → active → expired lifecycle', async () => {
      // Step 1: Create pending session
      const session = createTestSession({
        sessionId: 'lifecycle-test',
        status: 'pending',
        chatId: null,
        messageId: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      await writeSession(session);

      let read = await readSession('lifecycle-test');
      expect(read!.status).toBe('pending');
      expect(read!.chatId).toBeNull();

      // Step 2: Activate (group created, message sent)
      const updated = await updateSession('lifecycle-test', {
        status: 'active',
        chatId: 'oc_test_chat',
        messageId: 'om_test_msg',
      });
      expect(updated!.status).toBe('active');
      expect(updated!.chatId).toBe('oc_test_chat');

      // Step 3: User responds
      const responded = await updateSession('lifecycle-test', {
        status: 'expired',
        response: {
          value: 'approve',
          text: '✅ Approve',
          respondedAt: new Date().toISOString(),
        },
      });
      expect(responded!.status).toBe('expired');
      expect(responded!.response!.value).toBe('approve');

      // Step 4: Verify via list
      const sessions = await listSessions();
      const found = sessions.find(s => s.sessionId === 'lifecycle-test');
      expect(found).toBeDefined();
      expect(found!.status).toBe('expired');
    });
  });
});
