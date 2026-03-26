/**
 * Tests for list_discussions tool.
 *
 * Issue #1317: Tests the list_discussions MCP tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'list-discussions-test-'));

vi.mock('./credentials.js', () => ({
  getWorkspaceDir: () => tempDir,
}));

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { list_discussions } from './list-discussions.js';
import { writeSession } from './temporary-session.js';
import type { TemporarySession } from './types.js';

describe('list_discussions', () => {
  beforeEach(async () => {
    try {
      const sessionsDir = path.join(tempDir, 'temporary-sessions');
      const files = await fsPromises.readdir(sessionsDir);
      for (const file of files) {
        await fsPromises.unlink(path.join(sessionsDir, file));
      }
    } catch {
      // Ignore
    }
  });

  afterEach(async () => {
    try {
      const sessionsDir = path.join(tempDir, 'temporary-sessions');
      const files = await fsPromises.readdir(sessionsDir);
      for (const file of files) {
        await fsPromises.unlink(path.join(sessionsDir, file));
      }
    } catch {
      // Ignore
    }
  });

  function createTestSession(overrides?: Partial<TemporarySession>): TemporarySession {
    return {
      sessionId: 'list-test-session',
      status: 'pending',
      chatId: null,
      messageId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      topic: 'List Test Topic',
      message: 'List test message',
      options: [{ text: 'Yes', value: 'yes' }, { text: 'No', value: 'no' }],
      actionPrompts: {},
      context: {},
      response: null,
      ...overrides,
    };
  }

  it('should return empty list when no sessions exist', async () => {
    const result = await list_discussions();
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(0);
    expect(result.message).toContain('No sessions found');
  });

  it('should list all sessions without filter', async () => {
    await writeSession(createTestSession({ sessionId: 's1', topic: 'Topic 1' }));
    await writeSession(createTestSession({ sessionId: 's2', topic: 'Topic 2' }));

    const result = await list_discussions();
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(2);
    expect(result.message).toContain('2 total');
  });

  it('should filter by status', async () => {
    await writeSession(createTestSession({ sessionId: 's1', status: 'pending' }));
    await writeSession(createTestSession({ sessionId: 's2', status: 'active' }));
    await writeSession(createTestSession({ sessionId: 's3', status: 'expired' }));

    const result = await list_discussions({ status: 'active' });
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions![0].sessionId).toBe('s2');
  });

  it('should auto-expire overdue sessions before listing', async () => {
    await writeSession(createTestSession({
      sessionId: 'overdue-list',
      status: 'active',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    await writeSession(createTestSession({
      sessionId: 'valid-list',
      status: 'active',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }));

    const result = await list_discussions({ status: 'expired' });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions![0].sessionId).toBe('overdue-list');
  });

  it('should include status counts in message', async () => {
    await writeSession(createTestSession({ sessionId: 'p1', status: 'pending' }));
    await writeSession(createTestSession({ sessionId: 'a1', status: 'active' }));
    await writeSession(createTestSession({ sessionId: 'e1', status: 'expired' }));

    const result = await list_discussions();
    expect(result.message).toContain('1 pending');
    expect(result.message).toContain('1 active');
    expect(result.message).toContain('1 expired');
  });

  it('should show response info in listing', async () => {
    await writeSession(createTestSession({
      sessionId: 'responded',
      status: 'expired',
      response: {
        value: 'approve',
        text: '✅ Approve',
        respondedAt: '2026-03-27T10:00:00Z',
      },
    }));

    const result = await list_discussions();
    expect(result.message).toContain('✅ Approve');
  });
});
