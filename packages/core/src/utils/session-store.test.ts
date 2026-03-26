/**
 * Tests for temporary session store utilities.
 *
 * Issue #1391: Temporary Session Management System (Simplified Design).
 *
 * All tests use vi.spyOn on sessionFs to intercept file I/O — zero real disk side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isValidSessionId,
  getSessionDir,
  getSessionFilePath,
  createSession,
  readSession,
  updateSession,
  deleteSession,
  activateSession,
  respondToSession,
  expireSession,
  listSessions,
  findSessionByMessageId,
  cleanupExpiredSessions,
  sessionFs,
  type SessionFile,
} from './session-store.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const BASE_DIR = '/tmp/test-workspace';

function makeSession(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    id: 'test-session',
    status: 'pending',
    chatId: null,
    messageId: null,
    expiresAt: null,
    updatedAt: '2026-03-27T00:00:00.000Z',
    createdAt: '2026-03-27T00:00:00.000Z',
    createGroup: null,
    message: null,
    options: null,
    context: null,
    response: null,
    ...overrides,
  };
}

/**
 * Helper to set up the mock file system with session files.
 */
function mockFiles(files: Record<string, SessionFile>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(sessionFs, 'readFile').mockImplementation(async (filePath: any) => {
    if (filePath in files) {
      return JSON.stringify(files[filePath], null, 2);
    }
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(sessionFs, 'readdir').mockImplementation(async (dirPath: any) => {
    if (dirPath === getSessionDir(BASE_DIR)) {
      return Object.keys(files).map((f) => f.split('/').pop()!) as any;
    }
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

// ---------------------------------------------------------------------------
// isValidSessionId
// ---------------------------------------------------------------------------

describe('isValidSessionId', () => {
  it('accepts alphanumeric IDs', () => {
    expect(isValidSessionId('pr123')).toBe(true);
    expect(isValidSessionId('abc')).toBe(true);
  });

  it('accepts hyphens and underscores', () => {
    expect(isValidSessionId('pr-123')).toBe(true);
    expect(isValidSessionId('offline_deploy')).toBe(true);
    expect(isValidSessionId('my-session_v2')).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false);
    expect(isValidSessionId('../../config')).toBe(false);
    expect(isValidSessionId('./hidden')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects strings starting with non-alphanumeric', () => {
    expect(isValidSessionId('-start-with-dash')).toBe(false);
    expect(isValidSessionId('_start-with-underscore')).toBe(false);
  });

  it('rejects strings with slashes', () => {
    expect(isValidSessionId('foo/bar')).toBe(false);
    expect(isValidSessionId('foo\\bar')).toBe(false);
  });

  it('rejects strings with special characters', () => {
    expect(isValidSessionId('session with spaces')).toBe(false);
    expect(isValidSessionId('session.dot')).toBe(false); // dots not allowed
    expect(isValidSessionId('session!')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSessionDir / getSessionFilePath
// ---------------------------------------------------------------------------

describe('getSessionDir', () => {
  it('returns the correct directory path', () => {
    expect(getSessionDir(BASE_DIR)).toBe(`${BASE_DIR}/temporary-sessions`);
  });
});

describe('getSessionFilePath', () => {
  it('returns the correct file path for a valid session ID', () => {
    expect(getSessionFilePath('pr-123', BASE_DIR)).toBe(`${BASE_DIR}/temporary-sessions/pr-123.json`);
  });

  it('throws for invalid session ID', () => {
    expect(() => getSessionFilePath('../etc/passwd', BASE_DIR)).toThrow('Invalid session ID');
    expect(() => getSessionFilePath('', BASE_DIR)).toThrow('Invalid session ID');
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    writeSpy = vi.spyOn(sessionFs, 'writeFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a session with correct defaults', async () => {
    const session = await createSession('pr-123', { message: 'test' }, BASE_DIR);

    expect(session.id).toBe('pr-123');
    expect(session.status).toBe('pending');
    expect(session.chatId).toBeNull();
    expect(session.messageId).toBeNull();
    expect(session.response).toBeNull();
    expect(session.message).toBe('test');
    expect(session.createdAt).toBeDefined();
    expect(session.updatedAt).toBeDefined();
  });

  it('creates a session with full configuration', async () => {
    const session = await createSession(
      'offline-deploy',
      {
        createGroup: { name: 'Deploy Review', members: ['ou_user1'] },
        message: 'Deploy?',
        options: [
          { value: 'approve', text: '✅ Approve' },
          { value: 'reject', text: '❌ Reject' },
        ],
        context: { deployId: 'dep-42' },
        expiresAt: '2026-03-28T00:00:00Z',
      },
      BASE_DIR,
    );

    expect(session.createGroup).toEqual({ name: 'Deploy Review', members: ['ou_user1'] });
    expect(session.options).toHaveLength(2);
    expect(session.context).toEqual({ deployId: 'dep-42' });
    expect(session.expiresAt).toBe('2026-03-28T00:00:00Z');
  });

  it('uses exclusive write flag (wx) to prevent overwriting', async () => {
    await createSession('unique-session', {}, BASE_DIR);

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('unique-session.json'),
      expect.any(String),
      { flag: 'wx' },
    );
  });

  it('throws for invalid session ID', async () => {
    await expect(createSession('../etc/passwd', {}, BASE_DIR)).rejects.toThrow('Invalid session ID');
  });

  it('propagates file system errors (e.g., file already exists)', async () => {
    const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    writeSpy.mockRejectedValue(err);

    await expect(createSession('existing', {}, BASE_DIR)).rejects.toThrow('EEXIST');
  });
});

// ---------------------------------------------------------------------------
// readSession
// ---------------------------------------------------------------------------

describe('readSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the session when file exists', async () => {
    const session = makeSession({ id: 'read-test' });
    vi.spyOn(sessionFs, 'readFile').mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await readSession('read-test', BASE_DIR);
    expect(result).toBeDefined();
    expect(result!.id).toBe('read-test');
  });

  it('returns undefined when file does not exist', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.spyOn(sessionFs, 'readFile').mockRejectedValue(err);

    const result = await readSession('nonexistent', BASE_DIR);
    expect(result).toBeUndefined();
  });

  it('throws for non-ENOENT errors', async () => {
    vi.spyOn(sessionFs, 'readFile').mockRejectedValue(new Error('Permission denied'));

    await expect(readSession('read-test', BASE_DIR)).rejects.toThrow('Permission denied');
  });
});

// ---------------------------------------------------------------------------
// updateSession
// ---------------------------------------------------------------------------

describe('updateSession', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readSpy: any;

  beforeEach(() => {
    readSpy = vi.spyOn(sessionFs, 'readFile');
    vi.spyOn(sessionFs, 'writeFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies updates and sets updatedAt', async () => {
    const session = makeSession({ id: 'update-test', status: 'pending' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await updateSession(
      'update-test',
      BASE_DIR,
      () => ({ status: 'active', chatId: 'oc_new_chat' }),
    );

    expect(result.success).toBe(true);
    expect(result.session!.status).toBe('active');
    expect(result.session!.chatId).toBe('oc_new_chat');
    expect(result.session!.updatedAt).not.toBe(session.updatedAt);
  });

  it('preserves immutable fields (id, createdAt)', async () => {
    const session = makeSession({ id: 'immutable-test', createdAt: '2026-01-01T00:00:00Z' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await updateSession(
      'immutable-test',
      BASE_DIR,
      () => ({ id: 'hacked', createdAt: '2020-01-01T00:00:00Z' }),
    );

    expect(result.session!.id).toBe('immutable-test');
    expect(result.session!.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('fails on concurrency conflict when expectedUpdatedAt does not match', async () => {
    const session = makeSession({ id: 'concurrent-test', updatedAt: '2026-03-27T10:00:00Z' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await updateSession(
      'concurrent-test',
      BASE_DIR,
      () => ({ status: 'active' }),
      '2026-03-27T09:00:00Z', // stale expectedUpdatedAt
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Concurrency conflict');
  });

  it('succeeds when expectedUpdatedAt matches', async () => {
    const session = makeSession({ id: 'concurrent-ok', updatedAt: '2026-03-27T10:00:00Z' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await updateSession(
      'concurrent-ok',
      BASE_DIR,
      () => ({ status: 'active' }),
      '2026-03-27T10:00:00Z',
    );

    expect(result.success).toBe(true);
  });

  it('returns error when session not found', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readSpy.mockRejectedValue(err);

    const result = await updateSession(
      'nonexistent',
      BASE_DIR,
      () => ({ status: 'active' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error when updater throws', async () => {
    const session = makeSession({ id: 'error-test', status: 'expired' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await updateSession(
      'error-test',
      BASE_DIR,
      () => {
        throw new Error('Cannot activate expired session');
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot activate expired session');
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when file is deleted', async () => {
    vi.spyOn(sessionFs, 'unlink').mockResolvedValue(undefined);

    const result = await deleteSession('delete-test', BASE_DIR);
    expect(result).toBe(true);
  });

  it('returns false when file does not exist', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.spyOn(sessionFs, 'unlink').mockRejectedValue(err);

    const result = await deleteSession('nonexistent', BASE_DIR);
    expect(result).toBe(false);
  });

  it('throws for non-ENOENT errors', async () => {
    vi.spyOn(sessionFs, 'unlink').mockRejectedValue(new Error('Permission denied'));

    await expect(deleteSession('delete-test', BASE_DIR)).rejects.toThrow('Permission denied');
  });
});

// ---------------------------------------------------------------------------
// activateSession
// ---------------------------------------------------------------------------

describe('activateSession', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readSpy: any;

  beforeEach(() => {
    readSpy = vi.spyOn(sessionFs, 'readFile');
    vi.spyOn(sessionFs, 'writeFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('activates a pending session', async () => {
    const session = makeSession({ id: 'activate-test', status: 'pending' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await activateSession(
      'activate-test',
      BASE_DIR,
      'oc_chat_123',
      'om_msg_456',
    );

    expect(result.success).toBe(true);
    expect(result.session!.status).toBe('active');
    expect(result.session!.chatId).toBe('oc_chat_123');
    expect(result.session!.messageId).toBe('om_msg_456');
  });

  it('fails for non-pending session', async () => {
    const session = makeSession({ id: 'already-active', status: 'active' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await activateSession(
      'already-active',
      BASE_DIR,
      'oc_chat_123',
      'om_msg_456',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('only "pending" sessions');
  });

  it('fails for expired session', async () => {
    const session = makeSession({ id: 'already-expired', status: 'expired' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await activateSession(
      'already-expired',
      BASE_DIR,
      'oc_chat_123',
      'om_msg_456',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('only "pending" sessions');
  });
});

// ---------------------------------------------------------------------------
// respondToSession
// ---------------------------------------------------------------------------

describe('respondToSession', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readSpy: any;

  beforeEach(() => {
    readSpy = vi.spyOn(sessionFs, 'readFile');
    vi.spyOn(sessionFs, 'writeFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records response and transitions to expired', async () => {
    const session = makeSession({ id: 'respond-test', status: 'active' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const response = {
      selectedValue: 'merge',
      responder: 'ou_developer',
      repliedAt: '2026-03-27T14:30:00Z',
    };

    const result = await respondToSession('respond-test', BASE_DIR, response);

    expect(result.success).toBe(true);
    expect(result.session!.status).toBe('expired');
    expect(result.session!.response).toEqual(response);
  });

  it('fails for pending session', async () => {
    const session = makeSession({ id: 'pending-respond', status: 'pending' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await respondToSession('pending-respond', BASE_DIR, {
      selectedValue: 'merge',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('only "active" sessions');
  });

  it('fails for already expired session', async () => {
    const session = makeSession({ id: 'double-expire', status: 'expired' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await respondToSession('double-expire', BASE_DIR, {
      selectedValue: 'merge',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('only "active" sessions');
  });
});

// ---------------------------------------------------------------------------
// expireSession
// ---------------------------------------------------------------------------

describe('expireSession', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readSpy: any;

  beforeEach(() => {
    readSpy = vi.spyOn(sessionFs, 'readFile');
    vi.spyOn(sessionFs, 'writeFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expires an active session (timeout)', async () => {
    const session = makeSession({ id: 'timeout-test', status: 'active' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await expireSession('timeout-test', BASE_DIR);

    expect(result.success).toBe(true);
    expect(result.session!.status).toBe('expired');
    expect(result.session!.response).toBeNull(); // No response for timeout
  });

  it('fails for pending session', async () => {
    const session = makeSession({ id: 'pending-expire', status: 'pending' });
    readSpy.mockResolvedValue(JSON.stringify(session, null, 2));

    const result = await expireSession('pending-expire', BASE_DIR);

    expect(result.success).toBe(false);
    expect(result.error).toContain('only "active" sessions');
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('listSessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all sessions when no filter', async () => {
    const sessions = {
      [getSessionFilePath('s1', BASE_DIR)]: makeSession({ id: 's1', status: 'pending' }),
      [getSessionFilePath('s2', BASE_DIR)]: makeSession({ id: 's2', status: 'active' }),
      [getSessionFilePath('s3', BASE_DIR)]: makeSession({ id: 's3', status: 'expired' }),
    };
    mockFiles(sessions);

    const result = await listSessions(BASE_DIR);
    expect(result).toHaveLength(3);
  });

  it('filters by status', async () => {
    const sessions = {
      [getSessionFilePath('s1', BASE_DIR)]: makeSession({ id: 's1', status: 'pending' }),
      [getSessionFilePath('s2', BASE_DIR)]: makeSession({ id: 's2', status: 'active' }),
      [getSessionFilePath('s3', BASE_DIR)]: makeSession({ id: 's3', status: 'expired' }),
    };
    mockFiles(sessions);

    const result = await listSessions(BASE_DIR, { status: 'active' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s2');
  });

  it('returns empty array when directory does not exist (no side effect)', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.spyOn(sessionFs, 'readdir').mockRejectedValue(err);
    const writeSpy = vi.spyOn(sessionFs, 'writeFile');

    const result = await listSessions(BASE_DIR);
    expect(result).toEqual([]);
    // Verify no directory creation was attempted
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('skips malformed JSON files', async () => {
    const sessionDir = getSessionDir(BASE_DIR);
    vi.spyOn(sessionFs, 'readdir').mockResolvedValue(['valid.json', 'invalid.json'] as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(sessionFs, 'readFile').mockImplementation(async (filePath: any) => {
      if (filePath === `${sessionDir}/valid.json`) {
        return JSON.stringify(makeSession({ id: 'valid' }), null, 2);
      }
      return 'not json {{{';
    });

    const result = await listSessions(BASE_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('skips non-JSON files', async () => {
    vi.spyOn(sessionFs, 'readdir').mockResolvedValue(['session1.json', 'readme.txt', '.gitkeep'] as any);

    const validSession = makeSession({ id: 'session1' });
    vi.spyOn(sessionFs, 'readFile').mockResolvedValue(
      JSON.stringify(validSession, null, 2),
    );

    const result = await listSessions(BASE_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('session1');
  });
});

// ---------------------------------------------------------------------------
// findSessionByMessageId
// ---------------------------------------------------------------------------

describe('findSessionByMessageId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds a session by message ID', async () => {
    const sessions = {
      [getSessionFilePath('s1', BASE_DIR)]: makeSession({
        id: 's1',
        status: 'active',
        messageId: 'om_target_msg',
      }),
      [getSessionFilePath('s2', BASE_DIR)]: makeSession({
        id: 's2',
        status: 'active',
        messageId: 'om_other_msg',
      }),
    };
    mockFiles(sessions);

    const result = await findSessionByMessageId('om_target_msg', BASE_DIR);
    expect(result).toBeDefined();
    expect(result!.id).toBe('s1');
  });

  it('returns undefined when no session matches', async () => {
    const sessions = {
      [getSessionFilePath('s1', BASE_DIR)]: makeSession({ id: 's1', messageId: 'om_other' }),
    };
    mockFiles(sessions);

    const result = await findSessionByMessageId('om_nonexistent', BASE_DIR);
    expect(result).toBeUndefined();
  });

  it('returns undefined when session directory does not exist', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.spyOn(sessionFs, 'readdir').mockRejectedValue(err);

    const result = await findSessionByMessageId('om_any', BASE_DIR);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredSessions
// ---------------------------------------------------------------------------

describe('cleanupExpiredSessions', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let unlinkSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T00:00:00Z'));
    unlinkSpy = vi.spyOn(sessionFs, 'unlink').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deletes expired sessions older than max age', async () => {
    const recentExpired = makeSession({
      id: 'recent',
      status: 'expired',
      updatedAt: '2026-03-27T12:00:00Z', // 12 hours ago
    });
    const oldExpired = makeSession({
      id: 'old',
      status: 'expired',
      updatedAt: '2026-03-26T00:00:00Z', // 48 hours ago
    });
    const activeSession = makeSession({
      id: 'active',
      status: 'active',
      updatedAt: '2026-03-26T00:00:00Z',
    });

    mockFiles({
      [getSessionFilePath('recent', BASE_DIR)]: recentExpired,
      [getSessionFilePath('old', BASE_DIR)]: oldExpired,
      [getSessionFilePath('active', BASE_DIR)]: activeSession,
    });

    const cleaned = await cleanupExpiredSessions(BASE_DIR, 24 * 60 * 60 * 1000);
    expect(cleaned).toBe(1);
    // Only 'old' should be deleted
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledWith(
      getSessionFilePath('old', BASE_DIR),
    );
  });

  it('returns 0 when no expired sessions exist', async () => {
    const sessions = {
      [getSessionFilePath('active', BASE_DIR)]: makeSession({ id: 'active', status: 'active' }),
    };
    mockFiles(sessions);

    const cleaned = await cleanupExpiredSessions(BASE_DIR);
    expect(cleaned).toBe(0);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('returns 0 when session directory does not exist', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.spyOn(sessionFs, 'readdir').mockRejectedValue(err);

    const cleaned = await cleanupExpiredSessions(BASE_DIR);
    expect(cleaned).toBe(0);
  });
});
