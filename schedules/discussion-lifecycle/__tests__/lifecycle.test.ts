/**
 * Unit tests for schedules/discussion-lifecycle/lifecycle.ts
 *
 * Tests cover all CLI actions + state file validation + edge cases
 * (corrupted files, empty directory, notification cooldown logic).
 *
 * All tests are offline — no GitHub API or lark-cli calls required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseStateFile,
  validateStateFileData,
  validatePrNumber,
  checkNotificationNeeded,
  nowISO,
  actionCheckExpired,
  actionMarkDisband,
  type PrStateFile,
  VALID_STATES,
  DISBAND_COOLDOWN_HOURS,
} from '../lifecycle.js';

// ---- Test setup ----

const TEST_STATE_DIR = resolve(process.cwd(), '.test-lifecycle-temp-chats');

/**
 * Helper to create a valid state file JSON.
 * Compatible with scanner.ts PrStateFile schema §3.1.
 */
function makeStateFile(overrides: Partial<PrStateFile> = {}): PrStateFile {
  const now = nowISO();
  // Default expiresAt: 48h from now (matching scanner.ts EXPIRY_HOURS)
  const expiresAt = new Date(new Date(now).getTime() + 48 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  return {
    prNumber: 1,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
    ...overrides,
  };
}

/**
 * Helper to create an expired state file (expiresAt in the past).
 */
function makeExpiredStateFile(prNumber: number, overrides: Partial<PrStateFile> = {}): PrStateFile {
  const now = nowISO();
  // Expired 2 hours ago
  const expiresAt = new Date(new Date(now).getTime() - 2 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  return makeStateFile({
    prNumber,
    expiresAt,
    ...overrides,
  });
}

/** Helper to write a state file directly to test dir. */
async function writeStateFile(prNumber: number, data: PrStateFile): Promise<void> {
  const filePath = resolve(TEST_STATE_DIR, `pr-${prNumber}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Capture console.log output. */
function captureLog(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  return {
    output,
    restore: () => {
      console.log = original;
    },
  };
}

/** Capture console.error output. */
function captureError(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  return {
    output,
    restore: () => {
      console.error = original;
    },
  };
}

// ---- Tests ----

describe('lifecycle', () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ---- Validation Tests ----

  describe('validatePrNumber', () => {
    it('should accept valid PR numbers', () => {
      expect(validatePrNumber('1')).toBe(1);
      expect(validatePrNumber('123')).toBe(123);
      expect(validatePrNumber('999999')).toBe(999999);
    });

    it('should reject non-numeric input', () => {
      expect(() => validatePrNumber('abc')).toThrow('Invalid PR number');
      expect(() => validatePrNumber('12.5')).toThrow('Invalid PR number');
      expect(() => validatePrNumber('')).toThrow('Invalid PR number');
    });

    it('should reject zero and negative numbers', () => {
      expect(() => validatePrNumber('0')).toThrow('Invalid PR number');
      expect(() => validatePrNumber('-1')).toThrow('Invalid PR number');
    });
  });

  describe('parseStateFile', () => {
    it('should parse a valid state file', () => {
      const stateFile = makeStateFile({ prNumber: 42 });
      const json = JSON.stringify(stateFile);
      const result = parseStateFile(json, 'test.json');
      expect(result.prNumber).toBe(42);
      expect(result.state).toBe('reviewing');
      expect(result.disbandRequested).toBeNull();
    });

    it('should reject invalid JSON', () => {
      expect(() => parseStateFile('not json', 'test.json')).toThrow('not valid JSON');
    });

    it('should reject non-object JSON', () => {
      expect(() => parseStateFile('42', 'test.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('"hello"', 'test.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
    });
  });

  describe('validateStateFileData', () => {
    it('should validate a correct state file', () => {
      const data = makeStateFile({ prNumber: 10 });
      expect(() => validateStateFileData(data, 'test.json')).not.toThrow();
    });

    it('should reject missing prNumber', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).prNumber;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('prNumber');
    });

    it('should reject invalid state value', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).state = 'rejected';
      expect(() => validateStateFileData(data, 'test.json')).toThrow('state');
    });

    it('should accept null disbandRequested', () => {
      const data = makeStateFile({ disbandRequested: null });
      expect(() => validateStateFileData(data, 'test.json')).not.toThrow();
    });

    it('should accept string disbandRequested', () => {
      const data = makeStateFile({ disbandRequested: '2026-04-18T10:00:00Z' });
      expect(() => validateStateFileData(data, 'test.json')).not.toThrow();
    });

    it('should reject non-string non-null disbandRequested', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).disbandRequested = true;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('disbandRequested');
    });

    it('should accept null chatId', () => {
      const data = makeStateFile({ chatId: null });
      expect(() => validateStateFileData(data, 'test.json')).not.toThrow();
    });

    it('should accept string chatId', () => {
      const data = makeStateFile({ chatId: 'oc_abcdef123' });
      expect(() => validateStateFileData(data, 'test.json')).not.toThrow();
    });

    it('should reject missing expiresAt', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).expiresAt;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('expiresAt');
    });

    it('should not include rejected in valid states', () => {
      expect(VALID_STATES).not.toContain('rejected');
      expect(VALID_STATES).toEqual(['reviewing', 'approved', 'closed']);
    });
  });

  // ---- Notification Cooldown Tests ----

  describe('checkNotificationNeeded', () => {
    it('should need notification when disbandRequested is null', () => {
      const result = checkNotificationNeeded(null, '2026-04-18T10:00:00Z');
      expect(result.needsNotification).toBe(true);
      expect(result.hoursSinceLastNotification).toBeNull();
    });

    it('should not need notification within cooldown period', () => {
      const now = '2026-04-18T12:00:00Z';
      const lastNotification = '2026-04-18T10:00:00Z'; // 2 hours ago
      const result = checkNotificationNeeded(lastNotification, now);
      expect(result.needsNotification).toBe(false);
      expect(result.hoursSinceLastNotification).toBe(2);
    });

    it('should need notification after cooldown period', () => {
      const now = '2026-04-19T12:00:00Z';
      const lastNotification = '2026-04-18T10:00:00Z'; // 26 hours ago
      const result = checkNotificationNeeded(lastNotification, now);
      expect(result.needsNotification).toBe(true);
      expect(result.hoursSinceLastNotification).toBe(26);
    });

    it('should need notification exactly at cooldown boundary', () => {
      const now = '2026-04-19T10:00:00Z';
      const lastNotification = '2026-04-18T10:00:00Z'; // exactly 24 hours ago
      const result = checkNotificationNeeded(lastNotification, now);
      expect(result.needsNotification).toBe(true);
      expect(result.hoursSinceLastNotification).toBe(24);
    });

    it('should respect custom cooldown hours', () => {
      const now = '2026-04-18T12:00:00Z';
      const lastNotification = '2026-04-18T10:00:00Z'; // 2 hours ago
      const result = checkNotificationNeeded(lastNotification, now, 1);
      expect(result.needsNotification).toBe(true); // 2h > 1h cooldown
    });

    it('should use default DISBAND_COOLDOWN_HOURS constant', () => {
      expect(DISBAND_COOLDOWN_HOURS).toBe(24);
    });
  });

  // ---- Action: check-expired ----

  describe('actionCheckExpired', () => {
    it('should return empty array when no state files exist', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.expired).toEqual([]);
        expect(result.total).toBe(0);
      } finally {
        restore();
      }
    });

    it('should return empty array when directory does not exist', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCheckExpired('/nonexistent/dir');
        const result = JSON.parse(output[0]);
        expect(result.expired).toEqual([]);
        expect(result.total).toBe(0);
      } finally {
        restore();
      }
    });

    it('should find expired reviewing PRs', async () => {
      await writeStateFile(1, makeExpiredStateFile(1, { state: 'reviewing' }));
      await writeStateFile(2, makeExpiredStateFile(2, { state: 'reviewing' }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(2);
        expect(result.expired[0].prNumber).toBe(1);
        expect(result.expired[1].prNumber).toBe(2);
        expect(result.expired[0].state).toBe('reviewing');
      } finally {
        restore();
      }
    });

    it('should find expired PRs regardless of state', async () => {
      await writeStateFile(1, makeExpiredStateFile(1, { state: 'reviewing' }));
      await writeStateFile(2, makeExpiredStateFile(2, { state: 'approved' }));
      await writeStateFile(3, makeExpiredStateFile(3, { state: 'closed' }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(3);
      } finally {
        restore();
      }
    });

    it('should not include non-expired PRs', async () => {
      await writeStateFile(1, makeExpiredStateFile(1)); // expired
      await writeStateFile(2, makeStateFile({ prNumber: 2 })); // not expired

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(1);
        expect(result.expired[0].prNumber).toBe(1);
      } finally {
        restore();
      }
    });

    it('should calculate needsNotification correctly', async () => {
      // PR with no previous notification
      await writeStateFile(1, makeExpiredStateFile(1, { disbandRequested: null }));
      // PR with recent notification (1 hour ago)
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(2, makeExpiredStateFile(2, { disbandRequested: oneHourAgo }));
      // PR with old notification (25 hours ago)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(3, makeExpiredStateFile(3, { disbandRequested: twentyFiveHoursAgo }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(3);

        const pr1 = result.expired.find((e: { prNumber: number }) => e.prNumber === 1);
        const pr2 = result.expired.find((e: { prNumber: number }) => e.prNumber === 2);
        const pr3 = result.expired.find((e: { prNumber: number }) => e.prNumber === 3);

        expect(pr1.needsNotification).toBe(true);
        expect(pr1.hoursSinceLastNotification).toBeNull();

        expect(pr2.needsNotification).toBe(false);
        expect(pr2.hoursSinceLastNotification).toBeCloseTo(1, 0);

        expect(pr3.needsNotification).toBe(true);
        expect(pr3.hoursSinceLastNotification).toBeCloseTo(25, 0);
      } finally {
        restore();
      }
    });

    it('should include chatId in output', async () => {
      await writeStateFile(1, makeExpiredStateFile(1, { chatId: 'oc_chat123' }));
      await writeStateFile(2, makeExpiredStateFile(2, { chatId: null }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(2);

        const pr1 = result.expired.find((e: { prNumber: number }) => e.prNumber === 1);
        const pr2 = result.expired.find((e: { prNumber: number }) => e.prNumber === 2);

        expect(pr1.chatId).toBe('oc_chat123');
        expect(pr2.chatId).toBeNull();
      } finally {
        restore();
      }
    });

    it('should sort expired PRs by expiresAt ascending', async () => {
      const now = nowISO();
      const expired1 = new Date(Date.now() - 10 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const expired2 = new Date(Date.now() - 2 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');

      await writeStateFile(1, makeExpiredStateFile(1, { expiresAt: expired2 }));
      await writeStateFile(2, makeExpiredStateFile(2, { expiresAt: expired1 }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        // Should be sorted by expiresAt ascending (older first)
        expect(result.expired[0].prNumber).toBe(2); // expired earlier
        expect(result.expired[1].prNumber).toBe(1); // expired later
      } finally {
        restore();
      }
    });

    it('should skip corrupted state files', async () => {
      await writeStateFile(1, makeExpiredStateFile(1));
      // Write corrupted file
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-999.json'),
        'not valid json{{{',
        'utf-8',
      );

      const { output, restore: restoreLog } = captureLog();
      const { output: errors, restore: restoreError } = captureError();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(1);
        expect(result.expired[0].prNumber).toBe(1);
        expect(errors.some((e) => e.includes('corrupted'))).toBe(true);
      } finally {
        restoreLog();
        restoreError();
      }
    });

    it('should skip non-pr-*.json files', async () => {
      await writeStateFile(1, makeExpiredStateFile(1));
      await writeFile(
        resolve(TEST_STATE_DIR, 'other-file.json'),
        '{}',
        'utf-8',
      );

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(1);
        expect(result.expired[0].prNumber).toBe(1);
      } finally {
        restore();
      }
    });
  });

  // ---- Action: mark-disband ----

  describe('actionMarkDisband', () => {
    it('should update disbandRequested timestamp', async () => {
      await writeStateFile(1, makeExpiredStateFile(1, { disbandRequested: null }));

      const { output, restore } = captureLog();
      try {
        await actionMarkDisband(1, TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.prNumber).toBe(1);
        expect(result.disbandRequested).not.toBeNull();
        // Should be a valid UTC timestamp
        expect(result.disbandRequested).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      } finally {
        restore();
      }

      // Verify file on disk
      const filePath = resolve(TEST_STATE_DIR, 'pr-1.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.disbandRequested).not.toBeNull();
      expect(parsed.updatedAt).not.toBeNull();
    });

    it('should overwrite existing disbandRequested', async () => {
      const oldTimestamp = '2026-04-18T10:00:00Z';
      await writeStateFile(1, makeExpiredStateFile(1, { disbandRequested: oldTimestamp }));

      const { output, restore } = captureLog();
      try {
        await actionMarkDisband(1, TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        // Should be updated to a new (later) timestamp
        expect(result.disbandRequested).not.toBe(oldTimestamp);
      } finally {
        restore();
      }
    });

    it('should preserve other state file fields', async () => {
      const original = makeExpiredStateFile(1, {
        chatId: 'oc_chat123',
        state: 'reviewing',
        disbandRequested: null,
      });
      await writeStateFile(1, original);

      const { output, restore } = captureLog();
      try {
        await actionMarkDisband(1, TEST_STATE_DIR);
      } finally {
        restore();
      }

      // Verify all fields preserved
      const filePath = resolve(TEST_STATE_DIR, 'pr-1.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(1);
      expect(parsed.chatId).toBe('oc_chat123');
      expect(parsed.state).toBe('reviewing');
      expect(parsed.createdAt).toBe(original.createdAt);
      expect(parsed.expiresAt).toBe(original.expiresAt);
    });

    it('should throw error when state file not found', async () => {
      await expect(actionMarkDisband(999, TEST_STATE_DIR)).rejects.toThrow(
        'State file not found for PR #999',
      );
    });

    it('should throw error for corrupted state file', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-1.json'),
        'not valid json{{{',
        'utf-8',
      );

      await expect(actionMarkDisband(1, TEST_STATE_DIR)).rejects.toThrow(
        'Corrupted state file for PR #1',
      );
    });
  });

  // ---- Integration-style Tests ----

  describe('check-expired + mark-disband flow', () => {
    it('should detect expired PR, mark disband, then detect notification cooldown', async () => {
      // 1. Create an expired PR
      await writeStateFile(1, makeExpiredStateFile(1, { disbandRequested: null }));

      // 2. check-expired should show needsNotification = true
      let output: string[] = [];
      let restore: () => void;

      ({ output, restore } = captureLog());
      try {
        await actionCheckExpired(TEST_STATE_DIR);
      } finally {
        restore();
      }
      let result = JSON.parse(output[0]);
      expect(result.total).toBe(1);
      expect(result.expired[0].needsNotification).toBe(true);

      // 3. mark-disband updates the timestamp
      ({ output, restore } = captureLog());
      try {
        await actionMarkDisband(1, TEST_STATE_DIR);
      } finally {
        restore();
      }
      const markResult = JSON.parse(output[0]);
      expect(markResult.disbandRequested).not.toBeNull();

      // 4. check-expired should now show needsNotification = false (within cooldown)
      ({ output, restore } = captureLog());
      try {
        await actionCheckExpired(TEST_STATE_DIR);
      } finally {
        restore();
      }
      result = JSON.parse(output[0]);
      expect(result.total).toBe(1);
      expect(result.expired[0].needsNotification).toBe(false);
      expect(result.expired[0].hoursSinceLastNotification).toBeCloseTo(0, 0);
    });

    it('should handle multiple expired PRs independently', async () => {
      await writeStateFile(1, makeExpiredStateFile(1, { disbandRequested: null }));
      // PR 2 was notified 25 hours ago (past cooldown)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(2, makeExpiredStateFile(2, { disbandRequested: twentyFiveHoursAgo }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(2);
        expect(result.expired.find((e: { prNumber: number }) => e.prNumber === 1).needsNotification).toBe(true);
        expect(result.expired.find((e: { prNumber: number }) => e.prNumber === 2).needsNotification).toBe(true);
      } finally {
        restore();
      }
    });
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('should handle empty state directory', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.expired).toEqual([]);
        expect(result.total).toBe(0);
      } finally {
        restore();
      }
    });

    it('should handle PR exactly at expiresAt boundary', async () => {
      const now = nowISO();
      // Not expired: expiresAt is now (not less than now)
      await writeStateFile(1, makeStateFile({ prNumber: 1, expiresAt: now }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        // expiresAt >= now means not expired
        expect(result.total).toBe(0);
      } finally {
        restore();
      }
    });

    it('should handle mixed expired and non-expired PRs', async () => {
      await writeStateFile(1, makeExpiredStateFile(1)); // expired
      await writeStateFile(2, makeStateFile({ prNumber: 2 })); // not expired (48h from now)
      await writeStateFile(3, makeExpiredStateFile(3, { state: 'approved' })); // expired but approved
      await writeStateFile(4, makeExpiredStateFile(4, { state: 'closed' })); // expired but closed

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        // All expired PRs should be returned, regardless of state
        expect(result.total).toBe(3); // PRs 1, 3, 4 are expired
        const prNumbers = result.expired.map((e: { prNumber: number }) => e.prNumber).sort();
        expect(prNumbers).toEqual([1, 3, 4]);
      } finally {
        restore();
      }
    });

    it('should handle state file with all valid states', async () => {
      await writeStateFile(1, makeExpiredStateFile(1, { state: 'reviewing' }));
      await writeStateFile(2, makeExpiredStateFile(2, { state: 'approved' }));
      await writeStateFile(3, makeExpiredStateFile(3, { state: 'closed' }));

      const { output, restore } = captureLog();
      try {
        await actionCheckExpired(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.total).toBe(3);
      } finally {
        restore();
      }
    });
  });
});
