/**
 * Unit tests for pr-scanner/scanner.ts CLI tool.
 *
 * Tests all five actions: check-capacity, list-candidates, create-state, mark, status.
 * Uses a temporary directory for state files to avoid interfering with production state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'skills/pr-scanner/scanner.ts');
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-test-scanner');

async function runScanner(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT_PATH, ...args], {
      env: { ...process.env, PR_SCANNER_STATE_DIR: TEST_STATE_DIR, ...env },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
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

async function cleanupTestDir() {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

describe('scanner.ts', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ---- check-capacity ----

  describe('check-capacity', () => {
    it('should report full capacity when no state files exist', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
      expect(data.maxConcurrent).toBe(3);
      expect(data.available).toBe(3);
    });

    it('should count reviewing PRs correctly', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-100.json'),
        JSON.stringify({
          prNumber: 100,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-200.json'),
        JSON.stringify({
          prNumber: 200,
          chatId: null,
          state: 'approved',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(1);
      expect(data.available).toBe(2);
    });

    it('should respect PR_SCANNER_MAX_CONCURRENT env', async () => {
      const result = await runScanner(['--action', 'check-capacity'], {
        PR_SCANNER_MAX_CONCURRENT: '5',
      });
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.maxConcurrent).toBe(5);
      expect(data.available).toBe(5);
    });

    it('should report zero available when at capacity', async () => {
      for (let i = 1; i <= 3; i++) {
        await writeFile(
          resolve(TEST_STATE_DIR, `pr-${i}.json`),
          JSON.stringify({
            prNumber: i,
            chatId: null,
            state: 'reviewing',
            createdAt: '2026-04-15T10:00:00Z',
            updatedAt: '2026-04-15T10:00:00Z',
            expiresAt: '2026-04-17T10:00:00Z',
            disbandRequested: null,
          }),
        );
      }

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(3);
      expect(data.available).toBe(0);
    });
  });

  // ---- list-candidates ----

  describe('list-candidates', () => {
    it('should return empty array when no state files', async () => {
      const result = await runScanner(['--action', 'list-candidates']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('should list all state files sorted by PR number', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-300.json'),
        JSON.stringify({
          prNumber: 300,
          chatId: null,
          state: 'closed',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-100.json'),
        JSON.stringify({
          prNumber: 100,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'list-candidates']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(2);
      expect(data[0].prNumber).toBe(100);
      expect(data[1].prNumber).toBe(300);
    });

    it('should filter by state when --state is provided', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-100.json'),
        JSON.stringify({
          prNumber: 100,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-200.json'),
        JSON.stringify({
          prNumber: 200,
          chatId: null,
          state: 'approved',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'list-candidates', '--state', 'approved']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].prNumber).toBe(200);
      expect(data[0].state).toBe('approved');
    });

    it('should skip non-PR JSON files', async () => {
      await writeFile(resolve(TEST_STATE_DIR, 'other.json'), '{}');
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-100.json'),
        JSON.stringify({
          prNumber: 100,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'list-candidates']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
    });

    it('should skip corrupted files with warning', async () => {
      await writeFile(resolve(TEST_STATE_DIR, 'pr-100.json'), 'not valid json {{{');
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-200.json'),
        JSON.stringify({
          prNumber: 200,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'list-candidates']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('corrupted');
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].prNumber).toBe(200);
    });
  });

  // ---- create-state ----

  describe('create-state', () => {
    it('should create a new state file with reviewing state', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '42']);
      expect(result.code).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(42);
      expect(data.state).toBe('reviewing');
      expect(data.chatId).toBe(null);
      expect(data.disbandRequested).toBe(null);
      expect(data.createdAt).toBeTruthy();
      expect(data.updatedAt).toBeTruthy();
      expect(data.expiresAt).toBeTruthy();

      // Verify file was written
      const filePath = resolve(TEST_STATE_DIR, 'pr-42.json');
      const fileContent = await readFile(filePath, 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.prNumber).toBe(42);
    });

    it('should set expiresAt to 48 hours from now by default', async () => {
      const before = Date.now();
      const result = await runScanner(['--action', 'create-state', '--pr', '1']);
      const after = Date.now();
      expect(result.code).toBe(0);

      const data = JSON.parse(result.stdout);
      const expiresAt = new Date(data.expiresAt).getTime();
      const expectedMin = before + 48 * 3600 * 1000;
      const expectedMax = after + 48 * 3600 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('should respect PR_SCANNER_EXPIRY_HOURS env', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '1'], {
        PR_SCANNER_EXPIRY_HOURS: '24',
      });
      expect(result.code).toBe(0);

      const data = JSON.parse(result.stdout);
      const createdAt = new Date(data.createdAt).getTime();
      const expiresAt = new Date(data.expiresAt).getTime();
      const diffHours = (expiresAt - createdAt) / (3600 * 1000);
      expect(diffHours).toBeCloseTo(24, 0);
    });

    it('should fail if state file already exists', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'create-state', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should fail without --pr flag', async () => {
      const result = await runScanner(['--action', 'create-state']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should fail with invalid PR number', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });
  });

  // ---- mark ----

  describe('mark', () => {
    it('should transition reviewing → approved', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'approved']);
      expect(result.code).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('approved');
      expect(data.prNumber).toBe(42);
      expect(data.updatedAt).not.toBe('2026-04-15T10:00:00Z'); // Should be updated
    });

    it('should transition reviewing → closed', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'closed']);
      expect(result.code).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('closed');
    });

    it('should transition approved → closed', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'approved',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'closed']);
      expect(result.code).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('closed');
    });

    it('should be idempotent when marking same state', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'reviewing']);
      expect(result.code).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('reviewing');
      // updatedAt should NOT change for idempotent operation
      expect(data.updatedAt).toBe('2026-04-15T10:00:00Z');
    });

    it('should reject invalid transition approved → reviewing', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'approved',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'reviewing']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid state transition');
    });

    it('should reject invalid transition closed → reviewing', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'closed',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'reviewing']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid state transition');
    });

    it('should fail if state file does not exist', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '999', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should fail without --pr or --state flags', async () => {
      const resultNoPr = await runScanner(['--action', 'mark', '--state', 'approved']);
      expect(resultNoPr.code).toBe(1);

      const resultNoState = await runScanner(['--action', 'mark', '--pr', '42']);
      expect(resultNoState.code).toBe(1);
    });

    it('should preserve file atomically (temp + rename)', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      await runScanner(['--action', 'mark', '--pr', '42', '--state', 'approved']);

      // No temp files should remain
      const files = await readdir(TEST_STATE_DIR);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  // ---- status ----

  describe('status', () => {
    it('should handle missing state directory', async () => {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });
      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('should show empty status when no files', async () => {
      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('should group PRs by state', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-100.json'),
        JSON.stringify({
          prNumber: 100,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2099-12-31T23:59:59Z',
          disbandRequested: null,
        }),
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-200.json'),
        JSON.stringify({
          prNumber: 200,
          chatId: null,
          state: 'approved',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2099-12-31T23:59:59Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('🔍 reviewing (1)');
      expect(result.stdout).toContain('✅ approved (1)');
      expect(result.stdout).toContain('Total: 2 tracked PR(s)');
    });

    it('should mark expired PRs', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-100.json'),
        JSON.stringify({
          prNumber: 100,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2020-01-01T00:00:00Z', // Expired
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('EXPIRED');
    });
  });

  // ---- CLI argument validation ----

  describe('CLI args', () => {
    it('should fail without --action flag', async () => {
      const result = await runScanner([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required --action');
    });

    it('should fail with unknown action', async () => {
      const result = await runScanner(['--action', 'unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown action');
    });

    it('should show help with --help flag', async () => {
      const result = await runScanner(['--help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('check-capacity');
    });

    it('should reject invalid --state value', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-42.json'),
        JSON.stringify({
          prNumber: 42,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-15T10:00:00Z',
          updatedAt: '2026-04-15T10:00:00Z',
          expiresAt: '2026-04-17T10:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'invalid']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid state');
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('should handle empty state directory', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);

      const result2 = await runScanner(['--action', 'list-candidates']);
      expect(result2.code).toBe(0);

      const result3 = await runScanner(['--action', 'status']);
      expect(result3.code).toBe(0);
    });

    it('should handle concurrent create for different PRs', async () => {
      const [result1, result2] = await Promise.all([
        runScanner(['--action', 'create-state', '--pr', '100']),
        runScanner(['--action', 'create-state', '--pr', '200']),
      ]);

      expect(result1.code).toBe(0);
      expect(result2.code).toBe(0);

      // Both files should exist
      const files = await readdir(TEST_STATE_DIR);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      expect(jsonFiles).toHaveLength(2);
    });

    it('should handle corrupted state file on mark', async () => {
      await writeFile(resolve(TEST_STATE_DIR, 'pr-42.json'), 'not valid json');

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Corrupted');
    });
  });
});
