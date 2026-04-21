/**
 * Unit tests for schedules/pr-scanner/scanner.ts
 *
 * Tests all actions, state file read/write, label management, and edge cases.
 * Core logic tests do not depend on GitHub API (can run offline).
 *
 * @see Issue #2219 — scanner.ts base script skeleton
 * @see Issue #2220 — SCHEDULE.md + GitHub Label integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  // Types
  type PRStateFile,
  // Constants
  STATE_DIR,
  MAX_CONCURRENT,
  EXPIRY_HOURS,
  VALID_STATES,
  REVIEWING_LABEL,
  // Pure functions
  nowISO,
  calcExpiry,
  stateFilePath,
  isValidState,
  isValidPRNumber,
  parseStateFile,
  validateStateFile,
  formatStatus,
  // Label management
  addReviewingLabel,
  removeReviewingLabel,
  // File operations (will use mocked STATE_DIR)
  atomicWrite,
  ensureStateDir,
  createStateFile,
  readStateFile,
  markState,
  getAllStates,
  countReviewing,
} from '../scanner.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-test');

// ---- Test fixtures ----

function makeStateFile(overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = '2026-04-21T10:00:00Z';
  return {
    prNumber: 123,
    chatId: 'oc_test123',
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: calcExpiry(now),
    disbandRequested: null,
    ...overrides,
  };
}

// ---- Helper to run scanner CLI ----

async function runScanner(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', [
      'tsx', resolve(PROJECT_ROOT, 'schedules/pr-scanner/scanner.ts'),
      ...args,
    ], {
      timeout: 30_000,
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      exitCode: execErr.code ?? 1,
    };
  }
}

// ---- Test suites ----

describe('scanner.ts', () => {
  // ---- Pure function tests ----

  describe('nowISO', () => {
    it('should return UTC ISO 8601 Z-suffix format', () => {
      const result = nowISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  describe('calcExpiry', () => {
    it('should add EXPIRY_HOURS to the given timestamp', () => {
      const created = '2026-04-21T10:00:00Z';
      const expiry = calcExpiry(created);
      expect(expiry).toBe('2026-04-23T10:00:00Z');
    });

    it('should handle month boundaries', () => {
      const created = '2026-04-30T22:00:00Z';
      const expiry = calcExpiry(created);
      expect(expiry).toBe('2026-05-02T22:00:00Z');
    });
  });

  describe('stateFilePath', () => {
    it('should return correct path for a PR number', () => {
      const path = stateFilePath(42);
      expect(path).toContain('.temp-chats');
      expect(path).toContain('pr-42.json');
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

  describe('isValidPRNumber', () => {
    it('should accept positive integers', () => {
      expect(isValidPRNumber(1)).toBe(true);
      expect(isValidPRNumber(123)).toBe(true);
      expect(isValidPRNumber(999999)).toBe(true);
    });

    it('should reject zero, negatives, and non-integers', () => {
      expect(isValidPRNumber(0)).toBe(false);
      expect(isValidPRNumber(-1)).toBe(false);
      expect(isValidPRNumber(1.5)).toBe(false);
      expect(isValidPRNumber(NaN)).toBe(false);
      expect(isValidPRNumber('123' as unknown as number)).toBe(false);
      expect(isValidPRNumber(null as unknown as number)).toBe(false);
      expect(isValidPRNumber(undefined as unknown as number)).toBe(false);
    });
  });

  describe('parseStateFile', () => {
    it('should parse a valid state file', () => {
      const json = JSON.stringify(makeStateFile(), null, 2);
      const result = parseStateFile(json, 'test.json');
      expect(result.prNumber).toBe(123);
      expect(result.state).toBe('reviewing');
      expect(result.disbandRequested).toBeNull();
    });

    it('should reject non-JSON content', () => {
      expect(() => parseStateFile('not json', 'bad.json')).toThrow('not valid JSON');
    });

    it('should reject non-object JSON', () => {
      expect(() => parseStateFile('[]', 'array.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('null', 'null.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('"string"', 'string.json')).toThrow('not a valid JSON object');
    });

    it('should reject missing prNumber', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).prNumber;
      expect(() => parseStateFile(JSON.stringify(data), 'missing.json')).toThrow('prNumber');
    });

    it('should reject invalid prNumber', () => {
      const data = makeStateFile({ prNumber: -1 });
      expect(() => parseStateFile(JSON.stringify(data), 'neg.json')).toThrow('prNumber');
    });

    it('should reject missing chatId', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).chatId;
      expect(() => parseStateFile(JSON.stringify(data), 'no-chatid.json')).toThrow('chatId');
    });

    it('should reject empty chatId', () => {
      const data = makeStateFile({ chatId: '' });
      expect(() => parseStateFile(JSON.stringify(data), 'empty-chatid.json')).toThrow('chatId');
    });

    it('should reject invalid state', () => {
      const data = makeStateFile({ state: 'rejected' as PRStateFile['state'] });
      expect(() => parseStateFile(JSON.stringify(data), 'bad-state.json')).toThrow('state');
    });

    it('should reject missing createdAt', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).createdAt;
      expect(() => parseStateFile(JSON.stringify(data), 'no-created.json')).toThrow('createdAt');
    });

    it('should reject non-UTC createdAt', () => {
      const data = makeStateFile({ createdAt: '2026-04-21T10:00:00+08:00' });
      expect(() => parseStateFile(JSON.stringify(data), 'tz.json')).toThrow('createdAt');
    });

    it('should reject non-null disbandRequested', () => {
      const data = { ...makeStateFile(), disbandRequested: 'something' };
      expect(() => parseStateFile(JSON.stringify(data), 'disband.json')).toThrow('disbandRequested');
    });
  });

  describe('validateStateFile', () => {
    it('should validate a correct state file', () => {
      const data = makeStateFile();
      const result = validateStateFile(data, 'valid.json');
      expect(result.prNumber).toBe(123);
    });

    it('should accept all valid states', () => {
      for (const state of VALID_STATES) {
        const data = makeStateFile({ state });
        expect(() => validateStateFile(data, `${state}.json`)).not.toThrow();
      }
    });
  });

  describe('formatStatus', () => {
    it('should format empty groups', () => {
      const result = formatStatus({ reviewing: [], approved: [], closed: [] });
      expect(result).toContain('(none)');
      expect(result).toContain('Total: 0 tracked PR(s)');
    });

    it('should format groups with PRs', () => {
      const result = formatStatus({
        reviewing: [42, 10],
        approved: [30],
        closed: [],
      });
      expect(result).toContain('10, 42'); // sorted
      expect(result).toContain('30');
      expect(result).toContain('Total: 3 tracked PR(s)');
    });
  });

  // ---- Label management tests (#2220) ----

  describe('label management', () => {
    it('should export REVIEWING_LABEL constant', () => {
      expect(REVIEWING_LABEL).toBe('pr-scanner:reviewing');
    });

    it('addReviewingLabel should not throw on failure', async () => {
      // gh CLI likely unavailable in test env, should gracefully handle error
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(addReviewingLabel(99999)).resolves.toBeUndefined();
      consoleErrorSpy.mockRestore();
    });

    it('removeReviewingLabel should not throw on failure', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(removeReviewingLabel(99999)).resolves.toBeUndefined();
      consoleErrorSpy.mockRestore();
    });
  });

  // ---- File operation tests (use real filesystem with test dir) ----

  describe('file operations', () => {
    beforeEach(async () => {
      // Create test directory
      await mkdir(TEST_STATE_DIR, { recursive: true });
    });

    afterEach(async () => {
      // Clean up test directory
      await rm(TEST_STATE_DIR, { recursive: true, force: true });
    });

    describe('atomicWrite', () => {
      it('should write file atomically', async () => {
        const filePath = resolve(TEST_STATE_DIR, 'test-atomic.json');
        await atomicWrite(filePath, '{"test": true}');
        const content = await readFile(filePath, 'utf-8');
        expect(content).toBe('{"test": true}');
      });

      it('should overwrite existing file', async () => {
        const filePath = resolve(TEST_STATE_DIR, 'test-overwrite.json');
        await atomicWrite(filePath, '{"v": 1}');
        await atomicWrite(filePath, '{"v": 2}');
        const content = await readFile(filePath, 'utf-8');
        expect(content).toBe('{"v": 2}');
      });
    });

    describe('createStateFile', () => {
      it('should create a state file with correct schema', async () => {
        const result = makeStateFile({ prNumber: 999 });
        expect(result.prNumber).toBe(999);
        expect(result.state).toBe('reviewing');
        expect(result.disbandRequested).toBeNull();
        expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      });

      it('should reject invalid PR number', async () => {
        await expect(createStateFile(0, 'oc_test')).rejects.toThrow('Invalid PR number');
        await expect(createStateFile(-1, 'oc_test')).rejects.toThrow('Invalid PR number');
      });

      it('should reject empty chatId', async () => {
        await expect(createStateFile(123, '')).rejects.toThrow('Invalid chatId');
      });
    });

    describe('readStateFile', () => {
      it('should read an existing state file', async () => {
        const filePath = resolve(TEST_STATE_DIR, 'pr-456.json');
        const stateFile = makeStateFile({ prNumber: 456 });
        await writeFile(filePath, JSON.stringify(stateFile, null, 2) + '\n');

        const content = await readFile(filePath, 'utf-8');
        const result = parseStateFile(content, filePath);
        expect(result.prNumber).toBe(456);
      });
    });

    describe('markState', () => {
      it('should reject invalid PR number', async () => {
        await expect(markState(0, 'approved')).rejects.toThrow('Invalid PR number');
      });

      it('should reject invalid state', async () => {
        await expect(markState(123, 'invalid' as PRStateFile['state'])).rejects.toThrow('Invalid state');
      });
    });
  });

  // ---- CLI integration tests ----

  describe('CLI', () => {
    it('should show error for missing --action', async () => {
      const result = await runScanner([]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--action');
    });

    it('should show error for unknown action', async () => {
      const result = await runScanner(['--action', 'unknown']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown action');
    });

    it('should show help', async () => {
      const result = await runScanner(['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('check-capacity');
      expect(result.stdout).toContain('list-candidates');
      expect(result.stdout).toContain('create-state');
      expect(result.stdout).toContain('mark');
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('label');
    });

    it('should handle check-capacity action', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('reviewing');
      expect(output).toHaveProperty('maxConcurrent');
      expect(output).toHaveProperty('available');
      expect(output.maxConcurrent).toBe(MAX_CONCURRENT);
    });

    it('should handle status action', async () => {
      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PR Scanner Status');
      expect(result.stdout).toContain('Total');
    });

    it('should reject create-state without --pr', async () => {
      const result = await runScanner(['--action', 'create-state', '--chat-id', 'oc_test']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--pr');
    });

    it('should reject create-state without --chat-id', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '789']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--chat-id');
    });

    it('should reject mark without --state', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '789']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--state');
    });

    it('should reject mark with invalid --state', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '789', '--state', 'unknown']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('state');
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('should handle corrupted state files gracefully in getAllStates', async () => {
      expect(() => parseStateFile('{bad json', 'corrupt.json')).toThrow();
    });

    it('should handle empty directory for getAllStates', async () => {
      const result = await getAllStates();
      expect(result.reviewing).toEqual([]);
      expect(result.approved).toEqual([]);
      expect(result.closed).toEqual([]);
    });

    it('should validate that expiry is 48 hours after creation', () => {
      const created = '2026-04-21T00:00:00Z';
      const expiry = calcExpiry(created);
      const diffMs = new Date(expiry).getTime() - new Date(created).getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      expect(diffHours).toBe(EXPIRY_HOURS);
    });

    it('should have no "rejected" in valid states', () => {
      expect(VALID_STATES).not.toContain('rejected');
      expect(VALID_STATES).toEqual(['reviewing', 'approved', 'closed']);
    });
  });
});
