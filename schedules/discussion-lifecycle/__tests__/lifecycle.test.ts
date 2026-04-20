/**
 * Unit tests for schedules/discussion-lifecycle/lifecycle.ts
 *
 * Tests all CLI actions, state file parsing, expiry detection,
 * disband dedup logic, and edge cases.
 * Does not depend on lark-cli or gh CLI for core operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseStateFile,
  validateStateFile,
  stateFilePath,
  nowISO,
  isExpired,
  shouldSendDisband,
  checkExpired,
  markDisband,
  executeDisband,
  STATE_DIR,
  DEFAULT_DISBAND_DEDUP_HOURS,
  DEFAULT_REPO,
  type PRStateFile,
} from '../lifecycle.js';

// Resolve state dir relative to project root
const STATE_DIR_RESOLVED = resolve(process.cwd(), STATE_DIR);

// Test PR numbers to clean up
const TEST_PRS = [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008];

function createStateFile(prNumber: number, overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = nowISO();
  const expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago (expired)
  return {
    prNumber,
    chatId: `oc_test_${prNumber}`,
    state: 'reviewing',
    createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(), // 49h ago
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
    ...overrides,
  };
}

async function writeStateFile(prNumber: number, data: PRStateFile) {
  const filePath = stateFilePath(prNumber);
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function cleanupTestFiles() {
  try {
    const files = await readdir(STATE_DIR_RESOLVED);
    for (const file of files) {
      if (file.startsWith('pr-800')) {
        await rm(resolve(STATE_DIR_RESOLVED, file), { force: true });
      }
    }
  } catch {
    // Directory may not exist
  }
}

describe('lifecycle', () => {
  beforeEach(async () => {
    await mkdir(STATE_DIR_RESOLVED, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  // ---- Schema Validation ----

  describe('parseStateFile', () => {
    it('should parse a valid state file', () => {
      const data = createStateFile(123);
      const json = JSON.stringify(data);
      const result = parseStateFile(json, 'test.json');
      expect(result.prNumber).toBe(123);
      expect(result.state).toBe('reviewing');
      expect(result.chatId).toBe('oc_test_123');
      expect(result.disbandRequested).toBeNull();
    });

    it('should reject invalid JSON', () => {
      expect(() => parseStateFile('not json', 'bad.json')).toThrow('not valid JSON');
    });

    it('should reject non-object JSON', () => {
      expect(() => parseStateFile('"string"', 'bad.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('[]', 'bad.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('null', 'bad.json')).toThrow('not a valid JSON object');
    });

    it('should reject invalid state', () => {
      const data = { ...createStateFile(123), state: 'unknown' };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow("invalid 'state'");
    });

    it('should accept all valid states', () => {
      for (const state of ['reviewing', 'approved', 'closed']) {
        const data = createStateFile(123, { state: state as PRStateFile['state'] });
        expect(() => parseStateFile(JSON.stringify(data), 'test.json')).not.toThrow();
      }
    });

    it('should accept null disbandRequested', () => {
      const data = createStateFile(123, { disbandRequested: null });
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).not.toThrow();
    });

    it('should accept string disbandRequested', () => {
      const data = createStateFile(123, { disbandRequested: '2026-04-20T12:00:00.000Z' });
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).not.toThrow();
    });

    it('should reject non-null non-string disbandRequested', () => {
      const data = { ...createStateFile(123), disbandRequested: 123 };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow("invalid 'disbandRequested'");
    });
  });

  // ---- Helper Functions ----

  describe('stateFilePath', () => {
    it('should generate correct path', () => {
      const path = stateFilePath(123);
      expect(path).toMatch(/\.temp-chats\/pr-123\.json$/);
    });
  });

  describe('isExpired', () => {
    it('should return true for past timestamps', () => {
      expect(isExpired('2020-01-01T00:00:00Z')).toBe(true);
    });

    it('should return false for future timestamps', () => {
      expect(isExpired('2099-12-31T23:59:59Z')).toBe(false);
    });

    it('should return false for invalid format', () => {
      expect(isExpired('not-a-date')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isExpired('')).toBe(false);
    });
  });

  describe('shouldSendDisband', () => {
    it('should return true when never requested (null)', () => {
      expect(shouldSendDisband(null, 24)).toBe(true);
    });

    it('should return true when dedup period has elapsed', () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      expect(shouldSendDisband(twoDaysAgo, 24)).toBe(true);
    });

    it('should return false when within dedup period', () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      expect(shouldSendDisband(oneHourAgo, 24)).toBe(false);
    });

    it('should return true for invalid date format', () => {
      expect(shouldSendDisband('not-a-date', 24)).toBe(true);
    });

    it('should respect custom dedup hours', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(shouldSendDisband(threeHoursAgo, 1)).toBe(true); // 1h dedup, 3h ago → send
      expect(shouldSendDisband(threeHoursAgo, 6)).toBe(false); // 6h dedup, 3h ago → skip
    });
  });

  // ---- Actions ----

  describe('check-expired', () => {
    it('should return empty when no state files exist', async () => {
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(0);
      expect(result.alreadyNotified).toHaveLength(0);
    });

    it('should find expired reviewing PRs needing disband', async () => {
      await writeStateFile(8001, createStateFile(8001));
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(1);
      expect(result.needsDisband[0].prNumber).toBe(8001);
      expect(result.alreadyNotified).toHaveLength(0);
    });

    it('should separate already-notified PRs', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await writeStateFile(8001, createStateFile(8001, { disbandRequested: oneHourAgo }));
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(0);
      expect(result.alreadyNotified).toHaveLength(1);
      expect(result.alreadyNotified[0].prNumber).toBe(8001);
    });

    it('should find already-notified PR where dedup period elapsed', async () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      await writeStateFile(8001, createStateFile(8001, { disbandRequested: twoDaysAgo }));
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(1);
      expect(result.alreadyNotified).toHaveLength(0);
    });

    it('should skip non-expired PRs', async () => {
      await writeStateFile(8001, createStateFile(8001, {
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 48h from now
      }));
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(0);
      expect(result.alreadyNotified).toHaveLength(0);
    });

    it('should skip non-reviewing PRs', async () => {
      await writeStateFile(8001, createStateFile(8001, { state: 'approved' }));
      await writeStateFile(8002, createStateFile(8002, { state: 'closed' }));
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(0);
      expect(result.alreadyNotified).toHaveLength(0);
    });

    it('should handle corrupted files gracefully', async () => {
      await writeStateFile(8001, createStateFile(8001));
      const corruptedPath = stateFilePath(8002);
      await writeFile(corruptedPath, 'not valid json\n', 'utf-8');
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(1); // Only the valid one
    });

    it('should handle mixed states correctly', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await writeStateFile(8001, createStateFile(8001)); // needsDisband
      await writeStateFile(8002, createStateFile(8002, { disbandRequested: oneHourAgo })); // alreadyNotified
      await writeStateFile(8003, createStateFile(8003, { state: 'approved' })); // skip
      await writeStateFile(8004, createStateFile(8004, {
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // not expired
      }));
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(1);
      expect(result.alreadyNotified).toHaveLength(1);
    });

    it('should use default dedup hours when not specified', async () => {
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      await writeStateFile(8001, createStateFile(8001, { disbandRequested: twelveHoursAgo }));
      const result = await checkExpired(); // Default 24h
      expect(result.alreadyNotified).toHaveLength(1); // 12h < 24h, so already notified
    });
  });

  describe('mark-disband', () => {
    it('should update disbandRequested timestamp', async () => {
      await writeStateFile(8001, createStateFile(8001));
      const result = await markDisband(8001);
      expect(result.disbandRequested).not.toBeNull();
      expect(result.updatedAt).toBeTruthy();
    });

    it('should update updatedAt timestamp', async () => {
      const original = createStateFile(8001, {
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
      await writeStateFile(8001, original);
      const result = await markDisband(8001);
      expect(result.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('should preserve other fields', async () => {
      const original = createStateFile(8001, {
        chatId: 'oc_preserve_me',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-03T00:00:00.000Z',
      });
      await writeStateFile(8001, original);
      const result = await markDisband(8001);
      expect(result.chatId).toBe('oc_preserve_me');
      expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(result.expiresAt).toBe('2026-01-03T00:00:00.000Z');
      expect(result.prNumber).toBe(8001);
    });

    it('should throw for non-existent PR', async () => {
      await expect(markDisband(9999)).rejects.toThrow('No state file found');
    });

    it('should throw for non-reviewing PR', async () => {
      await writeStateFile(8001, createStateFile(8001, { state: 'approved' }));
      await expect(markDisband(8001)).rejects.toThrow("state is 'approved'");
    });

    it('should update the actual file on disk', async () => {
      await writeStateFile(8001, createStateFile(8001));
      await markDisband(8001);
      const content = await readFile(stateFilePath(8001), 'utf-8');
      const data = JSON.parse(content);
      expect(data.disbandRequested).not.toBeNull();
    });
  });

  describe('execute-disband', () => {
    it('should successfully disband a reviewing PR (skip lark)', async () => {
      await writeStateFile(8001, createStateFile(8001));
      const result = await executeDisband(8001, DEFAULT_REPO, true);
      expect(result.success).toBe(true);
      expect(result.action).toBe('disbanded');
      expect(result.error).toBeNull();
    });

    it('should delete state file after successful disband', async () => {
      await writeStateFile(8001, createStateFile(8001));
      await executeDisband(8001, DEFAULT_REPO, true);
      await expect(readFile(stateFilePath(8001), 'utf-8')).rejects.toThrow();
    });

    it('should reject non-reviewing PR', async () => {
      await writeStateFile(8001, createStateFile(8001, { state: 'approved' }));
      const result = await executeDisband(8001, DEFAULT_REPO, true);
      expect(result.success).toBe(false);
      expect(result.action).toBe('reject');
      expect(result.error).toContain("State is 'approved'");
    });

    it('should skip non-existent PR', async () => {
      const result = await executeDisband(9999, DEFAULT_REPO, true);
      expect(result.success).toBe(false);
      expect(result.action).toBe('skip');
    });

    it('should handle corrupted state file', async () => {
      await writeFile(stateFilePath(8001), 'corrupted json {{{\n', 'utf-8');
      const result = await executeDisband(8001, DEFAULT_REPO, true);
      expect(result.success).toBe(false);
      expect(result.action).toBe('skip');
    });

    it('should handle PR without chatId', async () => {
      await writeStateFile(8001, createStateFile(8001, { chatId: null }));
      const result = await executeDisband(8001, DEFAULT_REPO, true);
      expect(result.success).toBe(true);
      expect(result.action).toBe('disbanded');
    });
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('should handle empty .temp-chats directory', async () => {
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(0);
      expect(result.alreadyNotified).toHaveLength(0);
    });

    it('should handle non-pr JSON files in state dir', async () => {
      await writeStateFile(8001, createStateFile(8001));
      await writeFile(resolve(STATE_DIR_RESOLVED, 'other.json'), '{}\n', 'utf-8');
      const result = await checkExpired(24);
      expect(result.needsDisband).toHaveLength(1);
    });

    it('should correctly generate state file path', () => {
      const path = stateFilePath(42);
      expect(path).toMatch(/\.temp-chats\/pr-42\.json$/);
    });

    it('should handle multiple mark-disband calls (idempotent)', async () => {
      await writeStateFile(8001, createStateFile(8001));
      const result1 = await markDisband(8001);
      // Wait briefly to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 2));
      const result2 = await markDisband(8001);
      expect(result1.disbandRequested).not.toBeNull();
      expect(result2.disbandRequested).not.toBeNull();
      // Second call updates timestamp
      expect(result2.disbandRequested).not.toBe(result1.disbandRequested);
    });
  });
});
