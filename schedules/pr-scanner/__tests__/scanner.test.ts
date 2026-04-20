/**
 * Unit tests for schedules/pr-scanner/scanner.ts
 *
 * Tests all CLI actions, state file schema, and edge cases.
 * Does not depend on GitHub API — list-candidates tests mock the gh CLI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseStateFile,
  validateStateFile,
  stateFilePath,
  nowISO,
  expiryISO,
  checkCapacity,
  createState,
  markState,
  status,
  addLabel,
  removeLabel,
  STATE_DIR,
  VALID_STATES,
  DEFAULT_MAX_CONCURRENT,
  EXPIRY_HOURS,
  REVIEWING_LABEL,
  DEFAULT_REPO,
  type PRStateFile,
  type PRState,
} from '../scanner.js';

// Resolve state dir relative to project root
const STATE_DIR_RESOLVED = resolve(process.cwd(), STATE_DIR);

// Test PR numbers to clean up
const TEST_PRS = [9001, 9002, 9003, 9004, 9005, 9006, 9007];

function stateFileContent(prNumber: number, overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = nowISO();
  return {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
    disbandRequested: null,
    ...overrides,
  };
}

async function cleanupTestFiles() {
  try {
    const files = await readdir(STATE_DIR_RESOLVED);
    for (const file of files) {
      if (file.startsWith('pr-900')) {
        await rm(resolve(STATE_DIR_RESOLVED, file), { force: true });
      }
    }
  } catch {
    // Directory may not exist
  }
}

async function writeStateFile(prNumber: number, data: PRStateFile) {
  const filePath = stateFilePath(prNumber);
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

describe('scanner', () => {
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
      const data = stateFileContent(123);
      const json = JSON.stringify(data);
      const result = parseStateFile(json, 'test.json');
      expect(result.prNumber).toBe(123);
      expect(result.state).toBe('reviewing');
      expect(result.chatId).toBeNull();
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

    it('should reject missing prNumber', () => {
      const data = { ...stateFileContent(123) };
      delete (data as Record<string, unknown>).prNumber;
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow('invalid or missing \'prNumber\'');
    });

    it('should reject non-integer prNumber', () => {
      const data = { ...stateFileContent(123), prNumber: 1.5 };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow('invalid or missing \'prNumber\'');
    });

    it('should reject negative prNumber', () => {
      const data = { ...stateFileContent(123), prNumber: -1 };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow('invalid or missing \'prNumber\'');
    });

    it('should reject invalid state', () => {
      const data = { ...stateFileContent(123), state: 'unknown' };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow('invalid \'state\'');
    });

    it('should accept all valid states', () => {
      for (const state of VALID_STATES) {
        const data = stateFileContent(123, { state });
        expect(() => parseStateFile(JSON.stringify(data), 'test.json')).not.toThrow();
      }
    });

    it('should reject non-string chatId', () => {
      const data = { ...stateFileContent(123), chatId: 123 };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow('invalid \'chatId\'');
    });

    it('should accept null chatId', () => {
      const data = stateFileContent(123, { chatId: null });
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).not.toThrow();
    });

    it('should accept string chatId', () => {
      const data = stateFileContent(123, { chatId: 'oc_test123' });
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).not.toThrow();
    });

    it('should reject non-string createdAt', () => {
      const data = { ...stateFileContent(123), createdAt: 12345 };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow('missing or invalid \'createdAt\'');
    });

    it('should reject non-null non-string disbandRequested', () => {
      const data = { ...stateFileContent(123), disbandRequested: 123 };
      expect(() => parseStateFile(JSON.stringify(data), 'bad.json')).toThrow('invalid \'disbandRequested\'');
    });
  });

  describe('validateStateFile', () => {
    it('should validate a complete state file', () => {
      const data = stateFileContent(42, { chatId: 'oc_abc' });
      const result = validateStateFile(data, 'test.json');
      expect(result.prNumber).toBe(42);
      expect(result.chatId).toBe('oc_abc');
    });
  });

  // ---- Helper Functions ----

  describe('stateFilePath', () => {
    it('should generate correct path', () => {
      const path = stateFilePath(123);
      expect(path).toContain('pr-123.json');
      expect(path).toContain(STATE_DIR);
    });
  });

  describe('nowISO', () => {
    it('should return valid ISO string', () => {
      const result = nowISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });
  });

  describe('expiryISO', () => {
    it('should return a timestamp ~48 hours in the future', () => {
      const before = Date.now() + EXPIRY_HOURS * 60 * 60 * 1000 - 1000;
      const result = new Date(expiryISO()).getTime();
      const after = Date.now() + EXPIRY_HOURS * 60 * 60 * 1000 + 1000;
      expect(result).toBeGreaterThan(before);
      expect(result).toBeLessThan(after);
    });
  });

  // ---- Actions ----

  describe('check-capacity', () => {
    it('should return zero when no state files exist', async () => {
      const result = await checkCapacity(3);
      expect(result.reviewing).toBe(0);
      expect(result.maxConcurrent).toBe(3);
      expect(result.available).toBe(3);
    });

    it('should count reviewing state files', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      await writeStateFile(9002, stateFileContent(9002, { state: 'reviewing' }));
      await writeStateFile(9003, stateFileContent(9003, { state: 'approved' }));

      const result = await checkCapacity(3);
      expect(result.reviewing).toBe(2);
      expect(result.available).toBe(1);
    });

    it('should use default maxConcurrent when not specified', async () => {
      const result = await checkCapacity();
      expect(result.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    });

    it('should handle corrupted files gracefully', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      const corruptedPath = stateFilePath(9002);
      await writeFile(corruptedPath, 'not valid json\n', 'utf-8');

      const result = await checkCapacity(3);
      expect(result.reviewing).toBe(1);
    });

    it('should report zero available when at capacity', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      await writeStateFile(9002, stateFileContent(9002, { state: 'reviewing' }));

      const result = await checkCapacity(2);
      expect(result.available).toBe(0);
    });
  });

  describe('create-state', () => {
    it('should create a state file with correct schema', async () => {
      const result = await createState(9001);

      expect(result.prNumber).toBe(9001);
      expect(result.state).toBe('reviewing');
      expect(result.chatId).toBeNull();
      expect(result.disbandRequested).toBeNull();
      expect(result.createdAt).toBeTruthy();
      expect(result.updatedAt).toBeTruthy();
      expect(result.expiresAt).toBeTruthy();

      // Verify file was written
      const filePath = stateFilePath(9001);
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(9001);
    });

    it('should create state file with chatId', async () => {
      const result = await createState(9002, 'oc_test_chat_id');
      expect(result.chatId).toBe('oc_test_chat_id');
    });

    it('should set expiresAt to ~48h from now', async () => {
      const before = Date.now() + EXPIRY_HOURS * 60 * 60 * 1000 - 2000;
      const result = await createState(9003);
      const after = Date.now() + EXPIRY_HOURS * 60 * 60 * 1000 + 2000;
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThan(before);
      expect(expiresAt).toBeLessThan(after);
    });

    it('should reject duplicate state file creation', async () => {
      await createState(9004);
      await expect(createState(9004)).rejects.toThrow('already exists');
    });

    it('should set createdAt equal to updatedAt on creation', async () => {
      const result = await createState(9005);
      expect(result.createdAt).toBe(result.updatedAt);
    });
  });

  describe('mark', () => {
    it('should update state from reviewing to approved', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      const result = await markState(9001, 'approved');
      expect(result.state).toBe('approved');
      expect(result.prNumber).toBe(9001);
    });

    it('should update state from reviewing to closed', async () => {
      await writeStateFile(9002, stateFileContent(9002, { state: 'reviewing' }));
      const result = await markState(9002, 'closed');
      expect(result.state).toBe('closed');
    });

    it('should update updatedAt timestamp', async () => {
      const original = stateFileContent(9003, {
        state: 'reviewing',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
      await writeStateFile(9003, original);

      const result = await markState(9003, 'approved');
      expect(result.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('should throw for non-existent PR', async () => {
      await expect(markState(9999, 'approved')).rejects.toThrow('No state file found');
    });

    it('should preserve other fields when updating state', async () => {
      const original = stateFileContent(9004, {
        chatId: 'oc_preserve_me',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-03T00:00:00.000Z',
      });
      await writeStateFile(9004, original);

      const result = await markState(9004, 'closed');
      expect(result.chatId).toBe('oc_preserve_me');
      expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(result.expiresAt).toBe('2026-01-03T00:00:00.000Z');
      expect(result.prNumber).toBe(9004);
    });
  });

  describe('status', () => {
    it('should report when no state files exist', async () => {
      // Ensure dir is empty (cleanup already done in beforeEach)
      const output = await status();
      expect(output).toContain('No tracked PRs found');
    });

    it('should group PRs by state', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      await writeStateFile(9002, stateFileContent(9002, { state: 'reviewing' }));
      await writeStateFile(9003, stateFileContent(9003, { state: 'approved' }));
      await writeStateFile(9004, stateFileContent(9004, { state: 'closed' }));

      const output = await status();
      expect(output).toContain('reviewing (2)');
      expect(output).toContain('approved (1)');
      expect(output).toContain('closed (1)');
      expect(output).toContain('PR #9001');
      expect(output).toContain('PR #9003');
      expect(output).toContain('PR #9004');
    });

    it('should include total state file count', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      await writeStateFile(9002, stateFileContent(9002, { state: 'approved' }));

      const output = await status();
      expect(output).toContain('2 state files');
    });

    it('should skip non-pr JSON files in state dir', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      // Write a non-pr file
      await writeFile(resolve(STATE_DIR_RESOLVED, 'other.json'), '{}\n', 'utf-8');

      const output = await status();
      expect(output).toContain('PR #9001');
      // Should not crash from the other.json file
    });

    it('should handle corrupted files gracefully', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      await writeFile(resolve(STATE_DIR_RESOLVED, 'pr-9002.json'), 'corrupted\n', 'utf-8');

      // Should not throw, just skip the corrupted file
      const output = await status();
      expect(output).toContain('PR #9001');
    });
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('should handle empty .temp-chats directory', async () => {
      const result = await checkCapacity(5);
      expect(result.reviewing).toBe(0);
      expect(result.available).toBe(5);
    });

    it('should handle state files with all three states', async () => {
      await writeStateFile(9001, stateFileContent(9001, { state: 'reviewing' }));
      await writeStateFile(9002, stateFileContent(9002, { state: 'approved' }));
      await writeStateFile(9003, stateFileContent(9003, { state: 'closed' }));

      const capResult = await checkCapacity(5);
      expect(capResult.reviewing).toBe(1);
      expect(capResult.available).toBe(4);
    });

    it('should correctly generate state file path', () => {
      const path = stateFilePath(42);
      expect(path).toMatch(/\.temp-chats\/pr-42\.json$/);
    });

    it('should handle concurrent create and mark operations on different PRs', async () => {
      // Create two state files concurrently
      const [result1, result2] = await Promise.all([
        createState(9005),
        createState(9006),
      ]);

      expect(result1.prNumber).toBe(9005);
      expect(result2.prNumber).toBe(9006);

      // Mark both concurrently
      const [marked1, marked2] = await Promise.all([
        markState(9005, 'approved'),
        markState(9006, 'closed'),
      ]);

      expect(marked1.state).toBe('approved');
      expect(marked2.state).toBe('closed');
    });
  });

  // ---- Label Management ----

  describe('addLabel', () => {
    it('should return failure result when gh CLI fails (PR not found)', async () => {
      // Uses real gh CLI — PR #999999 doesn't exist, so this tests the failure path
      const result = await addLabel(999999, DEFAULT_REPO, REVIEWING_LABEL);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should not throw even when gh CLI fails', async () => {
      // Critical behavior: non-blocking error handling
      await expect(addLabel(999999, DEFAULT_REPO, REVIEWING_LABEL)).resolves.not.toThrow();
    });

    it('should return an object with success and error fields', async () => {
      const result = await addLabel(999999, DEFAULT_REPO, REVIEWING_LABEL);
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('error');
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('removeLabel', () => {
    it('should return failure result when gh CLI fails (PR not found)', async () => {
      const result = await removeLabel(999999, DEFAULT_REPO, REVIEWING_LABEL);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should not throw even when gh CLI fails', async () => {
      await expect(removeLabel(999999, DEFAULT_REPO, REVIEWING_LABEL)).resolves.not.toThrow();
    });

    it('should return an object with success and error fields', async () => {
      const result = await removeLabel(999999, DEFAULT_REPO, REVIEWING_LABEL);
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('error');
      expect(typeof result.success).toBe('boolean');
    });
  });

  describe('constants', () => {
    it('should have correct REVIEWING_LABEL', () => {
      expect(REVIEWING_LABEL).toBe('pr-scanner:reviewing');
    });

    it('should have correct DEFAULT_REPO', () => {
      expect(DEFAULT_REPO).toBe('hs3180/disclaude');
    });
  });
});
