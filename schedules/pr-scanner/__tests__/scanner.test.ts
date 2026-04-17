/**
 * Unit tests for schedules/pr-scanner/scanner.ts
 *
 * Tests cover all CLI actions + state file read/write + edge cases
 * (corrupted files, empty directory, concurrent operations).
 *
 * All tests are offline — no GitHub API calls required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseStateFile,
  validateStateFileData,
  validatePrNumber,
  validateState,
  createStateFile,
  computeExpiry,
  nowISO,
  stateFilePath,
  atomicWrite,
  actionCheckCapacity,
  actionCreateState,
  actionMark,
  actionStatus,
  type PrStateFile,
  type PrState,
  VALID_STATES,
} from '../scanner.js';

// ---- Test setup ----

const TEST_STATE_DIR = resolve(process.cwd(), '.test-temp-chats');

// Helper to create a valid state file JSON
function makeStateFile(overrides: Partial<PrStateFile> = {}): PrStateFile {
  const now = nowISO();
  return {
    prNumber: 1,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: computeExpiry(now),
    disbandRequested: null,
    ...overrides,
  };
}

// Helper to write a state file directly to test dir
async function writeStateFile(prNumber: number, data: PrStateFile): Promise<void> {
  const filePath = resolve(TEST_STATE_DIR, `pr-${prNumber}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// Capture console.log output
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

// ---- Tests ----

describe('scanner', () => {
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

  describe('validateState', () => {
    it('should accept valid states', () => {
      expect(validateState('reviewing')).toBe('reviewing');
      expect(validateState('approved')).toBe('approved');
      expect(validateState('closed')).toBe('closed');
    });

    it('should reject invalid states', () => {
      expect(() => validateState('rejected')).toThrow('Invalid state');
      expect(() => validateState('pending')).toThrow('Invalid state');
      expect(() => validateState('')).toThrow('Invalid state');
    });

    it('should not include rejected in valid states', () => {
      expect(VALID_STATES).not.toContain('rejected');
      expect(VALID_STATES).toEqual(['reviewing', 'approved', 'closed']);
    });
  });

  describe('computeExpiry', () => {
    it('should compute expiry as createdAt + 48 hours', () => {
      const createdAt = '2026-04-07T10:00:00Z';
      const expiresAt = computeExpiry(createdAt);
      expect(expiresAt).toBe('2026-04-09T10:00:00Z');
    });

    it('should produce valid UTC timestamp', () => {
      const now = nowISO();
      const expiry = computeExpiry(now);
      expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  // ---- Schema Validation Tests ----

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

    it('should reject non-number prNumber', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).prNumber = 'abc';
      expect(() => validateStateFileData(data, 'test.json')).toThrow('prNumber');
    });

    it('should reject zero prNumber', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).prNumber = 0;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('prNumber');
    });

    it('should accept null chatId', () => {
      const data = makeStateFile({ chatId: null });
      expect(() => validateStateFileData(data, 'test.json')).not.toThrow();
    });

    it('should accept string chatId', () => {
      const data = makeStateFile({ chatId: 'oc_abcdef123' });
      expect(() => validateStateFileData(data, 'test.json')).not.toThrow();
    });

    it('should reject non-string non-null chatId', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).chatId = 123;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('chatId');
    });

    it('should reject invalid state value', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).state = 'rejected';
      expect(() => validateStateFileData(data, 'test.json')).toThrow('state');
    });

    it('should reject invalid createdAt format', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).createdAt = '2026-04-07';
      expect(() => validateStateFileData(data, 'test.json')).toThrow('createdAt');
    });

    it('should reject non-null disbandRequested', () => {
      const data = makeStateFile();
      (data as Record<string, unknown>).disbandRequested = true;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('disbandRequested');
    });

    it('should reject missing updatedAt', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).updatedAt;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('updatedAt');
    });

    it('should reject missing expiresAt', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).expiresAt;
      expect(() => validateStateFileData(data, 'test.json')).toThrow('expiresAt');
    });
  });

  // ---- State File Creation Tests ----

  describe('createStateFile', () => {
    it('should create a state file with reviewing state', () => {
      const state = createStateFile(42, null);
      expect(state.prNumber).toBe(42);
      expect(state.state).toBe('reviewing');
      expect(state.chatId).toBeNull();
      expect(state.disbandRequested).toBeNull();
    });

    it('should set expiresAt to 48h after createdAt', () => {
      const state = createStateFile(1, null);
      const created = new Date(state.createdAt).getTime();
      const expires = new Date(state.expiresAt).getTime();
      const diffHours = (expires - created) / (1000 * 60 * 60);
      expect(diffHours).toBe(48);
    });

    it('should set createdAt and updatedAt to same time', () => {
      const state = createStateFile(1, null);
      expect(state.createdAt).toBe(state.updatedAt);
    });

    it('should accept a chatId', () => {
      const state = createStateFile(1, 'oc_test123');
      expect(state.chatId).toBe('oc_test123');
    });
  });

  // ---- Action: check-capacity ----

  describe('actionCheckCapacity', () => {
    it('should return zero capacity when no state files exist', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.reviewing).toBe(0);
        expect(result.maxConcurrent).toBe(3);
        expect(result.available).toBe(3);
      } finally {
        restore();
      }
    });

    it('should count reviewing PRs correctly', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(2, makeStateFile({ prNumber: 2, state: 'reviewing' }));
      await writeStateFile(3, makeStateFile({ prNumber: 3, state: 'approved' }));

      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.reviewing).toBe(2);
        expect(result.available).toBe(1);
      } finally {
        restore();
      }
    });

    it('should respect PR_SCANNER_MAX_REVIEWING env var', async () => {
      process.env.PR_SCANNER_MAX_REVIEWING = '5';

      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.maxConcurrent).toBe(5);
        expect(result.available).toBe(5);
      } finally {
        restore();
        delete process.env.PR_SCANNER_MAX_REVIEWING;
      }
    });

    it('should skip corrupted files', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
      // Write a corrupted file
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-999.json'),
        'not valid json{{{',
        'utf-8',
      );

      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        // Should count only the valid file
        expect(result.reviewing).toBe(1);
      } finally {
        restore();
      }
    });
  });

  // ---- Action: create-state ----

  describe('actionCreateState', () => {
    it('should create a new state file', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCreateState(42, null, TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.prNumber).toBe(42);
        expect(result.state).toBe('reviewing');
      } finally {
        restore();
      }

      // Verify file on disk
      const filePath = resolve(TEST_STATE_DIR, 'pr-42.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(42);
    });

    it('should be idempotent — return existing file if already exists', async () => {
      const existing = makeStateFile({ prNumber: 42, state: 'approved' });
      await writeStateFile(42, existing);

      const { output, restore } = captureLog();
      try {
        await actionCreateState(42, 'oc_new', TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        // Should return existing, not create new
        expect(result.state).toBe('approved');
      } finally {
        restore();
      }
    });

    it('should create file with chatId when provided', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCreateState(1, 'oc_chat123', TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.chatId).toBe('oc_chat123');
      } finally {
        restore();
      }
    });

    it('should follow strict schema §3.1', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCreateState(1, null, TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        // Verify all required fields
        expect(result).toHaveProperty('prNumber');
        expect(result).toHaveProperty('chatId');
        expect(result).toHaveProperty('state');
        expect(result).toHaveProperty('createdAt');
        expect(result).toHaveProperty('updatedAt');
        expect(result).toHaveProperty('expiresAt');
        expect(result).toHaveProperty('disbandRequested');
        expect(result.disbandRequested).toBeNull();
      } finally {
        restore();
      }
    });
  });

  // ---- Action: mark ----

  describe('actionMark', () => {
    it('should update state from reviewing to approved', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));

      const { output, restore } = captureLog();
      try {
        await actionMark(1, 'approved', TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.state).toBe('approved');
        expect(result.prNumber).toBe(1);
      } finally {
        restore();
      }
    });

    it('should update state from reviewing to closed', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));

      const { output, restore } = captureLog();
      try {
        await actionMark(1, 'closed', TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.state).toBe('closed');
      } finally {
        restore();
      }
    });

    it('should update updatedAt timestamp', async () => {
      const original = makeStateFile({ prNumber: 1, state: 'reviewing' });
      // Set a known old timestamp
      original.updatedAt = '2020-01-01T00:00:00Z';
      await writeStateFile(1, original);

      const { output, restore } = captureLog();
      try {
        await actionMark(1, 'approved', TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.updatedAt).not.toBe('2020-01-01T00:00:00Z');
        // Should be a recent timestamp
        expect(new Date(result.updatedAt).getTime()).toBeGreaterThan(
          new Date('2025-01-01').getTime(),
        );
      } finally {
        restore();
      }
    });

    it('should throw error for non-existent PR', async () => {
      await expect(actionMark(999, 'approved', TEST_STATE_DIR)).rejects.toThrow('State file not found');
    });

    it('should preserve other fields when updating state', async () => {
      const original = makeStateFile({
        prNumber: 5,
        chatId: 'oc_testchat',
        state: 'reviewing',
      });
      await writeStateFile(5, original);

      const { output, restore } = captureLog();
      try {
        await actionMark(5, 'approved', TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.prNumber).toBe(5);
        expect(result.chatId).toBe('oc_testchat');
        expect(result.createdAt).toBe(original.createdAt);
        expect(result.expiresAt).toBe(original.expiresAt);
        expect(result.disbandRequested).toBeNull();
      } finally {
        restore();
      }
    });

    it('should persist changes to disk', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
      await actionMark(1, 'approved', TEST_STATE_DIR);

      const filePath = resolve(TEST_STATE_DIR, 'pr-1.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.state).toBe('approved');
    });
  });

  // ---- Action: status ----

  describe('actionStatus', () => {
    it('should show no tracked PRs when directory is empty', async () => {
      const { output, restore } = captureLog();
      try {
        await actionStatus(TEST_STATE_DIR);
        expect(output[0]).toContain('No tracked PRs');
      } finally {
        restore();
      }
    });

    it('should group PRs by state', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(2, makeStateFile({ prNumber: 2, state: 'reviewing' }));
      await writeStateFile(3, makeStateFile({ prNumber: 3, state: 'approved' }));
      await writeStateFile(4, makeStateFile({ prNumber: 4, state: 'closed' }));

      const { output, restore } = captureLog();
      try {
        await actionStatus(TEST_STATE_DIR);
        const text = output.join('\n');
        expect(text).toContain('[reviewing]');
        expect(text).toContain('[approved]');
        expect(text).toContain('[closed]');
        expect(text).toContain('PR #1');
        expect(text).toContain('PR #2');
        expect(text).toContain('PR #3');
        expect(text).toContain('PR #4');
      } finally {
        restore();
      }
    });

    it('should report corrupted files', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-999.json'),
        'not valid json',
        'utf-8',
      );

      const { output, restore } = captureLog();
      try {
        await actionStatus(TEST_STATE_DIR);
        const text = output.join('\n');
        expect(text).toContain('[corrupted]');
        expect(text).toContain('pr-999.json');
      } finally {
        restore();
      }
    });

    it('should show count per state', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(2, makeStateFile({ prNumber: 2, state: 'reviewing' }));

      const { output, restore } = captureLog();
      try {
        await actionStatus(TEST_STATE_DIR);
        const text = output.join('\n');
        expect(text).toContain('[reviewing] (2)');
      } finally {
        restore();
      }
    });
  });

  // ---- Atomic Write Tests ----

  describe('atomicWrite', () => {
    it('should write file content correctly', async () => {
      const filePath = resolve(TEST_STATE_DIR, 'test-atomic.json');
      await atomicWrite(filePath, '{"test": true}');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('{"test": true}');
    });

    it('should overwrite existing file', async () => {
      const filePath = resolve(TEST_STATE_DIR, 'test-atomic.json');
      await atomicWrite(filePath, '{"v": 1}');
      await atomicWrite(filePath, '{"v": 2}');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('{"v": 2}');
    });
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('should handle empty state directory for check-capacity', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.reviewing).toBe(0);
        expect(result.available).toBe(3);
      } finally {
        restore();
      }
    });

    it('should handle empty state directory for status', async () => {
      const { output, restore } = captureLog();
      try {
        await actionStatus(TEST_STATE_DIR);
        expect(output[0]).toContain('No tracked PRs');
      } finally {
        restore();
      }
    });

    it('should handle non-JSON files in state directory gracefully', async () => {
      await writeFile(resolve(TEST_STATE_DIR, 'not-a-state.txt'), 'hello', 'utf-8');
      await writeFile(resolve(TEST_STATE_DIR, 'pr-README.md'), '# README', 'utf-8');

      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.reviewing).toBe(0);
      } finally {
        restore();
      }
    });

    it('should handle state file with extra fields', () => {
      const data = makeStateFile({ prNumber: 1 });
      (data as Record<string, unknown>).extraField = 'should be preserved';
      const json = JSON.stringify(data);
      const parsed = parseStateFile(json, 'test.json');
      expect((parsed as Record<string, unknown>).extraField).toBe('should be preserved');
    });

    it('should handle multiple state transitions', async () => {
      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));

      // reviewing -> approved
      let { output, restore } = captureLog();
      await actionMark(1, 'approved', TEST_STATE_DIR);
      let result = JSON.parse(output[0]);
      expect(result.state).toBe('approved');
      restore();

      // approved -> closed
      ({ output, restore } = captureLog());
      await actionMark(1, 'closed', TEST_STATE_DIR);
      result = JSON.parse(output[0]);
      expect(result.state).toBe('closed');
      restore();

      // Verify final state on disk
      const content = await readFile(resolve(TEST_STATE_DIR, 'pr-1.json'), 'utf-8');
      const final = JSON.parse(content);
      expect(final.state).toBe('closed');
    });

    it('should handle large PR numbers', async () => {
      const { output, restore } = captureLog();
      try {
        await actionCreateState(999999, null, TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.prNumber).toBe(999999);
      } finally {
        restore();
      }
    });

    it('should not affect unrelated JSON files in directory', async () => {
      const unrelatedPath = resolve(TEST_STATE_DIR, 'other-data.json');
      await writeFile(unrelatedPath, '{"unrelated": true}', 'utf-8');

      await writeStateFile(1, makeStateFile({ prNumber: 1, state: 'reviewing' }));

      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(TEST_STATE_DIR);
        const result = JSON.parse(output[0]);
        expect(result.reviewing).toBe(1);
      } finally {
        restore();
      }

      // Unrelated file should still exist
      const unrelatedContent = await readFile(unrelatedPath, 'utf-8');
      expect(unrelatedContent).toBe('{"unrelated": true}');
    });

    it('should handle non-existent directory for check-capacity', async () => {
      const nonExistentDir = resolve(process.cwd(), '.nonexistent-test-dir');
      const { output, restore } = captureLog();
      try {
        await actionCheckCapacity(nonExistentDir);
        const result = JSON.parse(output[0]);
        expect(result.reviewing).toBe(0);
        expect(result.available).toBe(3);
      } finally {
        restore();
      }
    });

    it('should handle non-existent directory for status', async () => {
      const nonExistentDir = resolve(process.cwd(), '.nonexistent-test-dir');
      const { output, restore } = captureLog();
      try {
        await actionStatus(nonExistentDir);
        expect(output[0]).toContain('No tracked PRs');
      } finally {
        restore();
      }
    });
  });

  // ---- stateFilePath helper ----

  describe('stateFilePath', () => {
    it('should return correct path for a PR number', () => {
      const path = stateFilePath(42, TEST_STATE_DIR);
      expect(path).toContain('pr-42.json');
    });
  });

  // ---- nowISO helper ----

  describe('nowISO', () => {
    it('should return valid UTC ISO format', () => {
      const now = nowISO();
      expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('should return a recent timestamp', () => {
      const before = Date.now();
      const now = new Date(nowISO()).getTime();
      const after = Date.now();
      // nowISO strips milliseconds, so it may be slightly before `after`
      expect(now).toBeGreaterThanOrEqual(before - 1000);
      expect(now).toBeLessThanOrEqual(after);
    });
  });
});
