/**
 * Unit tests for Discussion Lifecycle CLI script.
 *
 * Issue #2221: check-expired + mark-disband + delete-state + edge cases.
 * These tests are fully offline — no GitHub API calls needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readStateFile,
  writeStateFile,
  type PRStateFile,
} from '../pr-scanner/scanner.js';
import {
  canSendDisbandRequest,
  findExpiredReviewing,
  markDisbandRequested,
  deleteState,
  type ExpiredPR,
} from './lifecycle.js';

// ---- Test helpers ----

let tempDir: string;

async function createTempDir(): Promise<string> {
  const dir = join('/tmp', `lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeStateFile(
  overrides: Partial<PRStateFile> & { prNumber: number },
): PRStateFile {
  const now = new Date();
  return {
    prNumber: overrides.prNumber,
    chatId: overrides.chatId ?? 'oc_test',
    state: overrides.state ?? 'reviewing',
    createdAt: overrides.createdAt ?? now.toISOString(),
    updatedAt: overrides.updatedAt ?? now.toISOString(),
    expiresAt:
      overrides.expiresAt ??
      new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
    disbandRequested: overrides.disbandRequested ?? null,
  };
}

// ---- Tests ----

describe('canSendDisbandRequest', () => {
  it('should return true when disbandRequested is null', () => {
    const state = makeStateFile({ prNumber: 1 });
    expect(canSendDisbandRequest(state)).toBe(true);
  });

  it('should return true when cooldown has passed (24h+)', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const state = makeStateFile({
      prNumber: 1,
      disbandRequested: '2026-04-09T12:00:00Z', // 24 hours ago
    });
    expect(canSendDisbandRequest(state, now)).toBe(true);
  });

  it('should return false when within cooldown period', () => {
    const now = new Date('2026-04-10T11:59:00Z');
    const state = makeStateFile({
      prNumber: 1,
      disbandRequested: '2026-04-09T12:00:00Z', // 23h 59m ago
    });
    expect(canSendDisbandRequest(state, now)).toBe(false);
  });

  it('should return false when disbandRequested is very recent', () => {
    const now = new Date('2026-04-10T12:00:00Z');
    const state = makeStateFile({
      prNumber: 1,
      disbandRequested: '2026-04-10T11:00:00Z', // 1 hour ago
    });
    expect(canSendDisbandRequest(state, now)).toBe(false);
  });
});

describe('findExpiredReviewing', () => {
  const now = new Date('2026-04-10T12:00:00Z');

  it('should return empty array when no expired PRs', () => {
    const states = [
      makeStateFile({
        prNumber: 1,
        state: 'reviewing',
        expiresAt: '2026-04-12T12:00:00Z', // future
      }),
    ];
    expect(findExpiredReviewing(states, now)).toEqual([]);
  });

  it('should find expired reviewing PRs', () => {
    const states = [
      makeStateFile({
        prNumber: 1,
        state: 'reviewing',
        expiresAt: '2026-04-08T12:00:00Z', // past
      }),
      makeStateFile({
        prNumber: 2,
        state: 'reviewing',
        expiresAt: '2026-04-12T12:00:00Z', // future
      }),
    ];
    const expired = findExpiredReviewing(states, now);
    expect(expired).toHaveLength(1);
    expect(expired[0].prNumber).toBe(1);
  });

  it('should exclude non-reviewing states even if expired', () => {
    const states = [
      makeStateFile({
        prNumber: 1,
        state: 'approved',
        expiresAt: '2026-04-08T12:00:00Z', // past
      }),
      makeStateFile({
        prNumber: 2,
        state: 'closed',
        expiresAt: '2026-04-08T12:00:00Z', // past
      }),
    ];
    expect(findExpiredReviewing(states, now)).toEqual([]);
  });

  it('should set canSendDisband correctly', () => {
    const states = [
      makeStateFile({
        prNumber: 1,
        state: 'reviewing',
        expiresAt: '2026-04-08T12:00:00Z',
        disbandRequested: null, // never requested → can send
      }),
      makeStateFile({
        prNumber: 2,
        state: 'reviewing',
        expiresAt: '2026-04-08T12:00:00Z',
        disbandRequested: '2026-04-10T00:00:00Z', // 12h ago → within cooldown
      }),
      makeStateFile({
        prNumber: 3,
        state: 'reviewing',
        expiresAt: '2026-04-08T12:00:00Z',
        disbandRequested: '2026-04-09T00:00:00Z', // 24h+ ago → can send
      }),
    ];
    const expired = findExpiredReviewing(states, now);
    expect(expired).toHaveLength(3);
    expect(expired[0].canSendDisband).toBe(true); // null → can send
    expect(expired[1].canSendDisband).toBe(false); // within cooldown
    expect(expired[2].canSendDisband).toBe(true); // cooldown passed
  });

  it('should return empty array for empty input', () => {
    expect(findExpiredReviewing([], now)).toEqual([]);
  });

  it('should handle multiple expired reviewing PRs', () => {
    const states = [
      makeStateFile({
        prNumber: 1,
        state: 'reviewing',
        expiresAt: '2026-04-08T12:00:00Z',
      }),
      makeStateFile({
        prNumber: 2,
        state: 'reviewing',
        expiresAt: '2026-04-09T12:00:00Z',
      }),
      makeStateFile({
        prNumber: 3,
        state: 'reviewing',
        expiresAt: '2026-04-10T12:00:00Z', // exactly now → not expired (< now would be strictly less)
      }),
    ];
    const expired = findExpiredReviewing(states, now);
    expect(expired).toHaveLength(2);
    expect(expired.map((e) => e.prNumber)).toEqual([1, 2]);
  });
});

describe('markDisbandRequested', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should update disbandRequested timestamp', async () => {
    const state = makeStateFile({
      prNumber: 10,
      state: 'reviewing',
      expiresAt: '2026-04-08T12:00:00Z',
    });
    await writeStateFile(tempDir, state);

    const now = new Date('2026-04-10T12:00:00Z');
    const updated = await markDisbandRequested(tempDir, 10, now);

    expect(updated.disbandRequested).toBe('2026-04-10T12:00:00.000Z');
    expect(updated.updatedAt).toBe('2026-04-10T12:00:00.000Z');
    expect(updated.state).toBe('reviewing');
  });

  it('should persist the update to disk', async () => {
    const state = makeStateFile({
      prNumber: 10,
      state: 'reviewing',
      expiresAt: '2026-04-08T12:00:00Z',
    });
    await writeStateFile(tempDir, state);

    const now = new Date('2026-04-10T12:00:00Z');
    await markDisbandRequested(tempDir, 10, now);

    const loaded = await readStateFile(tempDir, 10);
    expect(loaded).not.toBeNull();
    expect(loaded!.disbandRequested).toBe('2026-04-10T12:00:00.000Z');
  });

  it('should throw for non-existent PR', async () => {
    await expect(markDisbandRequested(tempDir, 999)).rejects.toThrow(
      'No state file found for PR #999',
    );
  });

  it('should throw for non-reviewing state', async () => {
    const state = makeStateFile({
      prNumber: 10,
      state: 'approved',
      expiresAt: '2026-04-08T12:00:00Z',
    });
    await writeStateFile(tempDir, state);

    await expect(markDisbandRequested(tempDir, 10)).rejects.toThrow(
      "Cannot mark disband for PR #10: state is 'approved', expected 'reviewing'",
    );
  });

  it('should allow overwriting previous disbandRequested', async () => {
    const state = makeStateFile({
      prNumber: 10,
      state: 'reviewing',
      expiresAt: '2026-04-08T12:00:00Z',
      disbandRequested: '2026-04-09T12:00:00Z',
    });
    await writeStateFile(tempDir, state);

    const now = new Date('2026-04-10T12:00:00Z');
    const updated = await markDisbandRequested(tempDir, 10, now);

    expect(updated.disbandRequested).toBe('2026-04-10T12:00:00.000Z');
  });
});

describe('deleteState', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should delete a state file', async () => {
    const state = makeStateFile({ prNumber: 10 });
    await writeStateFile(tempDir, state);

    await deleteState(tempDir, 10);

    const loaded = await readStateFile(tempDir, 10);
    expect(loaded).toBeNull();
  });

  it('should throw for non-existent PR', async () => {
    await expect(deleteState(tempDir, 999)).rejects.toThrow(
      'No state file found for PR #999',
    );
  });

  it('should not affect other state files', async () => {
    const state1 = makeStateFile({ prNumber: 1 });
    const state2 = makeStateFile({ prNumber: 2 });
    await writeStateFile(tempDir, state1);
    await writeStateFile(tempDir, state2);

    await deleteState(tempDir, 1);

    const loaded1 = await readStateFile(tempDir, 1);
    const loaded2 = await readStateFile(tempDir, 2);
    expect(loaded1).toBeNull();
    expect(loaded2).not.toBeNull();
  });
});
