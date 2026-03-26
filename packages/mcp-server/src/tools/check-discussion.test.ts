/**
 * Tests for check_discussion tool.
 *
 * Issue #1317: Tests the check_discussion MCP tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'check-discussion-test-'));

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

import { check_discussion } from './check-discussion.js';
import { writeSession } from './temporary-session.js';
import type { TemporarySession } from './types.js';

describe('check_discussion', () => {
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
      sessionId: 'check-test-session',
      status: 'pending',
      chatId: null,
      messageId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      topic: 'Check Test Topic',
      message: 'Check test message',
      options: [{ text: 'Yes', value: 'yes' }, { text: 'No', value: 'no' }],
      actionPrompts: {},
      context: {},
      response: null,
      ...overrides,
    };
  }

  it('should reject empty sessionId', async () => {
    const result = await check_discussion({ sessionId: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId');
  });

  it('should return not found for non-existent session', async () => {
    const result = await check_discussion({ sessionId: 'non-existent' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return session details for pending session', async () => {
    await writeSession(createTestSession({
      sessionId: 'pending-check',
      status: 'pending',
    }));

    const result = await check_discussion({ sessionId: 'pending-check' });
    expect(result.success).toBe(true);
    expect(result.session).toBeDefined();
    expect(result.session!.status).toBe('pending');
    expect(result.session!.topic).toBe('Check Test Topic');
    expect(result.message).toContain('pending');
    expect(result.message).toContain('No response yet');
  });

  it('should return session details for active session with response', async () => {
    await writeSession(createTestSession({
      sessionId: 'active-check',
      status: 'active',
      chatId: 'oc_test_chat',
      response: {
        value: 'approve',
        text: '✅ Approve',
        respondedAt: new Date().toISOString(),
      },
    }));

    const result = await check_discussion({ sessionId: 'active-check' });
    expect(result.success).toBe(true);
    expect(result.session!.status).toBe('active');
    expect(result.session!.response!.value).toBe('approve');
    expect(result.message).toContain('approve');
  });

  it('should auto-expire overdue sessions', async () => {
    await writeSession(createTestSession({
      sessionId: 'overdue-check',
      status: 'active',
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
    }));

    const result = await check_discussion({ sessionId: 'overdue-check' });
    expect(result.success).toBe(true);
    expect(result.session!.status).toBe('expired');
  });
});
