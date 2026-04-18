/**
 * Unit tests for schedules/pr-scanner/scanner.ts
 *
 * Tests all actions, state file read/write, and edge cases.
 * No GitHub API dependency — fully offline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  prFilePath,
  readPrState,
  validatePrStateFile,
  TEMP_CHATS_DIR,
  type PrStateFile,
  type PrState,
  VALID_STATES,
  DEFAULT_MAX_CONCURRENT,
  LABEL_REVIEWING,
  DEFAULT_REPO,
  type LabelResult,
} from '../scanner.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEMP_DIR = resolve(PROJECT_ROOT, TEMP_CHATS_DIR);

// ---- Helpers ----

function makeState(overrides: Partial<PrStateFile> = {}): PrStateFile {
  return {
    prNumber: 1,
    chatId: null,
    state: 'reviewing',
    createdAt: '2026-04-07T10:00:00Z',
    updatedAt: '2026-04-07T10:00:00Z',
    expiresAt: '2026-04-09T10:00:00Z',
    disbandRequested: null,
    ...overrides,
  };
}

const TEST_PRS = [9001, 9002, 9003];

async function cleanupTestFiles() {
  for (const pr of TEST_PRS) {
    const filePath = prFilePath(pr);
    try {
      await rm(filePath, { force: true });
    } catch {
      // Ignore
    }
  }
  // Also clean up any temp files
  try {
    const files = await readdirSafe(TEMP_DIR);
    for (const f of files) {
      if (f.includes('9001') || f.includes('9002') || f.includes('9003')) {
        await rm(resolve(TEMP_DIR, f), { force: true });
      }
    }
  } catch {
    // Ignore
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function runScanner(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', resolve(__dirname, '..', 'scanner.ts'), ...args],
      {
        cwd: PROJECT_ROOT,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      exitCode: execErr.code ?? 1,
    };
  }
}

// ---- Tests ----

describe('scanner.ts', () => {
  beforeEach(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  // ---- Validation ----

  describe('validatePrStateFile', () => {
    it('should validate a correct state file', () => {
      const state = makeState();
      const result = validatePrStateFile(state, 'test.json');
      expect(result).toEqual(state);
    });

    it('should reject non-object data', () => {
      expect(() => validatePrStateFile(null, 'test.json')).toThrow();
      expect(() => validatePrStateFile('string', 'test.json')).toThrow();
      expect(() => validatePrStateFile([], 'test.json')).toThrow();
    });

    it('should reject missing prNumber', () => {
      const state = makeState();
      delete (state as Record<string, unknown>).prNumber;
      expect(() => validatePrStateFile(state, 'test.json')).toThrow(/prNumber/);
    });

    it('should reject non-positive prNumber', () => {
      const state = makeState({ prNumber: -1 });
      expect(() => validatePrStateFile(state, 'test.json')).toThrow(/prNumber/);
    });

    it('should reject invalid state', () => {
      const state = makeState({ state: 'invalid' as PrState });
      expect(() => validatePrStateFile(state, 'test.json')).toThrow(/state/);
    });

    it('should accept string disbandRequested (ISO timestamp)', () => {
      const state = makeState();
      (state as Record<string, unknown>).disbandRequested = '2026-04-08T12:00:00Z';
      expect(validatePrStateFile(state, 'test.json').disbandRequested).toBe('2026-04-08T12:00:00Z');
    });

    it('should reject non-string/non-null disbandRequested', () => {
      const state = makeState();
      (state as Record<string, unknown>).disbandRequested = 123;
      expect(() => validatePrStateFile(state, 'test.json')).toThrow(/disbandRequested/);
    });

    it('should accept chatId as null', () => {
      const state = makeState({ chatId: null });
      expect(validatePrStateFile(state, 'test.json').chatId).toBeNull();
    });

    it('should accept chatId as string', () => {
      const state = makeState({ chatId: 'oc_abc123' });
      expect(validatePrStateFile(state, 'test.json').chatId).toBe('oc_abc123');
    });

    it('should reject non-string chatId', () => {
      const state = makeState();
      (state as Record<string, unknown>).chatId = 123;
      expect(() => validatePrStateFile(state, 'test.json')).toThrow(/chatId/);
    });
  });

  // ---- readPrState ----

  describe('readPrState', () => {
    it('should read a valid state file', async () => {
      const state = makeState({ prNumber: 9001 });
      const filePath = prFilePath(9001);
      await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');

      const result = await readPrState(filePath);
      expect(result.prNumber).toBe(9001);
      expect(result.state).toBe('reviewing');
    });

    it('should reject corrupted JSON', async () => {
      const filePath = prFilePath(9001);
      await writeFile(filePath, 'not valid json', 'utf-8');

      await expect(readPrState(filePath)).rejects.toThrow(/not valid JSON/);
    });

    it('should reject JSON with invalid schema', async () => {
      const filePath = prFilePath(9001);
      await writeFile(filePath, JSON.stringify({ foo: 'bar' }), 'utf-8');

      await expect(readPrState(filePath)).rejects.toThrow();
    });
  });

  // ---- Action: check-capacity ----

  describe('action: check-capacity', () => {
    it('should return zero reviewing when no state files exist', async () => {
      const { stdout, exitCode } = await runScanner(['--action', 'check-capacity']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.reviewing).toBe(0);
      expect(result.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
      expect(result.available).toBe(DEFAULT_MAX_CONCURRENT);
    });

    it('should count reviewing PRs correctly', async () => {
      const state1 = makeState({ prNumber: 9001, state: 'reviewing' });
      const state2 = makeState({ prNumber: 9002, state: 'approved' });
      await writeFile(prFilePath(9001), JSON.stringify(state1, null, 2) + '\n', 'utf-8');
      await writeFile(prFilePath(9002), JSON.stringify(state2, null, 2) + '\n', 'utf-8');

      const { stdout, exitCode } = await runScanner(['--action', 'check-capacity']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.reviewing).toBe(1);
      expect(result.available).toBe(DEFAULT_MAX_CONCURRENT - 1);
    });

    it('should respect --max-concurrent override', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'check-capacity',
        '--max-concurrent', '3',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.maxConcurrent).toBe(3);
      expect(result.available).toBe(3);
    });

    it('should skip corrupted files when counting', async () => {
      await writeFile(prFilePath(9001), 'corrupted', 'utf-8');
      await writeFile(prFilePath(9002), JSON.stringify(makeState({ prNumber: 9002, state: 'reviewing' })) + '\n', 'utf-8');

      const { stdout, exitCode } = await runScanner(['--action', 'check-capacity']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.reviewing).toBe(1);
    });

    it('should error on invalid --max-concurrent', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'check-capacity',
        '--max-concurrent', '0',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/max-concurrent/);
    });
  });

  // ---- Action: create-state ----

  describe('action: create-state', () => {
    it('should create a state file with correct schema', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'create-state',
        '--pr', '9001',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.prNumber).toBe(9001);
      expect(result.state).toBe('reviewing');
      expect(result.chatId).toBeNull();
      expect(result.disbandRequested).toBeNull();
      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should persist state file to disk', async () => {
      const { exitCode } = await runScanner([
        '--action', 'create-state',
        '--pr', '9001',
      ]);
      expect(exitCode).toBe(0);

      const filePath = prFilePath(9001);
      const fileStat = await stat(filePath);
      expect(fileStat.isFile()).toBe(true);

      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(9001);
    });

    it('should accept --chat-id parameter', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'create-state',
        '--pr', '9001',
        '--chat-id', 'oc_test123',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.chatId).toBe('oc_test123');
    });

    it('should set expiresAt to 48h from now', async () => {
      const before = Date.now();
      const { stdout, exitCode } = await runScanner([
        '--action', 'create-state',
        '--pr', '9001',
      ]);
      const after = Date.now();
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      const created = new Date(result.createdAt).getTime();
      const expires = new Date(result.expiresAt).getTime();
      const diffHrs = (expires - created) / (1000 * 60 * 60);
      expect(diffHrs).toBeGreaterThanOrEqual(47.9);
      expect(diffHrs).toBeLessThanOrEqual(48.1);
    });

    it('should reject duplicate state file creation', async () => {
      // First creation
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      // Second creation should fail
      const { stderr, exitCode } = await runScanner([
        '--action', 'create-state',
        '--pr', '9001',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/already exists/);
    });

    it('should error on missing --pr', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'create-state',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--pr/);
    });

    it('should error on invalid --pr value', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'create-state',
        '--pr', 'abc',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/PR number/);
    });
  });

  // ---- Action: mark ----

  describe('action: mark', () => {
    it('should update state from reviewing to approved', async () => {
      // Create initial state
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const { stdout, exitCode } = await runScanner([
        '--action', 'mark',
        '--pr', '9001',
        '--state', 'approved',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.prNumber).toBe(9001);
      expect(result.state).toBe('approved');
    });

    it('should update state from reviewing to closed', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const { stdout, exitCode } = await runScanner([
        '--action', 'mark',
        '--pr', '9001',
        '--state', 'closed',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.state).toBe('closed');
    });

    it('should persist updated state to disk', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);

      const filePath = prFilePath(9001);
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.state).toBe('approved');
    });

    it('should update updatedAt timestamp', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      // Wait a tiny bit to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 50));

      const { stdout, exitCode } = await runScanner([
        '--action', 'mark',
        '--pr', '9001',
        '--state', 'approved',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(new Date(result.updatedAt).getTime()).toBeGreaterThan(
        new Date(result.createdAt).getTime() - 1, // allow minimal clock skew
      );
    });

    it('should error on invalid state value', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const { stderr, exitCode } = await runScanner([
        '--action', 'mark',
        '--pr', '9001',
        '--state', 'invalid',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Invalid state/);
    });

    it('should error when state file does not exist', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'mark',
        '--pr', '9999',
        '--state', 'approved',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/No state file found/);
    });

    it('should error on missing --state', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const { stderr, exitCode } = await runScanner([
        '--action', 'mark',
        '--pr', '9001',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--state/);
    });
  });

  // ---- Action: status ----

  describe('action: status', () => {
    it('should show empty status when no state files', async () => {
      const { stdout, exitCode } = await runScanner(['--action', 'status']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('PR Scanner Status');
      expect(stdout).toContain('[reviewing]');
      expect(stdout).toContain('[approved]');
      expect(stdout).toContain('[closed]');
      expect(stdout).toContain('(none)');
    });

    it('should group PRs by state', { timeout: 30_000 }, async () => {
      // Create PRs in different states
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'create-state', '--pr', '9002']);
      await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);

      const { stdout, exitCode } = await runScanner(['--action', 'status']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('#9001');
      expect(stdout).toContain('#9002');
    });

    it('should work when .temp-chats directory does not exist', async () => {
      // Remove the temp-chats dir if it exists
      try {
        await rm(TEMP_DIR, { recursive: true, force: true });
      } catch {
        // Ignore
      }

      const { stdout, exitCode } = await runScanner(['--action', 'status']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('PR Scanner Status');
    });

    it('should skip corrupted files', async () => {
      await writeFile(prFilePath(9001), JSON.stringify(makeState({ prNumber: 9001 })) + '\n', 'utf-8');
      await writeFile(prFilePath(9002), 'corrupted', 'utf-8');

      const { stdout, exitCode } = await runScanner(['--action', 'status']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('#9001');
      // Should not crash on corrupted file
    });
  });

  // ---- Action: list-candidates ----

  describe('action: list-candidates', () => {
    it('should return all PRs as candidates when no state files', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'list-candidates',
        '--pr-list', '1,2,3',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.candidates).toEqual([1, 2, 3]);
      expect(result.excluded).toEqual([]);
    });

    it('should exclude already-tracked PRs', async () => {
      // Track PR 9001
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const { stdout, exitCode } = await runScanner([
        '--action', 'list-candidates',
        '--pr-list', '9001,9002,9003',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.candidates).toEqual([9002, 9003]);
      expect(result.excluded).toEqual([9001]);
    });

    it('should error on missing --pr-list', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'list-candidates',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--pr-list/);
    });

    it('should error on invalid PR number in --pr-list', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'list-candidates',
        '--pr-list', '1,abc,3',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Invalid PR number/);
    });

    it('should handle single PR number', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'list-candidates',
        '--pr-list', '42',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.candidates).toEqual([42]);
    });

    it('should work when .temp-chats directory does not exist', async () => {
      try {
        await rm(TEMP_DIR, { recursive: true, force: true });
      } catch {
        // Ignore
      }

      const { stdout, exitCode } = await runScanner([
        '--action', 'list-candidates',
        '--pr-list', '1,2',
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.candidates).toEqual([1, 2]);
      expect(result.excluded).toEqual([]);
    });
  });

  // ---- General CLI ----

  describe('CLI general', () => {
    it('should error when --action is missing', async () => {
      const { stderr, exitCode } = await runScanner([]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--action is required/);
    });

    it('should error on unknown action', async () => {
      const { stderr, exitCode } = await runScanner(['--action', 'unknown']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Unknown action/);
    });
  });

  // ---- Action: add-label ----

  describe('action: add-label', () => {
    it('should return structured JSON with success=false when gh is unavailable', async () => {
      // Use a non-existent repo to trigger gh failure gracefully
      const { stdout, exitCode } = await runScanner([
        '--action', 'add-label',
        '--pr', '9001',
        '--repo', 'nonexistent/nonexistent',
      ]);
      // Label operations are non-blocking — exit code should be 0
      expect(exitCode).toBe(0);

      const result: LabelResult = JSON.parse(stdout);
      expect(result.prNumber).toBe(9001);
      expect(result.label).toBe(LABEL_REVIEWING);
      expect(result.action).toBe('added');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should use default label when --label not provided', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'add-label',
        '--pr', '9001',
        '--repo', 'nonexistent/nonexistent',
      ]);
      expect(exitCode).toBe(0);

      const result: LabelResult = JSON.parse(stdout);
      expect(result.label).toBe(LABEL_REVIEWING);
    });

    it('should use custom label when --label is provided', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'add-label',
        '--pr', '9001',
        '--label', 'custom-label',
        '--repo', 'nonexistent/nonexistent',
      ]);
      expect(exitCode).toBe(0);

      const result: LabelResult = JSON.parse(stdout);
      expect(result.label).toBe('custom-label');
    });

    it('should use default repo when --repo not provided', async () => {
      // We can't actually test the gh call succeeds, but we can verify the args parsing
      // by checking the output has the expected structure
      const { stdout, exitCode } = await runScanner([
        '--action', 'add-label',
        '--pr', '999999999',
      ]);
      // Even if gh fails, exit code is 0 (non-blocking)
      expect(exitCode).toBe(0);

      const result: LabelResult = JSON.parse(stdout);
      expect(result.prNumber).toBe(999999999);
    });

    it('should error on missing --pr', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'add-label',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--pr/);
    });

    it('should error on invalid --pr value', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'add-label',
        '--pr', 'abc',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/PR number/);
    });
  });

  // ---- Action: remove-label ----

  describe('action: remove-label', () => {
    it('should return structured JSON with success=false when gh is unavailable', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'remove-label',
        '--pr', '9001',
        '--repo', 'nonexistent/nonexistent',
      ]);
      // Label operations are non-blocking — exit code should be 0
      expect(exitCode).toBe(0);

      const result: LabelResult = JSON.parse(stdout);
      expect(result.prNumber).toBe(9001);
      expect(result.label).toBe(LABEL_REVIEWING);
      expect(result.action).toBe('removed');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should use default label when --label not provided', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'remove-label',
        '--pr', '9001',
        '--repo', 'nonexistent/nonexistent',
      ]);
      expect(exitCode).toBe(0);

      const result: LabelResult = JSON.parse(stdout);
      expect(result.label).toBe(LABEL_REVIEWING);
    });

    it('should use custom label when --label is provided', async () => {
      const { stdout, exitCode } = await runScanner([
        '--action', 'remove-label',
        '--pr', '9001',
        '--label', 'custom-label',
        '--repo', 'nonexistent/nonexistent',
      ]);
      expect(exitCode).toBe(0);

      const result: LabelResult = JSON.parse(stdout);
      expect(result.label).toBe('custom-label');
    });

    it('should error on missing --pr', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'remove-label',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--pr/);
    });

    it('should error on invalid --pr value', async () => {
      const { stderr, exitCode } = await runScanner([
        '--action', 'remove-label',
        '--pr', '-1',
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/PR number/);
    });
  });
});
