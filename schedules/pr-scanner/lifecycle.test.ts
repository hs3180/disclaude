/**
 * schedules/pr-scanner/lifecycle.test.ts
 *
 * Unit tests for PR discussion lifecycle management.
 * Covers check-expired, mark-disband, cleanup, and 24h dedup logic.
 *
 * Related: #2221
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readdir,
  writeFile,
  mkdir,
  rm,
  readFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  parseStateFile,
  actionCheckExpired,
  actionMarkDisband,
  actionCleanup,
  nowISO,
  stateFilePath,
  DISBAND_NOTIFY_INTERVAL_HOURS,
  DEFAULT_DIR,
  type PRStateFile,
} from './lifecycle.js';

// ---- Test helpers ----

const TEST_DIR = resolve('.temp-chats-test-lifecycle');

function makeStateFile(overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = nowISO();
  return {
    prNumber: 1,
    chatId: 'oc_test123',
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    // Default: not expired (far future)
    expiresAt: '2099-12-31T23:59:59Z',
    disbandRequested: null,
    ...overrides,
  };
}

/** Create an expired state file (expiresAt in the past) */
function makeExpiredStateFile(overrides: Partial<PRStateFile> = {}): PRStateFile {
  // Set expiresAt to 1 hour ago (guaranteed to be in the past regardless of test time)
  const past = new Date();
  past.setUTCHours(past.getUTCHours() - 1);
  const expiresAtStr = past.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const created = new Date(past);
  created.setUTCHours(created.getUTCHours() - 48);
  const createdAtStr = created.toISOString().replace(/\.\d{3}Z$/, 'Z');

  return makeStateFile({
    createdAt: createdAtStr,
    updatedAt: createdAtStr,
    expiresAt: expiresAtStr,
    ...overrides,
  });
}

async function writeStateFile(state: PRStateFile): Promise<void> {
  const filePath = resolve(TEST_DIR, `pr-${state.prNumber}.json`);
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ---- Tests ----

describe('parseStateFile', () => {
  it('parses a valid state file with disbandRequested = null', () => {
    const state = makeStateFile({ prNumber: 42 });
    const json = JSON.stringify(state);
    const result = parseStateFile(json, 'test.json');
    expect(result.prNumber).toBe(42);
    expect(result.disbandRequested).toBeNull();
  });

  it('parses a valid state file with disbandRequested as ISO string', () => {
    const state = makeStateFile({
      prNumber: 42,
      disbandRequested: '2026-04-20T12:00:00Z',
    });
    const json = JSON.stringify(state);
    const result = parseStateFile(json, 'test.json');
    expect(result.disbandRequested).toBe('2026-04-20T12:00:00Z');
  });

  it('rejects invalid disbandRequested (boolean)', () => {
    const state = makeStateFile() as Record<string, unknown>;
    state.disbandRequested = true;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('disbandRequested');
  });

  it('rejects invalid disbandRequested (number)', () => {
    const state = makeStateFile() as Record<string, unknown>;
    state.disbandRequested = 123;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('disbandRequested');
  });

  it('rejects invalid disbandRequested (wrong date format)', () => {
    const state = makeStateFile({
      disbandRequested: '2026-04-20 12:00:00',
    });
    // Override to invalid format
    const obj = JSON.parse(JSON.stringify(state));
    obj.disbandRequested = '2026-04-20 12:00:00';
    expect(() => parseStateFile(JSON.stringify(obj), 'test.json')).toThrow('disbandRequested');
  });

  it('rejects missing prNumber', () => {
    const state = makeStateFile();
    delete (state as Record<string, unknown>).prNumber;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('prNumber');
  });

  it('rejects invalid state', () => {
    const state = makeStateFile() as Record<string, unknown>;
    state.state = 'invalid';
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('state');
  });
});

describe('actionCheckExpired', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('returns empty array when no state files', async () => {
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired).toEqual([]);
  });

  it('returns empty array when no expired PRs', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired).toEqual([]);
  });

  it('detects expired reviewing PRs', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1 }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired).toHaveLength(1);
    expect(expired[0].prNumber).toBe(1);
    expect(expired[0].shouldNotify).toBe(true);
  });

  it('skips non-reviewing expired PRs', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, state: 'approved' }));
    await writeStateFile(makeExpiredStateFile({ prNumber: 2, state: 'closed' }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired).toEqual([]);
  });

  it('sets shouldNotify=true when disbandRequested is null', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, disbandRequested: null }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired[0].shouldNotify).toBe(true);
  });

  it('sets shouldNotify=true when 24h have passed since last notification', async () => {
    // Last notified more than 24h ago
    const lastNotify = new Date();
    lastNotify.setUTCHours(lastNotify.getUTCHours() - 25);
    const notifyStr = lastNotify.toISOString().replace(/\.\d{3}Z$/, 'Z');

    await writeStateFile(makeExpiredStateFile({ prNumber: 1, disbandRequested: notifyStr }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired[0].shouldNotify).toBe(true);
  });

  it('sets shouldNotify=false when within 24h of last notification', async () => {
    // Last notified less than 24h ago
    const lastNotify = new Date();
    lastNotify.setUTCHours(lastNotify.getUTCHours() - 1);
    const notifyStr = lastNotify.toISOString().replace(/\.\d{3}Z$/, 'Z');

    await writeStateFile(makeExpiredStateFile({ prNumber: 1, disbandRequested: notifyStr }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired[0].shouldNotify).toBe(false);
  });

  it('handles multiple expired PRs with mixed notification states', async () => {
    const recentNotify = new Date();
    recentNotify.setUTCHours(recentNotify.getUTCHours() - 1);
    const recentStr = recentNotify.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const oldNotify = new Date();
    oldNotify.setUTCHours(oldNotify.getUTCHours() - 30);
    const oldStr = oldNotify.toISOString().replace(/\.\d{3}Z$/, 'Z');

    await writeStateFile(makeExpiredStateFile({ prNumber: 1, disbandRequested: null }));         // shouldNotify: true
    await writeStateFile(makeExpiredStateFile({ prNumber: 2, disbandRequested: recentStr }));    // shouldNotify: false
    await writeStateFile(makeExpiredStateFile({ prNumber: 3, disbandRequested: oldStr }));       // shouldNotify: true
    await writeStateFile(makeStateFile({ prNumber: 4 }));                                         // not expired

    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired).toHaveLength(3);
    expect(expired.find((e) => e.prNumber === 1)?.shouldNotify).toBe(true);
    expect(expired.find((e) => e.prNumber === 2)?.shouldNotify).toBe(false);
    expect(expired.find((e) => e.prNumber === 3)?.shouldNotify).toBe(true);
  });

  it('includes chatId in result', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, chatId: 'oc_abc' }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired[0].chatId).toBe('oc_abc');
  });

  it('handles null chatId', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, chatId: null }));
    const expired = await actionCheckExpired(TEST_DIR);
    expect(expired[0].chatId).toBeNull();
  });
});

describe('actionMarkDisband', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('sets disbandRequested to current timestamp', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, disbandRequested: null }));
    const updated = await actionMarkDisband(1, TEST_DIR);

    expect(updated.disbandRequested).not.toBeNull();
    expect(updated.disbandRequested).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('updates updatedAt timestamp', async () => {
    const original = makeExpiredStateFile({ prNumber: 1 });
    original.updatedAt = '2026-01-01T00:00:00Z';
    await writeStateFile(original);

    const updated = await actionMarkDisband(1, TEST_DIR);
    expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00Z');
  });

  it('persists changes to disk', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1 }));
    await actionMarkDisband(1, TEST_DIR);

    const filePath = stateFilePath(1, TEST_DIR);
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.disbandRequested).not.toBeNull();
  });

  it('throws if state file not found', async () => {
    await expect(actionMarkDisband(999, TEST_DIR)).rejects.toThrow('not found');
  });

  it('throws if PR state is not reviewing', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, state: 'approved' }));
    await expect(actionMarkDisband(1, TEST_DIR)).rejects.toThrow('state is \'approved\'');
  });

  it('can update disbandRequested multiple times', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, disbandRequested: null }));
    const first = await actionMarkDisband(1, TEST_DIR);

    // Both calls should succeed; timestamps may be identical within the same second
    const second = await actionMarkDisband(1, TEST_DIR);

    // Both should have valid non-null timestamps
    expect(first.disbandRequested).not.toBeNull();
    expect(second.disbandRequested).not.toBeNull();
    // Second call should update updatedAt (even if disbandRequested is same second)
    expect(second.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('actionCleanup', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('deletes the state file', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1 }));
    const result = await actionCleanup(1, TEST_DIR, 'test/repo');

    expect(result.fileDeleted).toBe(true);
    expect(result.prNumber).toBe(1);

    // Verify file is gone
    const filePath = stateFilePath(1, TEST_DIR);
    await expect(readFile(filePath, 'utf-8')).rejects.toThrow('ENOENT');
  });

  it('throws if state file not found', async () => {
    await expect(actionCleanup(999, TEST_DIR, 'test/repo')).rejects.toThrow('not found');
  });

  it('throws if PR state is not reviewing', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1, state: 'approved' }));
    await expect(actionCleanup(1, TEST_DIR, 'test/repo')).rejects.toThrow('state is \'approved\'');
  });

  it('reports labelRemoved as false when gh command fails', async () => {
    await writeStateFile(makeExpiredStateFile({ prNumber: 1 }));
    // Using a non-existent repo will cause gh to fail
    const result = await actionCleanup(1, TEST_DIR, 'nonexistent/repo-that-does-not-exist');

    expect(result.fileDeleted).toBe(true);
    expect(result.labelRemoved).toBe(false);
  });
});

describe('DISBAND_NOTIFY_INTERVAL_HOURS', () => {
  it('is 24 hours', () => {
    expect(DISBAND_NOTIFY_INTERVAL_HOURS).toBe(24);
  });
});

describe('nowISO', () => {
  it('returns UTC Z-suffix format', () => {
    const result = nowISO();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('stateFilePath', () => {
  it('returns correct path with default dir', () => {
    const path = stateFilePath(123);
    expect(path).toContain(DEFAULT_DIR);
    expect(path).toContain('pr-123.json');
  });

  it('returns correct path with custom dir', () => {
    const path = stateFilePath(456, '/custom/dir');
    expect(path).toBe('/custom/dir/pr-456.json');
  });
});
