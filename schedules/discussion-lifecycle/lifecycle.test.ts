/**
 * Unit tests for schedules/discussion-lifecycle/lifecycle.ts
 *
 * Tests all CLI actions, state file I/O, expiration detection,
 * disband notification cooldown, and disband execution.
 * No external API dependency — lark-cli/gh calls are mocked/skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStateFile,
  writeStateFile,
  listAllStateFiles,
  checkExpired,
  markDisband,
  shouldSendDisbandNotification,
  confirmDisband,
  type PrStateFile,
} from './lifecycle.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'lifecycle-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<PrStateFile> & { prNumber: number }): PrStateFile {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() - 1000).toISOString(); // Already expired by default
  return {
    chatId: 'oc_test',
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
    ...overrides,
  };
}

function makeFutureState(overrides: Partial<PrStateFile> & { prNumber: number }): PrStateFile {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h future
  return {
    chatId: 'oc_test',
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
    ...overrides,
  };
}

async function writeCorruptFile(dir: string, prNumber: number): Promise<void> {
  const filePath = join(dir, `pr-${prNumber}.json`);
  await writeFile(filePath, '{invalid json content', 'utf-8');
}

// ---------------------------------------------------------------------------
// readStateFile / writeStateFile
// ---------------------------------------------------------------------------

describe('readStateFile / writeStateFile', () => {
  it('writes and reads a state file correctly', async () => {
    const state = makeState({ prNumber: 100 });
    await writeStateFile(testDir, 100, state);
    const read = await readStateFile(testDir, 100);
    expect(read).toEqual(state);
  });

  it('returns null for non-existent file', async () => {
    const read = await readStateFile(testDir, 999);
    expect(read).toBeNull();
  });

  it('returns null for corrupt file', async () => {
    await writeCorruptFile(testDir, 200);
    const read = await readStateFile(testDir, 200);
    expect(read).toBeNull();
  });

  it('overwrites existing state file', async () => {
    const v1 = makeState({ prNumber: 42, state: 'reviewing' });
    await writeStateFile(testDir, 42, v1);

    const v2 = { ...v1, state: 'approved' as const, updatedAt: new Date().toISOString() };
    await writeStateFile(testDir, 42, v2);

    const read = await readStateFile(testDir, 42);
    expect(read?.state).toBe('approved');
  });

  it('preserves disbandRequested field', async () => {
    const state = makeState({
      prNumber: 55,
      disbandRequested: '2026-04-17T10:00:00Z',
    });
    await writeStateFile(testDir, 55, state);
    const read = await readStateFile(testDir, 55);
    expect(read?.disbandRequested).toBe('2026-04-17T10:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// listAllStateFiles
// ---------------------------------------------------------------------------

describe('listAllStateFiles', () => {
  it('returns empty array for non-existent directory', async () => {
    const result = await listAllStateFiles(join(testDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('lists all valid state files', async () => {
    await writeStateFile(testDir, 10, makeState({ prNumber: 10 }));
    await writeStateFile(testDir, 20, makeState({ prNumber: 20 }));
    const result = await listAllStateFiles(testDir);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.prNumber).sort()).toEqual([10, 20]);
  });

  it('skips corrupt files', async () => {
    await writeStateFile(testDir, 10, makeState({ prNumber: 10 }));
    await writeCorruptFile(testDir, 20);
    const result = await listAllStateFiles(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(10);
  });

  it('skips non-matching file names', async () => {
    await writeStateFile(testDir, 10, makeState({ prNumber: 10 }));
    await writeFile(join(testDir, 'other.json'), '{}', 'utf-8');
    await writeFile(join(testDir, 'pr-abc.json'), '{}', 'utf-8');
    const result = await listAllStateFiles(testDir);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// shouldSendDisbandNotification
// ---------------------------------------------------------------------------

describe('shouldSendDisbandNotification', () => {
  it('returns true when disbandRequested is null', () => {
    const state = makeState({ prNumber: 1, disbandRequested: null });
    expect(shouldSendDisbandNotification(state, new Date().toISOString())).toBe(true);
  });

  it('returns true when disbandRequested is undefined', () => {
    const state = makeState({ prNumber: 1 });
    delete (state as Record<string, unknown>).disbandRequested;
    expect(shouldSendDisbandNotification(state, new Date().toISOString())).toBe(true);
  });

  it('returns true when 24h have elapsed since last notification', () => {
    const now = new Date();
    const lastNotify = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h ago
    const state = makeState({
      prNumber: 1,
      disbandRequested: lastNotify.toISOString(),
    });
    expect(shouldSendDisbandNotification(state, now.toISOString())).toBe(true);
  });

  it('returns false when less than 24h since last notification', () => {
    const now = new Date();
    const lastNotify = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12h ago
    const state = makeState({
      prNumber: 1,
      disbandRequested: lastNotify.toISOString(),
    });
    expect(shouldSendDisbandNotification(state, now.toISOString())).toBe(false);
  });

  it('returns false when exactly 0h since notification', () => {
    const now = new Date().toISOString();
    const state = makeState({
      prNumber: 1,
      disbandRequested: now,
    });
    expect(shouldSendDisbandNotification(state, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkExpired
// ---------------------------------------------------------------------------

describe('checkExpired', () => {
  it('returns empty array when no state files exist', async () => {
    const result = await checkExpired(join(testDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('detects expired reviewing PRs', async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    await writeStateFile(testDir, 100, makeState({
      prNumber: 100,
      expiresAt: pastExpiry,
      state: 'reviewing',
    }));
    const result = await checkExpired(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(100);
    expect(result[0].shouldNotify).toBe(true);
  });

  it('excludes non-reviewing PRs', async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    await writeStateFile(testDir, 100, makeState({
      prNumber: 100,
      expiresAt: pastExpiry,
      state: 'approved',
    }));
    await writeStateFile(testDir, 101, makeState({
      prNumber: 101,
      expiresAt: pastExpiry,
      state: 'closed',
    }));
    const result = await checkExpired(testDir);
    expect(result).toHaveLength(0);
  });

  it('excludes non-expired PRs', async () => {
    await writeStateFile(testDir, 100, makeFutureState({ prNumber: 100 }));
    const result = await checkExpired(testDir);
    expect(result).toHaveLength(0);
  });

  it('sets shouldNotify=false when 24h cooldown not elapsed', async () => {
    const now = new Date();
    const pastExpiry = new Date(now.getTime() - 1000).toISOString();
    const recentNotify = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    await writeStateFile(testDir, 100, makeState({
      prNumber: 100,
      expiresAt: pastExpiry,
      disbandRequested: recentNotify,
    }));
    const result = await checkExpired(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].shouldNotify).toBe(false);
  });

  it('sets shouldNotify=true when 24h cooldown elapsed', async () => {
    const now = new Date();
    const pastExpiry = new Date(now.getTime() - 1000).toISOString();
    const oldNotify = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    await writeStateFile(testDir, 100, makeState({
      prNumber: 100,
      expiresAt: pastExpiry,
      disbandRequested: oldNotify,
    }));
    const result = await checkExpired(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].shouldNotify).toBe(true);
  });

  it('returns correct chatId and expiresAt for expired PRs', async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    await writeStateFile(testDir, 42, makeState({
      prNumber: 42,
      chatId: 'oc_specific_chat',
      expiresAt: pastExpiry,
    }));
    const result = await checkExpired(testDir);
    expect(result[0].chatId).toBe('oc_specific_chat');
    expect(result[0].expiresAt).toBe(pastExpiry);
  });

  it('handles mix of expired and non-expired PRs', async () => {
    await writeStateFile(testDir, 100, makeState({ prNumber: 100 })); // expired reviewing
    await writeStateFile(testDir, 101, makeFutureState({ prNumber: 101 })); // future reviewing
    await writeStateFile(testDir, 102, makeState({ prNumber: 102, state: 'approved' })); // expired approved
    const result = await checkExpired(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// markDisband
// ---------------------------------------------------------------------------

describe('markDisband', () => {
  it('updates disbandRequested timestamp', async () => {
    await writeStateFile(testDir, 100, makeState({ prNumber: 100, disbandRequested: null }));
    const result = await markDisband(testDir, 100);
    expect(result.disbandRequested).not.toBeNull();
    expect(typeof result.disbandRequested).toBe('string');
  });

  it('updates updatedAt timestamp', async () => {
    const original = makeState({ prNumber: 100 });
    await writeStateFile(testDir, 100, original);
    await new Promise((r) => setTimeout(r, 10));
    const result = await markDisband(testDir, 100);
    expect(new Date(result.updatedAt).getTime()).toBeGreaterThan(
      new Date(original.updatedAt).getTime(),
    );
  });

  it('persists to disk', async () => {
    await writeStateFile(testDir, 100, makeState({ prNumber: 100 }));
    await markDisband(testDir, 100);
    const read = await readStateFile(testDir, 100);
    expect(read?.disbandRequested).not.toBeNull();
  });

  it('preserves other fields', async () => {
    const original = makeState({ prNumber: 100, chatId: 'oc_abc' });
    await writeStateFile(testDir, 100, original);
    const result = await markDisband(testDir, 100);
    expect(result.chatId).toBe('oc_abc');
    expect(result.prNumber).toBe(100);
    expect(result.state).toBe('reviewing');
  });

  it('throws when state file does not exist', async () => {
    await expect(markDisband(testDir, 999)).rejects.toThrow(
      'No state file found for PR #999',
    );
  });

  it('overwrites previous disbandRequested', async () => {
    const state = makeState({
      prNumber: 100,
      disbandRequested: '2026-04-16T00:00:00Z',
    });
    await writeStateFile(testDir, 100, state);
    const result = await markDisband(testDir, 100);
    expect(result.disbandRequested).not.toBe('2026-04-16T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// confirmDisband
// ---------------------------------------------------------------------------

describe('confirmDisband', () => {
  it('deletes state file for reviewing PR (skipLark + skipGh)', async () => {
    await writeStateFile(testDir, 100, makeState({ prNumber: 100, state: 'reviewing' }));
    const result = await confirmDisband(testDir, 100, 'test/repo', { skipLark: true, skipGh: true });
    expect(result.success).toBe(true);

    // State file should be deleted
    const read = await readStateFile(testDir, 100);
    expect(read).toBeNull();
  });

  it('rejects disband for non-reviewing state', async () => {
    await writeStateFile(testDir, 100, makeState({ prNumber: 100, state: 'approved' }));
    const result = await confirmDisband(testDir, 100, 'test/repo', { skipLark: true, skipGh: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('expected \'reviewing\'');

    // State file should still exist
    const read = await readStateFile(testDir, 100);
    expect(read).not.toBeNull();
  });

  it('rejects disband for closed state', async () => {
    await writeStateFile(testDir, 100, makeState({ prNumber: 100, state: 'closed' }));
    const result = await confirmDisband(testDir, 100, 'test/repo', { skipLark: true, skipGh: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('expected \'reviewing\'');
  });

  it('returns error when state file does not exist', async () => {
    const result = await confirmDisband(testDir, 999, 'test/repo', { skipLark: true, skipGh: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No state file found');
  });

  it('removes state file even when gh fails', async () => {
    // Skip lark but let gh fail naturally (nonexistent repo)
    await writeStateFile(testDir, 100, makeState({ prNumber: 100, state: 'reviewing' }));
    const result = await confirmDisband(testDir, 100, 'nonexistent/repo', { skipLark: true });
    // gh will fail (repo doesn't exist), but file should still be deleted
    const read = await readStateFile(testDir, 100);
    expect(read).toBeNull();
    // Should report partial failure
    expect(result.success).toBe(false);
    expect(result.error).toContain('label-remove');
  });
});
