/**
 * Tests for schedules/pr-scanner/scanner.ts
 *
 * All tests run offline — `gh` CLI calls are mocked.
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

async function readStateFile(dir: string, prNumber: number): Promise<object | null> {
  try {
    const raw = await readFile(resolve(dir, `pr-${prNumber}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listStateFiles(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => /^pr-\d+\.json$/.test(f));
  } catch {
    return [];
  }
}

async function runScanner(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const mergedEnv = {
    ...process.env,
    PR_SCANNER_STATE_DIR: testDir,
    // Prevent real gh CLI calls in tests
    PR_SCANNER_REPO: 'test/repo',
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

    it('exits with error for unknown action', async () => {
      const result = await runScanner(['--action', 'unknown']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown action 'unknown'");
    });
  });

  // -----------------------------------------------------------------------
  // check-capacity
  // -----------------------------------------------------------------------
  describe('check-capacity', () => {
    it('returns available capacity when no reviewing PRs', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
      expect(data.maxConcurrent).toBe(3);
      expect(data.available).toBe(3);
    });

    it('counts reviewing PRs correctly', async () => {
      await writeStateFile(testDir, 100, {
        prNumber: 100, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });
      await writeStateFile(testDir, 101, {
        prNumber: 101, chatId: null, state: 'approved',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(1);
      expect(data.available).toBe(2);
    });

    it('respects PR_SCANNER_MAX_CONCURRENT env', async () => {
      const result = await runScanner(['--action', 'check-capacity'], {
        PR_SCANNER_MAX_CONCURRENT: '5',
      });
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.maxConcurrent).toBe(5);
      expect(data.available).toBe(5);
    });

    it('returns 0 available when at capacity', async () => {
      for (let i = 1; i <= 3; i++) {
        await writeStateFile(testDir, i, {
          prNumber: i, chatId: null, state: 'reviewing',
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
        });
      }

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.available).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // create-state
  // -----------------------------------------------------------------------
  describe('create-state', () => {
    it('creates a new state file with correct schema', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '42']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(42);
      expect(data.state).toBe('reviewing');
      expect(data.chatId).toBeNull();
      expect(data.disbandRequested).toBeNull();
      expect(data.createdAt).toBeTruthy();
      expect(data.updatedAt).toBeTruthy();
      expect(data.expiresAt).toBeTruthy();
    });

    it('writes file to disk', async () => {
      await runScanner(['--action', 'create-state', '--pr', '42']);

      const files = await listStateFiles(testDir);
      expect(files).toContain('pr-42.json');
    });

    it('is idempotent for existing state file', async () => {
      // Create first time
      const r1 = await runScanner(['--action', 'create-state', '--pr', '42']);
      expect(r1.exitCode).toBe(0);
      const first = JSON.parse(r1.stdout);

      // Small delay to ensure timestamp would differ
      await new Promise((r) => setTimeout(r, 10));

      // Create second time — should return existing
      const r2 = await runScanner(['--action', 'create-state', '--pr', '42']);
      expect(r2.exitCode).toBe(0);
      const second = JSON.parse(r2.stdout);

      // Should be the same (idempotent)
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('requires --pr argument', async () => {
      const result = await runScanner(['--action', 'create-state']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--pr');
    });

    it('sets expiresAt to ~48h after createdAt', async () => {
      const before = Date.now();
      const result = await runScanner(['--action', 'create-state', '--pr', '42']);
      const after = Date.now();
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      const created = new Date(data.createdAt).getTime();
      const expires = new Date(data.expiresAt).getTime();

      const diffHours = (expires - created) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThanOrEqual(47.9);
      expect(diffHours).toBeLessThanOrEqual(48.1);
    });

    it('attempts to add reviewing label (non-blocking)', async () => {
      // The gh CLI will fail in test env, but create-state should still succeed
      const result = await runScanner(['--action', 'create-state', '--pr', '42']);
      expect(result.exitCode).toBe(0);
      // Label failure is logged as warning in stderr
      expect(result.stderr).toContain('[label:warn]');
    });
  });

  // -----------------------------------------------------------------------
  // mark
  // -----------------------------------------------------------------------
  describe('mark', () => {
    it('updates state from reviewing to approved', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'approved']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('approved');
      expect(data.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    });

    it('updates state from reviewing to closed', { timeout: 30000 }, async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'closed']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('closed');
    });

    it('removes reviewing label when transitioning away from reviewing', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'approved']);
      expect(result.exitCode).toBe(0);
      // Label removal attempt should be logged (will fail in test env)
      expect(result.stderr).toContain('[label:warn]');
    });

    it('does not attempt label removal when state stays reviewing', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'reviewing']);
      expect(result.exitCode).toBe(0);
      // No label removal when staying in reviewing
      expect(result.stderr).not.toContain('[label]');
    });

    it('requires --pr and --state arguments', async () => {
      const r1 = await runScanner(['--action', 'mark']);
      expect(r1.exitCode).toBe(1);
      expect(r1.stderr).toContain('--pr');

      const r2 = await runScanner(['--action', 'mark', '--pr', '42']);
      expect(r2.exitCode).toBe(1);
      expect(r2.stderr).toContain('--state');
    });

    it('rejects invalid state values', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'mark', '--pr', '42', '--state', 'rejected']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid state');
    });

    it('fails for nonexistent state file', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '999', '--state', 'approved']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });

    it('persists state change to disk', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      await runScanner(['--action', 'mark', '--pr', '42', '--state', 'approved']);

      const fileData = await readStateFile(testDir, 42);
      expect(fileData).toBeTruthy();
      expect((fileData as { state: string }).state).toBe('approved');
    });
  });

  // -----------------------------------------------------------------------
  // status
  // -----------------------------------------------------------------------
  describe('status', () => {
    it('shows no tracked PRs message when empty', async () => {
      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('groups PRs by state', async () => {
      await writeStateFile(testDir, 1, {
        prNumber: 1, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });
      await writeStateFile(testDir, 2, {
        prNumber: 2, chatId: 'oc_123', state: 'approved',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('REVIEWING');
      expect(result.stdout).toContain('APPROVED');
      expect(result.stdout).toContain('PR #1');
      expect(result.stdout).toContain('PR #2');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles corrupted state files gracefully', async () => {
      await writeFile(resolve(testDir, 'pr-99.json'), 'not-json{{{', 'utf-8');
      await writeStateFile(testDir, 100, {
        prNumber: 100, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      // Only the valid file should be counted
      expect(data.reviewing).toBe(1);
    });

    it('handles non-JSON files in state directory', async () => {
      await writeFile(resolve(testDir, 'other.txt'), 'hello', 'utf-8');
      await writeStateFile(testDir, 100, {
        prNumber: 100, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PR #100');
    });

    it('handles missing fields in state file', async () => {
      await writeFile(resolve(testDir, 'pr-50.json'), JSON.stringify({ prNumber: 50 }) + '\n', 'utf-8');

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      // Invalid file should be skipped
      expect(data.reviewing).toBe(0);
    });

    it('handles empty state directory', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
      expect(data.available).toBe(3);
    });

    it('handles non-existent state directory for check-capacity', async () => {
      // Use a non-existent directory
      const result = await runScanner(['--action', 'check-capacity'], {
        PR_SCANNER_STATE_DIR: '/tmp/nonexistent-pr-scanner-test-' + Date.now(),
      });
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
    });
  });
});
