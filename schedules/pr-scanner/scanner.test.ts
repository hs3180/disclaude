/**
 * Unit tests for PR Scanner state management CLI.
 *
 * Covers all 5 actions plus edge cases:
 * - check-capacity
 * - list-candidates
 * - create-state
 * - mark
 * - status
 *
 * @see Issue #2219 - scanner.ts 基础脚本骨架
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkCapacity,
  createState,
  listCandidates,
  markState,
  getStatus,
  EXPIRY_HOURS,
  VALID_STATES,
  type PRState,
} from './scanner.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Create a fresh temp directory for state files. */
function makeTempDir(): string {
  const dir = resolve(
    import.meta.dirname,
    `.test-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove the temp directory. */
function cleanupTempDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read a state file and parse it. */
function readState(baseDir: string, prNumber: number): PRState | null {
  const filePath = join(baseDir, '.temp-chats', `pr-${prNumber}.json`);
  if (!existsSync(filePath)) {return null;}
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/** Create a state file directly (bypassing the module). */
function writeStateDirect(baseDir: string, state: PRState): void {
  const dir = join(baseDir, '.temp-chats');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `pr-${state.prNumber}.json`);
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── checkCapacity ──────────────────────────────────────────────────────────

describe('checkCapacity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    delete process.env['PR_SCANNER_MAX_CONCURRENT'];
  });

  it('should report zero reviewing when state dir does not exist', () => {
    const result = checkCapacity(tmpDir);
    expect(result.reviewing).toBe(0);
    expect(result.maxConcurrent).toBe(1);
    expect(result.available).toBe(1);
  });

  it('should count reviewing PRs correctly', () => {
    writeStateDirect(tmpDir, {
      prNumber: 1,
      chatId: null,
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });
    writeStateDirect(tmpDir, {
      prNumber: 2,
      chatId: 'oc_abc',
      state: 'reviewing',
      createdAt: '2026-04-07T11:00:00Z',
      updatedAt: '2026-04-07T11:00:00Z',
      expiresAt: '2026-04-09T11:00:00Z',
      disbandRequested: null,
    });

    const result = checkCapacity(tmpDir);
    expect(result.reviewing).toBe(2);
    expect(result.available).toBe(0);
  });

  it('should not count approved/closed PRs as reviewing', () => {
    writeStateDirect(tmpDir, {
      prNumber: 1,
      chatId: null,
      state: 'approved',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T12:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });
    writeStateDirect(tmpDir, {
      prNumber: 2,
      chatId: null,
      state: 'closed',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T13:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });

    const result = checkCapacity(tmpDir);
    expect(result.reviewing).toBe(0);
    expect(result.available).toBe(1);
  });

  it('should respect PR_SCANNER_MAX_CONCURRENT env', () => {
    process.env['PR_SCANNER_MAX_CONCURRENT'] = '3';
    writeStateDirect(tmpDir, {
      prNumber: 1,
      chatId: null,
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });

    const result = checkCapacity(tmpDir);
    expect(result.maxConcurrent).toBe(3);
    expect(result.reviewing).toBe(1);
    expect(result.available).toBe(2);
  });

  it('should handle corrupt state files gracefully', () => {
    const dir = join(tmpDir, '.temp-chats');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pr-99.json'), 'not valid json{{{', 'utf-8');

    const result = checkCapacity(tmpDir);
    expect(result.reviewing).toBe(0);
    expect(result.available).toBe(1);
  });

  it('should handle state dir with non-matching files', () => {
    const dir = join(tmpDir, '.temp-chats');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'other.txt'), 'hello', 'utf-8');
    writeFileSync(join(dir, 'readme.md'), '# docs', 'utf-8');

    const result = checkCapacity(tmpDir);
    expect(result.reviewing).toBe(0);
  });
});

// ─── listCandidates ─────────────────────────────────────────────────────────

describe('listCandidates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should return all PRs when state dir does not exist', () => {
    const candidates = listCandidates([1, 2, 3], tmpDir);
    expect(candidates).toEqual([1, 2, 3]);
  });

  it('should filter out PRs that already have state files', () => {
    writeStateDirect(tmpDir, {
      prNumber: 1,
      chatId: null,
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });

    const candidates = listCandidates([1, 2, 3], tmpDir);
    expect(candidates).toEqual([2, 3]);
  });

  it('should return empty array when all PRs are tracked', () => {
    writeStateDirect(tmpDir, {
      prNumber: 10,
      chatId: null,
      state: 'approved',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });

    const candidates = listCandidates([10], tmpDir);
    expect(candidates).toEqual([]);
  });

  it('should return empty array when input is empty', () => {
    const candidates = listCandidates([], tmpDir);
    expect(candidates).toEqual([]);
  });

  it('should preserve order of untracked PRs', () => {
    writeStateDirect(tmpDir, {
      prNumber: 2,
      chatId: null,
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });

    const candidates = listCandidates([1, 2, 3, 4], tmpDir);
    expect(candidates).toEqual([1, 3, 4]);
  });
});

// ─── createState ─────────────────────────────────────────────────────────────

describe('createState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should create a state file with correct schema', () => {
    const state = createState(123, 'oc_test_chat', tmpDir);

    expect(state.prNumber).toBe(123);
    expect(state.chatId).toBe('oc_test_chat');
    expect(state.state).toBe('reviewing');
    expect(state.createdAt).toBeTruthy();
    expect(state.updatedAt).toBe(state.createdAt);
    expect(state.disbandRequested).toBeNull();

    // expiresAt should be createdAt + 48h
    const created = new Date(state.createdAt).getTime();
    const expires = new Date(state.expiresAt).getTime();
    const diffHours = (expires - created) / (1000 * 60 * 60);
    expect(diffHours).toBe(EXPIRY_HOURS);
  });

  it('should create state file on disk', () => {
    createState(42, null, tmpDir);

    const onDisk = readState(tmpDir, 42);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.prNumber).toBe(42);
    expect(onDisk!.chatId).toBeNull();
  });

  it('should default chatId to null', () => {
    const state = createState(99, undefined, tmpDir);
    expect(state.chatId).toBeNull();
  });

  it('should throw if state file already exists', () => {
    createState(1, null, tmpDir);
    expect(() => createState(1, null, tmpDir)).toThrow('already exists');
  });

  it('should auto-create .temp-chats directory', () => {
    const state = createState(1, null, tmpDir);
    const stateDir = join(tmpDir, '.temp-chats');
    expect(existsSync(stateDir)).toBe(true);
    expect(state.prNumber).toBe(1);
  });
});

// ─── markState ───────────────────────────────────────────────────────────────

describe('markState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should update state from reviewing to approved', () => {
    createState(1, null, tmpDir);
    const updated = markState(1, 'approved', tmpDir);

    expect(updated.state).toBe('approved');
    expect(updated.prNumber).toBe(1);
    // updatedAt should be different from createdAt (unless test runs in 0ms)
    expect(updated.updatedAt).toBeTruthy();
  });

  it('should update state from reviewing to closed', () => {
    createState(5, 'oc_chat', tmpDir);
    const updated = markState(5, 'closed', tmpDir);

    expect(updated.state).toBe('closed');
    expect(updated.chatId).toBe('oc_chat'); // preserved
  });

  it('should persist the state change to disk', () => {
    createState(10, null, tmpDir);
    markState(10, 'approved', tmpDir);

    const onDisk = readState(tmpDir, 10);
    expect(onDisk!.state).toBe('approved');
  });

  it('should throw if state file does not exist', () => {
    expect(() => markState(999, 'approved', tmpDir)).toThrow('not found');
  });

  it('should throw for invalid state value', () => {
    createState(1, null, tmpDir);
    // @ts-expect-error Testing invalid state value
    expect(() => markState(1, 'rejected', tmpDir)).toThrow('Invalid state');
  });

  it('should throw for corrupt state file', () => {
    const dir = join(tmpDir, '.temp-chats');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pr-1.json'), 'not json{{{', 'utf-8');

    expect(() => markState(1, 'approved', tmpDir)).toThrow('Corrupt');
  });

  it('should allow multiple state transitions', () => {
    createState(1, null, tmpDir);
    markState(1, 'approved', tmpDir);
    markState(1, 'closed', tmpDir);

    const finalState = readState(tmpDir, 1);
    expect(finalState!.state).toBe('closed');
  });
});

// ─── getStatus ───────────────────────────────────────────────────────────────

describe('getStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should return empty groups when no state files exist', () => {
    const result = getStatus(tmpDir);
    expect(result.reviewing).toEqual([]);
    expect(result.approved).toEqual([]);
    expect(result.closed).toEqual([]);
  });

  it('should group PRs by state', () => {
    const now = '2026-04-07T10:00:00Z';
    writeStateDirect(tmpDir, {
      prNumber: 1,
      chatId: null,
      state: 'reviewing',
      createdAt: now,
      updatedAt: now,
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });
    writeStateDirect(tmpDir, {
      prNumber: 2,
      chatId: null,
      state: 'approved',
      createdAt: now,
      updatedAt: '2026-04-07T11:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });
    writeStateDirect(tmpDir, {
      prNumber: 3,
      chatId: null,
      state: 'closed',
      createdAt: now,
      updatedAt: '2026-04-07T12:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });

    const result = getStatus(tmpDir);
    expect(result.reviewing).toHaveLength(1);
    expect(result.approved).toHaveLength(1);
    expect(result.closed).toHaveLength(1);
    expect(result.reviewing[0].prNumber).toBe(1);
    expect(result.approved[0].prNumber).toBe(2);
    expect(result.closed[0].prNumber).toBe(3);
  });

  it('should sort by updatedAt descending within each group', () => {
    writeStateDirect(tmpDir, {
      prNumber: 1,
      chatId: null,
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });
    writeStateDirect(tmpDir, {
      prNumber: 2,
      chatId: null,
      state: 'reviewing',
      createdAt: '2026-04-07T09:00:00Z',
      updatedAt: '2026-04-07T12:00:00Z',
      expiresAt: '2026-04-09T09:00:00Z',
      disbandRequested: null,
    });

    const result = getStatus(tmpDir);
    // PR 2 was updated later, should come first
    expect(result.reviewing[0].prNumber).toBe(2);
    expect(result.reviewing[1].prNumber).toBe(1);
  });

  it('should skip corrupt files silently', () => {
    writeStateDirect(tmpDir, {
      prNumber: 1,
      chatId: null,
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });

    const dir = join(tmpDir, '.temp-chats');
    writeFileSync(join(dir, 'pr-99.json'), 'bad json{{{', 'utf-8');

    const result = getStatus(tmpDir);
    expect(result.reviewing).toHaveLength(1);
    expect(result.reviewing[0].prNumber).toBe(1);
  });
});

// ─── Constants & Schema Validation ──────────────────────────────────────────

describe('constants and validation', () => {
  it('should have exactly 3 valid states', () => {
    expect(VALID_STATES).toEqual(['reviewing', 'approved', 'closed']);
  });

  it('should have 48h expiry', () => {
    expect(EXPIRY_HOURS).toBe(48);
  });

  it('createState should produce valid schema', () => {
    const tmpDir = makeTempDir();
    try {
      const state = createState(42, 'oc_x', tmpDir);

      // Verify all required fields
      expect(typeof state.prNumber).toBe('number');
      expect(typeof state.chatId).toBe('string');
      expect(VALID_STATES.includes(state.state)).toBe(true);
      expect(typeof state.createdAt).toBe('string');
      expect(typeof state.updatedAt).toBe('string');
      expect(typeof state.expiresAt).toBe('string');
      expect(state.disbandRequested).toBeNull();

      // Verify ISO date parsing works
      expect(new Date(state.createdAt).toISOString()).toBe(state.createdAt);
      expect(new Date(state.expiresAt).toISOString()).toBe(state.expiresAt);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should handle empty .temp-chats directory', () => {
    const dir = join(tmpDir, '.temp-chats');
    mkdirSync(dir, { recursive: true });

    expect(checkCapacity(tmpDir).reviewing).toBe(0);
    expect(listCandidates([1, 2], tmpDir)).toEqual([1, 2]);
    expect(getStatus(tmpDir).reviewing).toEqual([]);
  });

  it('should handle PR number 0', () => {
    expect(() => createState(0, null, tmpDir)).not.toThrow();
    const result = getStatus(tmpDir);
    expect(result.reviewing).toHaveLength(1);
    expect(result.reviewing[0].prNumber).toBe(0);
  });

  it('should handle large PR numbers', () => {
    const state = createState(999999, null, tmpDir);
    expect(state.prNumber).toBe(999999);
    const onDisk = readState(tmpDir, 999999);
    expect(onDisk).not.toBeNull();
  });

  it('should handle state files with extra fields (forward compatible)', () => {
    // Write a state file with extra fields
    const dir = join(tmpDir, '.temp-chats');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'pr-1.json'),
      JSON.stringify({
        prNumber: 1,
        chatId: null,
        state: 'reviewing',
        createdAt: '2026-04-07T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-09T10:00:00Z',
        disbandRequested: null,
        futureField: 'some value',
      }),
      'utf-8',
    );

    // Should still be readable
    const result = getStatus(tmpDir);
    expect(result.reviewing).toHaveLength(1);
    expect(result.reviewing[0].prNumber).toBe(1);
  });

  it('should handle concurrent state files', () => {
    // Create multiple state files rapidly
    for (let i = 1; i <= 10; i++) {
      createState(i, null, tmpDir);
    }

    const capacity = checkCapacity(tmpDir);
    expect(capacity.reviewing).toBe(10);

    // Mark some as approved
    markState(1, 'approved', tmpDir);
    markState(5, 'approved', tmpDir);

    const after = checkCapacity(tmpDir);
    expect(after.reviewing).toBe(8);
    expect(after.available).toBe(0); // maxConcurrent = 1

    const status = getStatus(tmpDir);
    expect(status.reviewing).toHaveLength(8);
    expect(status.approved).toHaveLength(2);
  });
});
