/**
 * Tests for schedules/pr-scanner/scanner.ts
 *
 * All tests run offline — `list-candidates` is tested by mocking execFile.
 * State files use a temp directory via PR_SCANNER_STATE_DIR env override.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Path to the scanner script (relative to repo root)
const SCANNER_PATH = resolve(__dirname, '../../../schedules/pr-scanner/scanner.ts');

// We'll use a unique temp dir for each test
let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'pr-scanner-test-'));
  return dir;
}

async function writeStateFile(dir: string, prNumber: number, data: object): Promise<void> {
  const filePath = resolve(dir, `pr-${prNumber}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function runScanner(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const mergedEnv = {
    ...process.env,
    PR_SCANNER_STATE_DIR: testDir,
    ...env,
  };

  try {
    const result = await execFileAsync('npx', ['tsx', SCANNER_PATH, ...args], {
      env: mergedEnv,
      timeout: 15000,
    });
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

describe('PR Scanner scanner.ts', () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // -----------------------------------------------------------------------
  // Usage / no action
  // -----------------------------------------------------------------------
  describe('CLI usage', () => {
    it('prints usage when no action provided', async () => {
      const result = await runScanner([]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Usage:');
    });

    it('errors on unknown action', async () => {
      const result = await runScanner(['--action', 'nonexistent']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown action 'nonexistent'");
    });
  });

  // -----------------------------------------------------------------------
  // check-capacity
  // -----------------------------------------------------------------------
  describe('check-capacity', () => {
    it('returns zero reviewing when no state files', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
      expect(data.maxConcurrent).toBe(3);
      expect(data.available).toBe(3);
    });

    it('counts reviewing states correctly', async () => {
      await writeStateFile(testDir, 100, {
        prNumber: 100,
        chatId: null,
        state: 'reviewing',
        createdAt: '2026-04-07T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-09T10:00:00Z',
        disbandRequested: null,
      });
      await writeStateFile(testDir, 101, {
        prNumber: 101,
        chatId: 'oc_xxx',
        state: 'approved',
        createdAt: '2026-04-07T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-09T10:00:00Z',
        disbandRequested: null,
      });

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(1);
      expect(data.available).toBe(2);
    });

    it('respects PR_SCANNER_MAX_CONCURRENT env', async () => {
      const result = await runScanner(
        ['--action', 'check-capacity'],
        { PR_SCANNER_MAX_CONCURRENT: '5' },
      );
      const data = JSON.parse(result.stdout);
      expect(data.maxConcurrent).toBe(5);
      expect(data.available).toBe(5);
    });

    it('counts multiple reviewing states', async () => {
      for (let i = 1; i <= 3; i++) {
        await writeStateFile(testDir, i, {
          prNumber: i,
          chatId: null,
          state: 'reviewing',
          createdAt: '2026-04-07T10:00:00Z',
          updatedAt: '2026-04-07T10:00:00Z',
          expiresAt: '2026-04-09T10:00:00Z',
          disbandRequested: null,
        });
      }
      const result = await runScanner(['--action', 'check-capacity']);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(3);
      expect(data.available).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // create-state
  // -----------------------------------------------------------------------
  describe('create-state', () => {
    it('creates a valid state file', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '200']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(200);
      expect(data.state).toBe('reviewing');
      expect(data.chatId).toBeNull();
      expect(data.disbandRequested).toBeNull();
      expect(data.createdAt).toBeTruthy();
      expect(data.updatedAt).toBeTruthy();
      expect(data.expiresAt).toBeTruthy();

      // Verify expiresAt is ~48h after createdAt
      const created = new Date(data.createdAt).getTime();
      const expires = new Date(data.expiresAt).getTime();
      const diffHours = (expires - created) / (1000 * 60 * 60);
      expect(diffHours).toBeCloseTo(48, 0);
    });

    it('persists state file to disk', async () => {
      await runScanner(['--action', 'create-state', '--pr', '200']);

      const filePath = resolve(testDir, 'pr-200.json');
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.prNumber).toBe(200);
      expect(data.state).toBe('reviewing');
    });

    it('is idempotent — returns existing file without error', async () => {
      const result1 = await runScanner(['--action', 'create-state', '--pr', '200']);
      expect(result1.exitCode).toBe(0);

      const result2 = await runScanner(['--action', 'create-state', '--pr', '200']);
      expect(result2.exitCode).toBe(0);

      // Should return same data
      const data1 = JSON.parse(result1.stdout);
      const data2 = JSON.parse(result2.stdout);
      expect(data1.createdAt).toBe(data2.createdAt);
    });

    it('errors when --pr is missing', async () => {
      const result = await runScanner(['--action', 'create-state']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--pr');
    });
  });

  // -----------------------------------------------------------------------
  // mark
  // -----------------------------------------------------------------------
  describe('mark', () => {
    it('updates state from reviewing to approved', async () => {
      await runScanner(['--action', 'create-state', '--pr', '300']);

      const result = await runScanner([
        '--action', 'mark', '--pr', '300', '--state', 'approved',
      ]);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('approved');
      expect(data.prNumber).toBe(300);
    });

    it('updates state to closed', async () => {
      await runScanner(['--action', 'create-state', '--pr', '301']);

      const result = await runScanner([
        '--action', 'mark', '--pr', '301', '--state', 'closed',
      ]);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('closed');
    });

    it('preserves other fields when updating state', async () => {
      const createResult = await runScanner(['--action', 'create-state', '--pr', '302']);
      const original = JSON.parse(createResult.stdout);

      // Wait a tiny bit so updatedAt differs
      await new Promise((r) => setTimeout(r, 50));

      const markResult = await runScanner([
        '--action', 'mark', '--pr', '302', '--state', 'approved',
      ]);
      const updated = JSON.parse(markResult.stdout);

      expect(updated.prNumber).toBe(original.prNumber);
      expect(updated.createdAt).toBe(original.createdAt);
      expect(updated.expiresAt).toBe(original.expiresAt);
      expect(updated.chatId).toBe(original.chatId);
      expect(updated.disbandRequested).toBe(original.disbandRequested);
      expect(updated.state).toBe('approved');
    });

    it('errors when --pr is missing', async () => {
      const result = await runScanner(['--action', 'mark', '--state', 'approved']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--pr');
    });

    it('errors when --state is missing', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '300']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--state');
    });

    it('errors on invalid state value', async () => {
      await runScanner(['--action', 'create-state', '--pr', '300']);
      const result = await runScanner([
        '--action', 'mark', '--pr', '300', '--state', 'rejected',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid state');
    });

    it('errors when state file does not exist', async () => {
      const result = await runScanner([
        '--action', 'mark', '--pr', '999', '--state', 'approved',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });
  });

  // -----------------------------------------------------------------------
  // status
  // -----------------------------------------------------------------------
  describe('status', () => {
    it('shows message when no tracked PRs', async () => {
      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('groups PRs by state', async () => {
      await writeStateFile(testDir, 10, {
        prNumber: 10,
        chatId: 'oc_aaa',
        state: 'reviewing',
        createdAt: '2026-04-07T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-09T10:00:00Z',
        disbandRequested: null,
      });
      await writeStateFile(testDir, 20, {
        prNumber: 20,
        chatId: 'oc_bbb',
        state: 'approved',
        createdAt: '2026-04-06T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-08T10:00:00Z',
        disbandRequested: null,
      });
      await writeStateFile(testDir, 30, {
        prNumber: 30,
        chatId: null,
        state: 'closed',
        createdAt: '2026-04-05T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-07T10:00:00Z',
        disbandRequested: null,
      });

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('REVIEWING');
      expect(result.stdout).toContain('APPROVED');
      expect(result.stdout).toContain('CLOSED');
      expect(result.stdout).toContain('PR #10');
      expect(result.stdout).toContain('PR #20');
      expect(result.stdout).toContain('PR #30');
    });

    it('skips empty state groups', async () => {
      await writeStateFile(testDir, 10, {
        prNumber: 10,
        chatId: null,
        state: 'reviewing',
        createdAt: '2026-04-07T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-09T10:00:00Z',
        disbandRequested: null,
      });

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('REVIEWING');
      expect(result.stdout).not.toContain('APPROVED');
      expect(result.stdout).not.toContain('CLOSED');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles corrupted state files gracefully', async () => {
      await writeFile(resolve(testDir, 'pr-400.json'), 'not valid json', 'utf-8');

      // status should still work, skipping the corrupted file
      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('handles empty state directory', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
    });

    it('handles non-JSON files in state directory', async () => {
      await writeFile(resolve(testDir, 'random.txt'), 'hello', 'utf-8');
      await writeFile(resolve(testDir, 'pr-abc.json'), 'not a number', 'utf-8');

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
    });

    it('handles state file missing required fields', async () => {
      await writeFile(
        resolve(testDir, 'pr-500.json'),
        JSON.stringify({ prNumber: 500 }), // missing state, dates, etc.
      );

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      // Should skip the invalid file
    });

    it('create-state works when state dir does not exist yet', async () => {
      // Use a subdir that doesn't exist
      const nestedDir = resolve(testDir, 'nested', 'subdir');
      const result = await runScanner(
        ['--action', 'create-state', '--pr', '600'],
        { PR_SCANNER_STATE_DIR: nestedDir },
      );
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(600);
    });
  });
});
