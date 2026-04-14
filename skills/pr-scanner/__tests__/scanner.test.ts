/**
 * Unit tests for PR Scanner v2 scanner.ts and schema.ts.
 *
 * Tests all CLI actions, state file management, validation, and edge cases.
 * Runs without GitHub API access (fully offline).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat, chmod, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  parseStateFile,
  validateStateFileData,
  isValidState,
  parsePrNumberFromFileName,
  stateFilePath,
  createStateFile,
  computeExpiresAt,
  nowISO,
  type PrStateFile,
  ValidationError,
} from '../schema.js';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-test');

// Helper to run the scanner script
async function runScanner(
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/pr-scanner/scanner.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath, ...args], {
      env: { ...process.env, PR_SCANNER_STATE_DIR: TEST_STATE_DIR, ...env },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
      input: stdin,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      code: execErr.code ?? 1,
    };
  }
}

/** Create a valid state file JSON string */
function createStateJson(overrides: Partial<PrStateFile> = {}): string {
  const now = nowISO();
  const defaults: PrStateFile = {
    prNumber: 123,
    chatId: 'oc_test_chat',
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: computeExpiresAt(now),
    disbandRequested: null,
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

const TEST_PRS = [9001, 9002, 9003, 9004, 9005];

/** Directory for fake gh script (used in label tests) */
const FAKE_GH_DIR = resolve(PROJECT_ROOT, '.temp-fake-gh');

/** Create a fake gh script that always exits with error */
async function createFakeGh(): Promise<string> {
  await mkdir(FAKE_GH_DIR, { recursive: true });
  const fakeGhPath = resolve(FAKE_GH_DIR, 'gh');
  await writeFile(fakeGhPath, '#!/bin/sh\necho "gh not available" >&2\nexit 1\n', 'utf-8');
  await chmod(fakeGhPath, 0o755);
  return FAKE_GH_DIR;
}

async function cleanupFakeGh() {
  try {
    await rm(FAKE_GH_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

async function cleanupTestFiles() {
  for (const pr of TEST_PRS) {
    try {
      await rm(stateFilePath(TEST_STATE_DIR, pr), { force: true });
    } catch {
      // Ignore
    }
  }
}

// ============================================================================
// Schema unit tests
// ============================================================================

describe('schema', () => {
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
      expect(isValidState(null)).toBe(false);
      expect(isValidState(undefined)).toBe(false);
      expect(isValidState(123)).toBe(false);
    });
  });

  describe('parsePrNumberFromFileName', () => {
    it('should extract PR number from valid file names', () => {
      expect(parsePrNumberFromFileName('pr-123.json')).toBe(123);
      expect(parsePrNumberFromFileName('pr-1.json')).toBe(1);
      expect(parsePrNumberFromFileName('pr-99999.json')).toBe(99999);
    });

    it('should return null for invalid file names', () => {
      expect(parsePrNumberFromFileName('other.json')).toBeNull();
      expect(parsePrNumberFromFileName('pr-abc.json')).toBeNull();
      expect(parsePrNumberFromFileName('pr-.json')).toBeNull();
      expect(parsePrNumberFromFileName('123.json')).toBeNull();
    });
  });

  describe('stateFilePath', () => {
    it('should build correct path', () => {
      expect(stateFilePath('.temp-chats', 42)).toBe('.temp-chats/pr-42.json');
    });
  });

  describe('computeExpiresAt', () => {
    it('should add 48 hours to createdAt', () => {
      const createdAt = '2026-04-01T00:00:00Z';
      const expiresAt = computeExpiresAt(createdAt);
      const expected = new Date(new Date(createdAt).getTime() + 48 * 3600 * 1000).toISOString();
      expect(expiresAt).toBe(expected);
    });
  });

  describe('createStateFile', () => {
    it('should create a valid state file with defaults', () => {
      const state = createStateFile(42, 'oc_chat');
      expect(state.prNumber).toBe(42);
      expect(state.chatId).toBe('oc_chat');
      expect(state.state).toBe('reviewing');
      expect(state.disbandRequested).toBeNull();
      expect(state.createdAt).toBeTruthy();
      expect(state.updatedAt).toBeTruthy();
      expect(state.expiresAt).toBeTruthy();
    });

    it('should create state file with specified state', () => {
      const state = createStateFile(42, 'oc_chat', 'approved');
      expect(state.state).toBe('approved');
    });
  });

  describe('parseStateFile', () => {
    it('should parse valid JSON', () => {
      const json = createStateJson();
      const parsed = parseStateFile(json, 'test.json');
      expect(parsed.prNumber).toBe(123);
      expect(parsed.state).toBe('reviewing');
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseStateFile('not json{{{', 'test.json')).toThrow(ValidationError);
    });

    it('should throw on missing prNumber', () => {
      const json = JSON.stringify({ chatId: 'oc_x', state: 'reviewing', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null });
      expect(() => parseStateFile(json, 'test.json')).toThrow(ValidationError);
    });

    it('should throw on invalid state', () => {
      const json = createStateJson({ state: 'rejected' as never });
      expect(() => parseStateFile(json, 'test.json')).toThrow(ValidationError);
    });

    it('should throw on non-null disbandRequested', () => {
      const json = createStateJson({ disbandRequested: 'something' as never });
      expect(() => parseStateFile(json, 'test.json')).toThrow(ValidationError);
    });
  });

  describe('validateStateFileData', () => {
    it('should throw on array input', () => {
      expect(() => validateStateFileData([], 'test.json')).toThrow(ValidationError);
    });

    it('should throw on null input', () => {
      expect(() => validateStateFileData(null, 'test.json')).toThrow(ValidationError);
    });

    it('should throw on non-integer prNumber', () => {
      const json = createStateJson({ prNumber: 1.5 as never });
      expect(() => validateStateFileData(JSON.parse(json), 'test.json')).toThrow(ValidationError);
    });

    it('should throw on zero prNumber', () => {
      const json = createStateJson({ prNumber: 0 as never });
      expect(() => validateStateFileData(JSON.parse(json), 'test.json')).toThrow(ValidationError);
    });

    it('should throw on empty chatId', () => {
      const json = createStateJson({ chatId: '' });
      expect(() => validateStateFileData(JSON.parse(json), 'test.json')).toThrow(ValidationError);
    });

    it('should throw on invalid createdAt format', () => {
      const json = createStateJson({ createdAt: '2026-04-01' });
      expect(() => validateStateFileData(JSON.parse(json), 'test.json')).toThrow(ValidationError);
    });
  });
});

// ============================================================================
// CLI integration tests
// ============================================================================

describe('scanner CLI', () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  // ---- check-capacity ----

  describe('check-capacity', () => {
    it('should report full capacity with no reviewing PRs', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
      expect(data.maxConcurrent).toBe(3);
      expect(data.available).toBe(3);
    });

    it('should count reviewing PRs correctly', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));
      await writeFile(stateFilePath(TEST_STATE_DIR, 9002), createStateJson({ prNumber: 9002, state: 'reviewing' }));

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(2);
      expect(data.available).toBe(1);
    });

    it('should not count non-reviewing PRs', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'approved' }));
      await writeFile(stateFilePath(TEST_STATE_DIR, 9002), createStateJson({ prNumber: 9002, state: 'closed' }));

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
      expect(data.available).toBe(3);
    });

    it('should respect PR_SCANNER_MAX_CONCURRENT env', async () => {
      const result = await runScanner(['--action', 'check-capacity'], { PR_SCANNER_MAX_CONCURRENT: '5' });
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.maxConcurrent).toBe(5);
    });

    it('should skip corrupted state files', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), 'bad json{{{');
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
    });
  });

  // ---- create-state ----

  describe('create-state', () => {
    it('should create a new state file', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '9001', '--chatId', 'oc_test123']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(9001);
      expect(data.chatId).toBe('oc_test123');
      expect(data.state).toBe('reviewing');
      expect(data.disbandRequested).toBeNull();

      // Verify file on disk
      const fileContent = await readFile(stateFilePath(TEST_STATE_DIR, 9001), 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.prNumber).toBe(9001);
    });

    it('should fail if state file already exists', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001 }));
      const result = await runScanner(['--action', 'create-state', '--pr', '9001', '--chatId', 'oc_test123']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should fail without --pr', async () => {
      const result = await runScanner(['--action', 'create-state', '--chatId', 'oc_test123']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr and --chatId are required');
    });

    it('should fail without --chatId', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '9001']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr and --chatId are required');
    });

    it('should fail with invalid --pr value', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', 'abc', '--chatId', 'oc_test123']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid --pr value');
    });

    it('should set expiresAt to createdAt + 48h', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '9001', '--chatId', 'oc_test123']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      const created = new Date(data.createdAt);
      const expires = new Date(data.expiresAt);
      const diffHours = (expires.getTime() - created.getTime()) / (1000 * 3600);
      expect(diffHours).toBe(48);
    });
  });

  // ---- mark ----

  describe('mark', () => {
    it('should update state from reviewing to approved', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('approved');
      expect(data.prNumber).toBe(9001);

      // Verify on disk
      const fileContent = await readFile(stateFilePath(TEST_STATE_DIR, 9001), 'utf-8');
      expect(JSON.parse(fileContent).state).toBe('approved');
    });

    it('should update state to closed', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'closed']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('closed');
    });

    it('should update updatedAt timestamp', async () => {
      const original = createStateJson({ prNumber: 9001, state: 'reviewing', updatedAt: '2020-01-01T00:00:00Z' });
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), original);

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.updatedAt).not.toBe('2020-01-01T00:00:00Z');
    });

    it('should fail for non-existent PR', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '9999', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should fail with invalid state', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001 }));

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'rejected']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid state');
    });

    it('should fail without --pr or --state', async () => {
      const result = await runScanner(['--action', 'mark']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr and --state are required');
    });

    it('should fail for corrupted state file', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), 'not json{{{');

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Corrupted');
    });

    it('should preserve other fields when updating state', async () => {
      const original = createStateJson({ prNumber: 9001, chatId: 'oc_original', state: 'reviewing' });
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), original);

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.chatId).toBe('oc_original');
      expect(data.prNumber).toBe(9001);
      expect(data.disbandRequested).toBeNull();
    });
  });

  // ---- list-candidates ----

  describe('list-candidates', () => {
    it('should filter out already-tracked PRs', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001 }));

      const candidates = JSON.stringify([
        { number: 9001, title: 'PR 1' },
        { number: 9002, title: 'PR 2' },
        { number: 9003, title: 'PR 3' },
      ]);

      const result = await runScanner(['--action', 'list-candidates'], { PR_SCANNER_CANDIDATES: candidates });
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(2);
      expect(data.map((c: { number: number }) => c.number)).toEqual([9002, 9003]);
    });

    it('should return all candidates if none are tracked', async () => {
      const candidates = JSON.stringify([
        { number: 9001, title: 'PR 1' },
        { number: 9002, title: 'PR 2' },
      ]);

      const result = await runScanner(['--action', 'list-candidates'], { PR_SCANNER_CANDIDATES: candidates });
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(2);
    });

    it('should return empty array if all candidates are tracked', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001 }));

      const candidates = JSON.stringify([{ number: 9001, title: 'PR 1' }]);

      const result = await runScanner(['--action', 'list-candidates'], { PR_SCANNER_CANDIDATES: candidates });
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(0);
    });

    it('should fail on invalid JSON input', async () => {
      const result = await runScanner(['--action', 'list-candidates'], { PR_SCANNER_CANDIDATES: 'not json' });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Failed to parse');
    });
  });

  // ---- status ----

  describe('status', () => {
    it('should show no tracked PRs when empty', async () => {
      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('should group PRs by state', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));
      await writeFile(stateFilePath(TEST_STATE_DIR, 9002), createStateJson({ prNumber: 9002, state: 'approved' }));
      await writeFile(stateFilePath(TEST_STATE_DIR, 9003), createStateJson({ prNumber: 9003, state: 'closed' }));

      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('REVIEWING');
      expect(result.stdout).toContain('APPROVED');
      expect(result.stdout).toContain('CLOSED');
      expect(result.stdout).toContain('PR #9001');
      expect(result.stdout).toContain('PR #9002');
      expect(result.stdout).toContain('PR #9003');
    });

    it('should show total count', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001 }));
      await writeFile(stateFilePath(TEST_STATE_DIR, 9002), createStateJson({ prNumber: 9002 }));

      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('2 tracked PR(s)');
    });

    it('should show EXPIRED tag for expired entries', async () => {
      const expired = createStateJson({ prNumber: 9001, state: 'reviewing', expiresAt: '2020-01-01T00:00:00Z' });
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), expired);

      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('EXPIRED');
    });
  });

  // ---- General CLI ----

  describe('CLI validation', () => {
    it('should fail without --action', async () => {
      const result = await runScanner([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--action is required');
    });

    it('should fail with unknown action', async () => {
      const result = await runScanner(['--action', 'unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown action');
    });

    it('should handle empty state directory', async () => {
      // Use a non-existent directory
      const emptyDir = resolve(PROJECT_ROOT, '.temp-chats-empty-test');
      await rm(emptyDir, { recursive: true, force: true });

      const result = await runScanner(['--action', 'status'], { PR_SCANNER_STATE_DIR: emptyDir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');

      // Cleanup
      await rm(emptyDir, { recursive: true, force: true });
    });
  });

  // ---- --repo flag (GitHub Label integration) ----

  describe('--repo flag (label integration)', () => {
    let fakeGhDir: string;

    beforeEach(async () => {
      fakeGhDir = await createFakeGh();
    });

    afterEach(async () => {
      await cleanupFakeGh();
    });

    /** Build env with fake gh prepended to PATH */
    function envWithFakeGh(): Record<string, string> {
      return { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}` };
    }

    it('create-state with --repo should succeed and log WARN when gh fails', async () => {
      const result = await runScanner(
        ['--action', 'create-state', '--pr', '9001', '--chatId', 'oc_test123', '--repo', 'test/repo'],
        envWithFakeGh(),
      );
      // State file creation should succeed
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(9001);
      expect(data.state).toBe('reviewing');
      // Label failure should be logged as WARN
      expect(result.stderr).toContain('WARN');
    });

    it('create-state without --repo should not attempt label operations', async () => {
      const result = await runScanner(
        ['--action', 'create-state', '--pr', '9001', '--chatId', 'oc_test123'],
        envWithFakeGh(),
      );
      expect(result.code).toBe(0);
      // No WARN since no --repo means no label ops
      expect(result.stderr).not.toContain('WARN');
    });

    it('mark with --repo should log WARN when gh fails (reviewing → approved)', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(
        ['--action', 'mark', '--pr', '9001', '--state', 'approved', '--repo', 'test/repo'],
        envWithFakeGh(),
      );
      // State update should succeed
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('approved');
      // Label removal failure should be logged
      expect(result.stderr).toContain('WARN');
    });

    it('mark with --repo should log WARN when gh fails (reviewing → closed)', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(
        ['--action', 'mark', '--pr', '9001', '--state', 'closed', '--repo', 'test/repo'],
        envWithFakeGh(),
      );
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('closed');
      expect(result.stderr).toContain('WARN');
    });

    it('mark without --repo should not attempt label removal', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(
        ['--action', 'mark', '--pr', '9001', '--state', 'approved'],
        envWithFakeGh(),
      );
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('WARN');
    });

    it('mark approved→reviewing with --repo should NOT remove label (not leaving reviewing)', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'approved' }));

      const result = await runScanner(
        ['--action', 'mark', '--pr', '9001', '--state', 'reviewing', '--repo', 'test/repo'],
        envWithFakeGh(),
      );
      expect(result.code).toBe(0);
      // Previous state is 'approved', not 'reviewing', so no label removal attempted
      expect(result.stderr).not.toContain('WARN');
    });

    it('label failure should not corrupt state file', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), createStateJson({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(
        ['--action', 'mark', '--pr', '9001', '--state', 'approved', '--repo', 'test/repo'],
        envWithFakeGh(),
      );
      expect(result.code).toBe(0);

      // Verify state file was correctly updated despite label failure
      const fileContent = await readFile(stateFilePath(TEST_STATE_DIR, 9001), 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.state).toBe('approved');
      expect(fileData.prNumber).toBe(9001);
      expect(fileData.chatId).toBe('oc_test_chat');
    });
  });
});
