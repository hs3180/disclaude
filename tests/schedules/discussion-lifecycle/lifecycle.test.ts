/**
 * Tests for schedules/discussion-lifecycle/lifecycle.ts
 *
 * All tests run offline — `gh` and `lark-cli` calls are mocked/expected to fail gracefully.
 * State files use a temp directory via PR_SCANNER_STATE_DIR env override.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Path to the lifecycle script (relative to repo root)
const LIFECYCLE_PATH = resolve(__dirname, '../../../schedules/discussion-lifecycle/lifecycle.ts');

// We'll use a unique temp dir for each test
let testDir: string;

async function createTestDir(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'lifecycle-test-'));
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

async function stateFileExists(dir: string, prNumber: number): Promise<boolean> {
  try {
    await readFile(resolve(dir, `pr-${prNumber}.json`), 'utf-8');
    return true;
  } catch {
    return false;
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

async function runLifecycle(
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
    const result = await execFileAsync('npx', ['tsx', LIFECYCLE_PATH, ...args], {
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

describe('Discussion Lifecycle lifecycle.ts', () => {
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
  // CLI usage
  // -----------------------------------------------------------------------
  describe('CLI usage', () => {
    it('prints usage when no action provided', async () => {
      const result = await runLifecycle([]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Usage:');
    });

    it('exits with error for unknown action', async () => {
      const result = await runLifecycle(['--action', 'unknown']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown action 'unknown'");
    });
  });

  // -----------------------------------------------------------------------
  // check-expired
  // -----------------------------------------------------------------------
  describe('check-expired', () => {
    it('returns empty list when no expired PRs', async () => {
      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('detects expired reviewing PRs', async () => {
      // Create an expired PR (expiresAt in the past)
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(testDir, 100, {
        prNumber: 100,
        chatId: 'oc_test',
        state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry,
        disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].prNumber).toBe(100);
      expect(data[0].state).toBe('reviewing');
      expect(data[0].disbandEligible).toBe(true);
    });

    it('excludes non-expired PRs', async () => {
      // Create a non-expired PR (expiresAt in the future)
      const futureExpiry = new Date(Date.now() + 48 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(testDir, 100, {
        prNumber: 100,
        chatId: 'oc_test',
        state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: futureExpiry,
        disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('excludes expired PRs that are not in reviewing state', async () => {
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(testDir, 100, {
        prNumber: 100,
        chatId: 'oc_test',
        state: 'approved',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry,
        disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('marks disbandEligible=false when requested within 24h', async () => {
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const recentRequest = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'); // 1h ago
      await writeStateFile(testDir, 100, {
        prNumber: 100,
        chatId: 'oc_test',
        state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry,
        disbandRequested: recentRequest,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].prNumber).toBe(100);
      expect(data[0].disbandEligible).toBe(false);
    });

    it('marks disbandEligible=true when requested > 24h ago', async () => {
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const oldRequest = new Date(Date.now() - 25 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'); // 25h ago
      await writeStateFile(testDir, 100, {
        prNumber: 100,
        chatId: 'oc_test',
        state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry,
        disbandRequested: oldRequest,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].disbandEligible).toBe(true);
    });

    it('handles multiple expired PRs', async () => {
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(testDir, 100, {
        prNumber: 100, chatId: 'oc_a', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry, disbandRequested: null,
      });
      await writeStateFile(testDir, 101, {
        prNumber: 101, chatId: 'oc_b', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry, disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // mark-disband
  // -----------------------------------------------------------------------
  describe('mark-disband', () => {
    it('updates disbandRequested timestamp', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: 'oc_test', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '42']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.disbandRequested).not.toBeNull();
      expect(data.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    });

    it('persists disbandRequested to disk', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: 'oc_test', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      await runLifecycle(['--action', 'mark-disband', '--pr', '42']);

      const fileData = await readStateFile(testDir, 42);
      expect(fileData).toBeTruthy();
      expect((fileData as { disbandRequested: string | null }).disbandRequested).not.toBeNull();
    });

    it('requires --pr argument', async () => {
      const result = await runLifecycle(['--action', 'mark-disband']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--pr');
    });

    it('fails for nonexistent state file', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '999']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });
  });

  // -----------------------------------------------------------------------
  // disband
  // -----------------------------------------------------------------------
  describe('disband', () => {
    it('deletes state file and outputs result for reviewing PR', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'disband', '--pr', '42']);
      expect(result.exitCode).toBe(0);

      // State file should be deleted
      const exists = await stateFileExists(testDir, 42);
      expect(exists).toBe(false);

      // Output should contain disband result
      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(42);
      expect(data.disbanded).toBe(true);
      expect(data.chatId).toBeNull();
    });

    it('attempts label removal (non-blocking)', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'disband', '--pr', '42']);
      expect(result.exitCode).toBe(0);
      // Label removal attempt should be logged (will fail in test env)
      expect(result.stderr).toContain('[label:warn]');
    });

    it('rejects disband for non-reviewing state', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: 'oc_test', state: 'approved',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'disband', '--pr', '42']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("state is 'approved'");
      expect(result.stderr).toContain("expected 'reviewing'");
    });

    it('requires --pr argument', async () => {
      const result = await runLifecycle(['--action', 'disband']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--pr');
    });

    it('fails for nonexistent state file', async () => {
      const result = await runLifecycle(['--action', 'disband', '--pr', '999']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });

    it('deletes state file even when chatId exists (lark-cli will fail gracefully)', async () => {
      await writeStateFile(testDir, 42, {
        prNumber: 42, chatId: 'oc_real_chat_id', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z', disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'disband', '--pr', '42']);
      expect(result.exitCode).toBe(0);

      // lark-cli will fail in test env but disband should still complete
      expect(result.stderr).toContain('[lark:warn]');
      expect(result.stderr).toContain('[cleanup]');

      // State file should still be deleted
      const exists = await stateFileExists(testDir, 42);
      expect(exists).toBe(false);

      const data = JSON.parse(result.stdout);
      expect(data.disbanded).toBe(false); // lark-cli failed
      expect(data.chatId).toBe('oc_real_chat_id');
    });
  });

  // -----------------------------------------------------------------------
  // status
  // -----------------------------------------------------------------------
  describe('status', () => {
    it('shows no tracked PRs message when empty', async () => {
      const result = await runLifecycle(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('shows PR info with expiry status', async () => {
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const futureExpiry = new Date(Date.now() + 48 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');

      await writeStateFile(testDir, 1, {
        prNumber: 1, chatId: 'oc_123', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry, disbandRequested: null,
      });
      await writeStateFile(testDir, 2, {
        prNumber: 2, chatId: null, state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: futureExpiry, disbandRequested: '2026-01-02T00:00:00Z',
      });

      const result = await runLifecycle(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PR #1');
      expect(result.stdout).toContain('EXPIRED');
      expect(result.stdout).toContain('PR #2');
      expect(result.stdout).toContain('active');
      expect(result.stdout).toContain('disbandRequested=');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles corrupted state files gracefully in check-expired', async () => {
      await writeFile(resolve(testDir, 'pr-99.json'), 'not-json{{{', 'utf-8');
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(testDir, 100, {
        prNumber: 100, chatId: 'oc_test', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry, disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      // Only the valid file should be counted
      expect(data).toHaveLength(1);
      expect(data[0].prNumber).toBe(100);
    });

    it('handles non-JSON files in state directory', async () => {
      await writeFile(resolve(testDir, 'other.txt'), 'hello', 'utf-8');
      const pastExpiry = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeStateFile(testDir, 100, {
        prNumber: 100, chatId: 'oc_test', state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: pastExpiry, disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
    });

    it('handles empty state directory', async () => {
      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('handles non-existent state directory', async () => {
      const result = await runLifecycle(['--action', 'check-expired'], {
        PR_SCANNER_STATE_DIR: '/tmp/nonexistent-lifecycle-test-' + Date.now(),
      });
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });
  });
});
