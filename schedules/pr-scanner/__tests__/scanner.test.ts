/**
 * Tests for PR Scanner state management CLI.
 *
 * Covers all actions, state file read/write, validation, and edge cases.
 * All tests are offline — no GitHub API calls required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  // Types
  type PRState,
  type PRStateFile,
  // Constants
  DEFAULT_STATE_DIR,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_EXPIRY_HOURS,
  VALID_STATES,
  // Helpers
  nowISO,
  calculateExpiry,
  isValidState,
  getStateDir,
  getMaxConcurrent,
  getExpiryHours,
  getStateFilePath,
  parsePRNumber,
  atomicWrite,
  ensureStateDir,
  readStateFile,
  validateStateFile,
  readAllStateFiles,
  // Actions
  actionCheckCapacity,
  actionListCandidates,
  actionCreateState,
  actionMark,
  actionStatus,
} from '../scanner.js';

// ---- Test helpers ----

const TEST_STATE_DIR = join('.temp-chats', 'test-scanner');

function makeValidState(overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = nowISO();
  return {
    prNumber: 100,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: calculateExpiry(now, 48),
    disbandRequested: null,
    ...overrides,
  };
}

async function writeStateFile(prNumber: number, data: PRStateFile): Promise<void> {
  const filePath = join(TEST_STATE_DIR, `pr-${prNumber}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---- Tests ----

describe('scanner', () => {
  // Use a test-specific state directory
  const originalStateDir = process.env.PR_STATE_DIR;
  const originalMaxConcurrent = process.env.PR_MAX_CONCURRENT;
  const originalExpiryHours = process.env.PR_EXPIRY_HOURS;

  beforeEach(async () => {
    process.env.PR_STATE_DIR = TEST_STATE_DIR;
    delete process.env.PR_MAX_CONCURRENT;
    delete process.env.PR_EXPIRY_HOURS;
    // Create fresh test directory
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Restore env vars
    if (originalStateDir !== undefined) process.env.PR_STATE_DIR = originalStateDir;
    else delete process.env.PR_STATE_DIR;
    if (originalMaxConcurrent !== undefined) process.env.PR_MAX_CONCURRENT = originalMaxConcurrent;
    else delete process.env.PR_MAX_CONCURRENT;
    if (originalExpiryHours !== undefined) process.env.PR_EXPIRY_HOURS = originalExpiryHours;
    else delete process.env.PR_EXPIRY_HOURS;
    // Clean up test directory
    try {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ---- Helper tests ----

  describe('nowISO', () => {
    it('should return a valid ISO 8601 Z-suffix string', () => {
      const result = nowISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('calculateExpiry', () => {
    it('should add hours to the creation time', () => {
      const createdAt = '2026-04-07T10:00:00.000Z';
      const result = calculateExpiry(createdAt, 48);
      expect(result).toBe('2026-04-09T10:00:00.000Z');
    });

    it('should handle zero hours', () => {
      const createdAt = '2026-04-07T10:00:00.000Z';
      const result = calculateExpiry(createdAt, 0);
      expect(result).toBe(createdAt);
    });

    it('should handle fractional hours', () => {
      const createdAt = '2026-04-07T10:00:00.000Z';
      const result = calculateExpiry(createdAt, 1.5);
      expect(result).toBe('2026-04-07T11:30:00.000Z');
    });
  });

  describe('isValidState', () => {
    it('should accept valid states', () => {
      expect(isValidState('reviewing')).toBe(true);
      expect(isValidState('approved')).toBe(true);
      expect(isValidState('closed')).toBe(true);
    });

    it('should reject invalid states', () => {
      expect(isValidState('rejected')).toBe(false);
      expect(isValidState('pending')).toBe(false);
      expect(isValidState('')).toBe(false);
      expect(isValidState('REVIEWING')).toBe(false);
    });
  });

  describe('parsePRNumber', () => {
    it('should parse valid state filenames', () => {
      expect(parsePRNumber('pr-123.json')).toBe(123);
      expect(parsePRNumber('pr-1.json')).toBe(1);
      expect(parsePRNumber('pr-99999.json')).toBe(99999);
    });

    it('should return null for invalid filenames', () => {
      expect(parsePRNumber('abc.json')).toBeNull();
      expect(parsePRNumber('pr-abc.json')).toBeNull();
      expect(parsePRNumber('pr--1.json')).toBeNull();
      expect(parsePRNumber('state.json')).toBeNull();
      expect(parsePRNumber('.json')).toBeNull();
    });
  });

  describe('getStateFilePath', () => {
    it('should construct correct path', () => {
      const path = getStateFilePath(42);
      expect(path).toBe(join(TEST_STATE_DIR, 'pr-42.json'));
    });
  });

  describe('getMaxConcurrent', () => {
    it('should return default when env not set', () => {
      expect(getMaxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);
    });

    it('should respect env var', () => {
      process.env.PR_MAX_CONCURRENT = '10';
      expect(getMaxConcurrent()).toBe(10);
    });

    it('should fallback on invalid env var', () => {
      process.env.PR_MAX_CONCURRENT = 'abc';
      expect(getMaxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);
      process.env.PR_MAX_CONCURRENT = '-1';
      expect(getMaxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);
      process.env.PR_MAX_CONCURRENT = '0';
      expect(getMaxConcurrent()).toBe(DEFAULT_MAX_CONCURRENT);
    });
  });

  describe('getExpiryHours', () => {
    it('should return default when env not set', () => {
      expect(getExpiryHours()).toBe(DEFAULT_EXPIRY_HOURS);
    });

    it('should respect env var', () => {
      process.env.PR_EXPIRY_HOURS = '24';
      expect(getExpiryHours()).toBe(24);
    });

    it('should fallback on invalid env var', () => {
      process.env.PR_EXPIRY_HOURS = 'invalid';
      expect(getExpiryHours()).toBe(DEFAULT_EXPIRY_HOURS);
    });
  });

  // ---- Atomic write tests ----

  describe('atomicWrite', () => {
    it('should write file content', async () => {
      const filePath = join(TEST_STATE_DIR, 'test-atomic.json');
      await atomicWrite(filePath, '{"ok":true}');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('{"ok":true}');
    });

    it('should overwrite existing file', async () => {
      const filePath = join(TEST_STATE_DIR, 'test-overwrite.json');
      await atomicWrite(filePath, '{"v":1}');
      await atomicWrite(filePath, '{"v":2}');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('{"v":2}');
    });
  });

  // ---- Validation tests ----

  describe('validateStateFile', () => {
    it('should validate a correct state file', () => {
      const data = makeValidState();
      expect(() => validateStateFile(data)).not.toThrow();
    });

    it('should reject null', () => {
      expect(() => validateStateFile(null)).toThrow('not a valid JSON object');
    });

    it('should reject array', () => {
      expect(() => validateStateFile([])).toThrow('not a valid JSON object');
    });

    it('should reject missing prNumber', () => {
      const data = makeValidState();
      delete (data as Record<string, unknown>).prNumber;
      expect(() => validateStateFile(data)).toThrow('Invalid prNumber');
    });

    it('should reject non-integer prNumber', () => {
      const data = makeValidState({ prNumber: 1.5 } as Partial<PRStateFile>);
      expect(() => validateStateFile(data)).toThrow('Invalid prNumber');
    });

    it('should reject negative prNumber', () => {
      const data = makeValidState({ prNumber: -1 } as Partial<PRStateFile>);
      expect(() => validateStateFile(data)).toThrow('Invalid prNumber');
    });

    it('should accept null chatId', () => {
      const data = makeValidState({ chatId: null });
      expect(() => validateStateFile(data)).not.toThrow();
    });

    it('should reject non-string non-null chatId', () => {
      const data = makeValidState();
      (data as Record<string, unknown>).chatId = 123;
      expect(() => validateStateFile(data)).toThrow('Invalid chatId');
    });

    it('should reject invalid state', () => {
      const data = makeValidState();
      (data as Record<string, unknown>).state = 'rejected';
      expect(() => validateStateFile(data)).toThrow('Invalid state');
    });

    it('should reject missing createdAt', () => {
      const data = makeValidState();
      delete (data as Record<string, unknown>).createdAt;
      expect(() => validateStateFile(data)).toThrow('Invalid createdAt');
    });

    it('should reject non-string disbandRequested', () => {
      const data = makeValidState();
      (data as Record<string, unknown>).disbandRequested = 123;
      expect(() => validateStateFile(data)).toThrow('Invalid disbandRequested');
    });

    it('should accept string disbandRequested', () => {
      const data = makeValidState({ disbandRequested: '2026-04-09T10:00:00Z' } as Partial<PRStateFile>);
      expect(() => validateStateFile(data)).not.toThrow();
    });
  });

  // ---- Read/write state files ----

  describe('readStateFile', () => {
    it('should read a valid state file', async () => {
      const state = makeValidState({ prNumber: 200 });
      await writeStateFile(200, state);
      const result = await readStateFile(200);
      expect(result).toEqual(state);
    });

    it('should return null for missing file', async () => {
      const result = await readStateFile(99999);
      expect(result).toBeNull();
    });

    it('should return null for corrupted file', async () => {
      const filePath = join(TEST_STATE_DIR, 'pr-300.json');
      await writeFile(filePath, 'not json{{{', 'utf-8');
      const result = await readStateFile(300);
      expect(result).toBeNull();
    });
  });

  describe('readAllStateFiles', () => {
    it('should read all state files', async () => {
      await writeStateFile(101, makeValidState({ prNumber: 101, state: 'reviewing' }));
      await writeStateFile(102, makeValidState({ prNumber: 102, state: 'approved' }));
      await writeStateFile(103, makeValidState({ prNumber: 103, state: 'closed' }));

      const results = await readAllStateFiles();
      expect(results).toHaveLength(3);
      const numbers = results.map((s) => s.prNumber).sort();
      expect(numbers).toEqual([101, 102, 103]);
    });

    it('should return empty array when directory is empty', async () => {
      const results = await readAllStateFiles();
      expect(results).toEqual([]);
    });

    it('should return empty array when directory does not exist', async () => {
      process.env.PR_STATE_DIR = join(TEST_STATE_DIR, 'nonexistent');
      const results = await readAllStateFiles();
      expect(results).toEqual([]);
    });

    it('should skip non-state files', async () => {
      await writeStateFile(110, makeValidState({ prNumber: 110 }));
      await writeFile(join(TEST_STATE_DIR, 'other.txt'), 'hello', 'utf-8');
      await writeFile(join(TEST_STATE_DIR, 'readme.md'), '# test', 'utf-8');

      const results = await readAllStateFiles();
      expect(results).toHaveLength(1);
      expect(results[0].prNumber).toBe(110);
    });

    it('should handle corrupted state files gracefully', async () => {
      await writeStateFile(120, makeValidState({ prNumber: 120 }));
      await writeFile(join(TEST_STATE_DIR, 'pr-121.json'), 'corrupted{{{', 'utf-8');

      const results = await readAllStateFiles();
      expect(results).toHaveLength(2);
    });
  });

  // ---- Action: check-capacity ----

  describe('actionCheckCapacity', () => {
    it('should return zero when empty', async () => {
      const info = await actionCheckCapacity();
      expect(info).toEqual({
        reviewing: 0,
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
        available: DEFAULT_MAX_CONCURRENT,
      });
    });

    it('should count reviewing PRs correctly', async () => {
      await writeStateFile(201, makeValidState({ prNumber: 201, state: 'reviewing' }));
      await writeStateFile(202, makeValidState({ prNumber: 202, state: 'reviewing' }));
      await writeStateFile(203, makeValidState({ prNumber: 203, state: 'approved' }));

      const info = await actionCheckCapacity();
      expect(info.reviewing).toBe(2);
      expect(info.available).toBe(DEFAULT_MAX_CONCURRENT - 2);
    });

    it('should not go below zero available', async () => {
      // Create more reviewing than max
      process.env.PR_MAX_CONCURRENT = '1';
      await writeStateFile(301, makeValidState({ prNumber: 301, state: 'reviewing' }));
      await writeStateFile(302, makeValidState({ prNumber: 302, state: 'reviewing' }));

      const info = await actionCheckCapacity();
      expect(info.available).toBe(0);
    });
  });

  // ---- Action: list-candidates ----

  describe('actionListCandidates', () => {
    it('should return all PRs when no state files exist', async () => {
      const candidates = await actionListCandidates([1, 2, 3]);
      expect(candidates).toEqual([1, 2, 3]);
    });

    it('should exclude tracked PRs', async () => {
      await writeStateFile(1, makeValidState({ prNumber: 1 }));
      await writeStateFile(3, makeValidState({ prNumber: 3 }));

      const candidates = await actionListCandidates([1, 2, 3, 4]);
      expect(candidates).toEqual([2, 4]);
    });

    it('should return empty when all are tracked', async () => {
      await writeStateFile(1, makeValidState({ prNumber: 1 }));
      await writeStateFile(2, makeValidState({ prNumber: 2 }));

      const candidates = await actionListCandidates([1, 2]);
      expect(candidates).toEqual([]);
    });

    it('should return empty when no PRs given', async () => {
      const candidates = await actionListCandidates([]);
      expect(candidates).toEqual([]);
    });
  });

  // ---- Action: create-state ----

  describe('actionCreateState', () => {
    it('should create a valid state file', async () => {
      const state = await actionCreateState(400, 'oc_test123');

      expect(state.prNumber).toBe(400);
      expect(state.chatId).toBe('oc_test123');
      expect(state.state).toBe('reviewing');
      expect(state.disbandRequested).toBeNull();
      expect(state.createdAt).toBeTruthy();
      expect(state.updatedAt).toBeTruthy();
      expect(state.expiresAt).toBeTruthy();

      // Verify file exists
      const onDisk = await readStateFile(400);
      expect(onDisk).toEqual(state);
    });

    it('should create state file without chatId', async () => {
      const state = await actionCreateState(401);
      expect(state.chatId).toBeNull();
    });

    it('should reject duplicate creation', async () => {
      await actionCreateState(402);
      await expect(actionCreateState(402)).rejects.toThrow('already exists');
    });

    it('should set correct expiry based on env var', async () => {
      process.env.PR_EXPIRY_HOURS = '24';
      const state = await actionCreateState(403);
      const created = new Date(state.createdAt);
      const expires = new Date(state.expiresAt);
      const diffHours = (expires.getTime() - created.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeCloseTo(24, 0);
    });

    it('should write valid JSON to disk', async () => {
      await actionCreateState(404);
      const filePath = join(TEST_STATE_DIR, 'pr-404.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(() => validateStateFile(parsed)).not.toThrow();
    });
  });

  // ---- Action: mark ----

  describe('actionMark', () => {
    it('should update state to approved', async () => {
      await actionCreateState(500);
      const updated = await actionMark(500, 'approved');
      expect(updated.state).toBe('approved');
      expect(updated.prNumber).toBe(500);
    });

    it('should update state to closed', async () => {
      await actionCreateState(501);
      const updated = await actionMark(501, 'closed');
      expect(updated.state).toBe('closed');
    });

    it('should update updatedAt timestamp', async () => {
      await actionCreateState(502);
      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      const updated = await actionMark(502, 'approved');
      expect(updated.updatedAt).not.toBe(updated.createdAt);
    });

    it('should persist the update to disk', async () => {
      await actionCreateState(503);
      await actionMark(503, 'approved');
      const onDisk = await readStateFile(503);
      expect(onDisk?.state).toBe('approved');
    });

    it('should reject invalid state transition', async () => {
      await actionCreateState(504);
      await expect(actionMark(504, 'rejected' as PRState)).rejects.toThrow('Invalid state');
    });

    it('should reject marking non-existent PR', async () => {
      await expect(actionMark(99999, 'approved')).rejects.toThrow('No state file found');
    });

    it('should allow multiple state transitions', async () => {
      await actionCreateState(505);
      await actionMark(505, 'approved');
      const updated = await actionMark(505, 'closed');
      expect(updated.state).toBe('closed');
    });
  });

  // ---- Action: status ----

  describe('actionStatus', () => {
    it('should show all categories as empty', async () => {
      const status = await actionStatus();
      expect(status.reviewing).toEqual([]);
      expect(status.approved).toEqual([]);
      expect(status.closed).toEqual([]);
      expect(status.expired).toEqual([]);
      expect(status.corrupted).toEqual([]);
    });

    it('should categorize PRs by state', async () => {
      await writeStateFile(601, makeValidState({ prNumber: 601, state: 'reviewing' }));
      await writeStateFile(602, makeValidState({ prNumber: 602, state: 'approved' }));
      await writeStateFile(603, makeValidState({ prNumber: 603, state: 'closed' }));

      const status = await actionStatus();
      expect(status.reviewing).toContain(601);
      expect(status.approved).toContain(602);
      expect(status.closed).toContain(603);
    });

    it('should detect expired reviewing PRs', async () => {
      const past = new Date();
      past.setUTCHours(past.getUTCHours() - 100);
      const expiredState = makeValidState({
        prNumber: 701,
        state: 'reviewing',
        createdAt: past.toISOString(),
        expiresAt: past.toISOString(), // already expired
      });
      await writeStateFile(701, expiredState);

      const status = await actionStatus();
      expect(status.expired).toContain(701);
      expect(status.reviewing).not.toContain(701);
    });

    it('should detect corrupted files', async () => {
      await writeFile(join(TEST_STATE_DIR, 'pr-801.json'), '{not valid json', 'utf-8');

      const status = await actionStatus();
      expect(status.corrupted).toContain(801);
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('should handle empty directory', async () => {
      const entries = await readdir(TEST_STATE_DIR);
      expect(entries).toEqual([]);

      const info = await actionCheckCapacity();
      expect(info.reviewing).toBe(0);

      const status = await actionStatus();
      expect(status.reviewing).toEqual([]);
    });

    it('should handle concurrent state files', async () => {
      // Create many state files
      for (let i = 1000; i < 1020; i++) {
        await writeStateFile(i, makeValidState({ prNumber: i, state: 'reviewing' }));
      }

      const info = await actionCheckCapacity();
      expect(info.reviewing).toBe(20);
      expect(info.available).toBe(0);
    });

    it('should handle state file with extra fields gracefully', async () => {
      const state = makeValidState({ prNumber: 900 });
      const extended = { ...state, extraField: 'should be preserved' };
      await writeStateFile(900, extended as PRStateFile);

      const read = await readStateFile(900);
      expect(read).toBeTruthy();
      expect(read!.prNumber).toBe(900);
    });

    it('should preserve chatId through mark operations', async () => {
      await actionCreateState(901, 'oc_preserve_me');
      await actionMark(901, 'approved');
      const onDisk = await readStateFile(901);
      expect(onDisk?.chatId).toBe('oc_preserve_me');
    });

    it('should preserve expiresAt through mark operations', async () => {
      const original = await actionCreateState(902);
      const originalExpiry = original.expiresAt;
      await actionMark(902, 'approved');
      const onDisk = await readStateFile(902);
      expect(onDisk?.expiresAt).toBe(originalExpiry);
    });

    it('should preserve disbandRequested through mark operations', async () => {
      const original = await actionCreateState(903);
      await actionMark(903, 'closed');
      const onDisk = await readStateFile(903);
      expect(onDisk?.disbandRequested).toBeNull();
    });
  });
});
