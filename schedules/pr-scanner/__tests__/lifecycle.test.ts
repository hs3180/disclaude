/**
 * Unit tests for schedules/pr-scanner/lifecycle.ts
 *
 * Tests all lifecycle actions: check-expired, mark-disband, cleanup, disband.
 * Uses CLI invocation via execFile for full integration testing.
 * No GitHub API or lark-cli dependency — mocked where needed.
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
  TEMP_CHATS_DIR,
  type PrStateFile,
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

const TEST_PRS = [9101, 9102, 9103, 9104, 9105];

async function cleanupTestFiles() {
  for (const pr of TEST_PRS) {
    try {
      await rm(prFilePath(pr), { force: true });
    } catch {
      // Ignore
    }
  }
}

async function writeState(prNumber: number, state: PrStateFile): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true });
  const filePath = prFilePath(prNumber);
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

async function runLifecycle(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', resolve(__dirname, '..', 'lifecycle.ts'), ...args],
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

describe('lifecycle.ts', () => {
  beforeEach(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  // ---- Action: check-expired ----

  describe('action: check-expired', () => {
    it('should return empty when no state files exist', async () => {
      // Clean the directory
      try {
        await rm(TEMP_DIR, { recursive: true, force: true });
      } catch {
        // Ignore
      }

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.expired).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.skippedCooldown).toBe(0);
    });

    it('should detect expired PR in reviewing state', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // 100h ago
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past, // expired
        state: 'reviewing',
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.total).toBe(1);
      expect(result.expired.length).toBe(1);
      expect(result.expired[0].prNumber).toBe(9101);
      expect(result.expired[0].needsDisbandRequest).toBe(true);
    });

    it('should skip non-reviewing states', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'approved',
      }));
      await writeState(9102, makeState({
        prNumber: 9102,
        expiresAt: past,
        state: 'closed',
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.total).toBe(2);
      expect(result.expired).toEqual([]);
    });

    it('should skip non-expired PRs', async () => {
      const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h from now
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: future,
        state: 'reviewing',
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.total).toBe(1);
      expect(result.expired).toEqual([]);
    });

    it('should respect cooldown period for disbandRequested', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      const recentDisband = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
        disbandRequested: recentDisband,
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired', '--cooldown-hours', '24']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.total).toBe(1);
      expect(result.expired.length).toBe(1);
      expect(result.expired[0].prNumber).toBe(9101);
      expect(result.expired[0].needsDisbandRequest).toBe(false); // within cooldown
      expect(result.skippedCooldown).toBe(1);
    });

    it('should mark needsDisbandRequest=true when cooldown has passed', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      const oldDisband = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
        disbandRequested: oldDisband,
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired', '--cooldown-hours', '24']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.expired.length).toBe(1);
      expect(result.expired[0].needsDisbandRequest).toBe(true); // cooldown passed
      expect(result.skippedCooldown).toBe(0);
    });

    it('should handle multiple PRs with mixed states', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      await writeState(9101, makeState({ prNumber: 9101, expiresAt: past, state: 'reviewing' }));
      await writeState(9102, makeState({ prNumber: 9102, expiresAt: past, state: 'approved' }));
      await writeState(9103, makeState({ prNumber: 9103, expiresAt: future, state: 'reviewing' }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.total).toBe(3);
      expect(result.expired.length).toBe(1);
      expect(result.expired[0].prNumber).toBe(9101);
    });

    it('should error on invalid --cooldown-hours', async () => {
      const { stderr, exitCode } = await runLifecycle(['--action', 'check-expired', '--cooldown-hours', '-1']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/cooldown-hours/);
    });

    it('should skip corrupted files', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({ prNumber: 9101, expiresAt: past, state: 'reviewing' }));
      await writeFile(prFilePath(9102), 'corrupted json', 'utf-8');

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.expired.length).toBe(1);
      expect(result.expired[0].prNumber).toBe(9101);
    });

    it('should include chatId in results', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
        chatId: 'oc_test123',
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'check-expired']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.expired[0].chatId).toBe('oc_test123');
    });
  });

  // ---- Action: mark-disband ----

  describe('action: mark-disband', () => {
    it('should set disbandRequested timestamp', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
        disbandRequested: null,
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'mark-disband', '--pr', '9101']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.prNumber).toBe(9101);
      expect(result.disbandRequested).toBeTruthy();
      expect(new Date(result.disbandRequested).getTime()).toBeLessThanOrEqual(Date.now());
      expect(result.updatedAt).toBeTruthy();
    });

    it('should persist disbandRequested to file', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
      }));

      await runLifecycle(['--action', 'mark-disband', '--pr', '9101']);

      const state = await readPrState(prFilePath(9101));
      expect(state.disbandRequested).toBeTruthy();
      expect(state.disbandRequested).not.toBeNull();
    });

    it('should overwrite existing disbandRequested', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      const oldDisband = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
        disbandRequested: oldDisband,
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'mark-disband', '--pr', '9101']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      // New timestamp should be more recent
      expect(new Date(result.disbandRequested).getTime()).toBeGreaterThan(new Date(oldDisband).getTime());
    });

    it('should reject non-reviewing state', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'approved',
      }));

      const { stderr, exitCode } = await runLifecycle(['--action', 'mark-disband', '--pr', '9101']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/reviewing/);
    });

    it('should error on missing --pr', async () => {
      const { stderr, exitCode } = await runLifecycle(['--action', 'mark-disband']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--pr/);
    });

    it('should error when state file does not exist', async () => {
      const { stderr, exitCode } = await runLifecycle(['--action', 'mark-disband', '--pr', '9999']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/No state file/);
    });
  });

  // ---- Action: cleanup ----

  describe('action: cleanup', () => {
    it('should delete state file', async () => {
      await writeState(9101, makeState({ prNumber: 9101 }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'cleanup', '--pr', '9101']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.prNumber).toBe(9101);
      expect(result.deleted).toBe(true);

      // Verify file is gone
      await expect(stat(prFilePath(9101))).rejects.toThrow();
    });

    it('should handle missing file gracefully', async () => {
      const { stdout, exitCode } = await runLifecycle(['--action', 'cleanup', '--pr', '9999']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.deleted).toBe(false);
      expect(result.error).toMatch(/not found/);
    });

    it('should error on missing --pr', async () => {
      const { stderr, exitCode } = await runLifecycle(['--action', 'cleanup']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--pr/);
    });
  });

  // ---- Action: disband ----

  describe('action: disband', () => {
    it('should reject when state is not reviewing', async () => {
      await writeState(9101, makeState({
        prNumber: 9101,
        state: 'approved',
      }));

      const { stderr, exitCode } = await runLifecycle(['--action', 'disband', '--pr', '9101']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/reviewing/);

      // File should still exist
      const fileStat = await stat(prFilePath(9101));
      expect(fileStat.isFile()).toBe(true);
    });

    it('should error when state file does not exist', async () => {
      const { stderr, exitCode } = await runLifecycle(['--action', 'disband', '--pr', '9999']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/No state file/);
    });

    it('should delete state file and report results (without lark-cli)', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
        chatId: null, // no chat group
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'disband', '--pr', '9101']);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.prNumber).toBe(9101);
      expect(result.chatId).toBeNull();
      expect(result.groupDissolved).toBe(false); // no chatId
      expect(result.stateFileDeleted).toBe(true);

      // Verify file is gone
      await expect(stat(prFilePath(9101))).rejects.toThrow();
    });

    it('should attempt group dissolution when chatId is present', async () => {
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
        chatId: 'oc_test_group_123',
      }));

      const { stdout, exitCode } = await runLifecycle(['--action', 'disband', '--pr', '9101']);
      // lark-cli won't be available in test, so groupDissolved will be false
      // but the command should still succeed (non-blocking)
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.prNumber).toBe(9101);
      expect(result.chatId).toBe('oc_test_group_123');
      expect(result.groupDissolved).toBe(false); // lark-cli not available
      expect(result.stateFileDeleted).toBe(true);
    });
  });

  // ---- CLI general ----

  describe('CLI general', () => {
    it('should error when --action is missing', async () => {
      const { stderr, exitCode } = await runLifecycle([]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--action is required/);
    });

    it('should error on unknown action', async () => {
      const { stderr, exitCode } = await runLifecycle(['--action', 'unknown']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Unknown action/);
    });

    it('should error on invalid --pr value', async () => {
      const { stderr, exitCode } = await runLifecycle(['--action', 'cleanup', '--pr', 'abc']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/PR number/);
    });
  });

  // ---- Integration: full lifecycle flow ----

  describe('full lifecycle flow', () => {
    it('should support the complete check → mark → cleanup flow', async () => {
      // 1. Create an expired reviewing PR
      const past = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      await writeState(9101, makeState({
        prNumber: 9101,
        expiresAt: past,
        state: 'reviewing',
      }));

      // 2. Check expired — should find it
      const checkResult = await runLifecycle(['--action', 'check-expired']);
      expect(checkResult.exitCode).toBe(0);
      const check = JSON.parse(checkResult.stdout);
      expect(check.expired.length).toBe(1);
      expect(check.expired[0].needsDisbandRequest).toBe(true);

      // 3. Mark disband
      const markResult = await runLifecycle(['--action', 'mark-disband', '--pr', '9101']);
      expect(markResult.exitCode).toBe(0);
      const mark = JSON.parse(markResult.stdout);
      expect(mark.disbandRequested).toBeTruthy();

      // 4. Check expired again — should be in cooldown
      const checkAgain = await runLifecycle(['--action', 'check-expired', '--cooldown-hours', '24']);
      expect(checkAgain.exitCode).toBe(0);
      const check2 = JSON.parse(checkAgain.stdout);
      expect(check2.expired.length).toBe(1);
      expect(check2.expired[0].needsDisbandRequest).toBe(false);
      expect(check2.skippedCooldown).toBe(1);

      // 5. Cleanup
      const cleanupResult = await runLifecycle(['--action', 'cleanup', '--pr', '9101']);
      expect(cleanupResult.exitCode).toBe(0);
      const cleanup = JSON.parse(cleanupResult.stdout);
      expect(cleanup.deleted).toBe(true);

      // 6. Verify no expired PRs found
      const finalCheck = await runLifecycle(['--action', 'check-expired']);
      expect(finalCheck.exitCode).toBe(0);
      const finalResult = JSON.parse(finalCheck.stdout);
      expect(finalResult.expired).toEqual([]);
    }, 60_000); // Extended timeout: 6 sequential CLI invocations
  });
});
