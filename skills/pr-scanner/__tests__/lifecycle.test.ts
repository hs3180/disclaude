/**
 * Unit tests for PR Scanner v2 lifecycle.ts and updated schema.ts (Phase 2).
 *
 * Tests lifecycle CLI actions (check-expired, mark-disband, cleanup) and
 * the updated disbandRequested field validation.
 * Runs without GitHub API access (fully offline).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  parseStateFile,
  validateStateFileData,
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
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-test-lifecycle');

// Helper to run the lifecycle script
async function runLifecycle(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/pr-scanner/lifecycle.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath, ...args], {
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

/** Directory for fake gh script (used in cleanup tests) */
const FAKE_GH_DIR = resolve(PROJECT_ROOT, '.temp-fake-gh-lifecycle');

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
// Schema Phase 2: disbandRequested validation
// ============================================================================

describe('schema Phase 2: disbandRequested', () => {
  describe('parseStateFile with disbandRequested', () => {
    it('should accept null disbandRequested', () => {
      const json = createStateJson({ disbandRequested: null });
      const parsed = parseStateFile(json, 'test.json');
      expect(parsed.disbandRequested).toBeNull();
    });

    it('should accept valid ISO timestamp disbandRequested', () => {
      const json = createStateJson({ disbandRequested: '2026-04-15T12:00:00Z' });
      const parsed = parseStateFile(json, 'test.json');
      expect(parsed.disbandRequested).toBe('2026-04-15T12:00:00Z');
    });

    it('should accept ISO timestamp with milliseconds', () => {
      const json = createStateJson({ disbandRequested: '2026-04-15T12:00:00.123Z' });
      const parsed = parseStateFile(json, 'test.json');
      expect(parsed.disbandRequested).toBe('2026-04-15T12:00:00.123Z');
    });

    it('should reject invalid disbandRequested string', () => {
      const json = createStateJson({ disbandRequested: 'not-a-date' });
      expect(() => parseStateFile(json, 'test.json')).toThrow(ValidationError);
    });

    it('should reject numeric disbandRequested', () => {
      const json = JSON.stringify({
        prNumber: 123,
        chatId: 'oc_x',
        state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-03T00:00:00Z',
        disbandRequested: 12345,
      });
      expect(() => parseStateFile(json, 'test.json')).toThrow(ValidationError);
    });
  });
});

// ============================================================================
// Lifecycle CLI tests
// ============================================================================

describe('lifecycle CLI', () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  // ---- check-expired ----

  describe('check-expired', () => {
    it('should return empty array when no state files exist', async () => {
      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('should return empty array when no reviewing PRs are expired', async () => {
      // Create a PR that expires far in the future
      const futureExpires = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({ prNumber: 9001, state: 'reviewing', expiresAt: futureExpires }),
      );

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('should detect expired reviewing PRs', async () => {
      // Create a PR that expired in the past
      const pastExpires = '2020-01-01T00:00:00Z';
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          chatId: 'oc_expired_chat',
          state: 'reviewing',
          expiresAt: pastExpires,
          createdAt: '2019-12-30T00:00:00Z',
        }),
      );

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].prNumber).toBe(9001);
      expect(data[0].chatId).toBe('oc_expired_chat');
      expect(data[0].needsDisbandRequest).toBe(true);
    });

    it('should skip expired non-reviewing PRs', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          state: 'approved',
          expiresAt: '2020-01-01T00:00:00Z',
        }),
      );

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });

    it('should detect multiple expired reviewing PRs', async () => {
      for (const pr of [9001, 9002, 9003]) {
        await writeFile(
          stateFilePath(TEST_STATE_DIR, pr),
          createStateJson({
            prNumber: pr,
            chatId: `oc_chat_${pr}`,
            state: 'reviewing',
            expiresAt: '2020-01-01T00:00:00Z',
          }),
        );
      }

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(3);
    });

    it('should respect 24h cooldown for disbandRequested', async () => {
      const recentTime = new Date(Date.now() - 1 * 3600 * 1000).toISOString(); // 1h ago
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          state: 'reviewing',
          expiresAt: '2020-01-01T00:00:00Z',
          disbandRequested: recentTime,
        }),
      );

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].needsDisbandRequest).toBe(false); // Within cooldown
    });

    it('should set needsDisbandRequest=true after cooldown expires', async () => {
      const oldTime = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // 25h ago
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          state: 'reviewing',
          expiresAt: '2020-01-01T00:00:00Z',
          disbandRequested: oldTime,
        }),
      );

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].needsDisbandRequest).toBe(true); // Past cooldown
    });

    it('should respect custom PR_SCANNER_DISBAND_COOLDOWN env', async () => {
      // Set cooldown to 1 hour, and disbandRequested was 2h ago
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          state: 'reviewing',
          expiresAt: '2020-01-01T00:00:00Z',
          disbandRequested: twoHoursAgo,
        }),
      );

      const result = await runLifecycle(
        ['--action', 'check-expired'],
        { PR_SCANNER_DISBAND_COOLDOWN: '1' },
      );
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data[0].needsDisbandRequest).toBe(true);
    });

    it('should skip corrupted state files', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), 'bad json{{{');
      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data).toEqual([]);
    });
  });

  // ---- mark-disband ----

  describe('mark-disband', () => {
    it('should set disbandRequested timestamp', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({ prNumber: 9001, state: 'reviewing', disbandRequested: null }),
      );

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(9001);
      expect(data.disbandRequested).not.toBeNull();
      // Verify it's a valid ISO string
      expect(new Date(data.disbandRequested).toISOString()).toBe(data.disbandRequested);
    });

    it('should update updatedAt timestamp', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          updatedAt: '2020-01-01T00:00:00Z',
          disbandRequested: null,
        }),
      );

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.updatedAt).not.toBe('2020-01-01T00:00:00Z');
    });

    it('should overwrite existing disbandRequested timestamp', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          disbandRequested: '2020-01-01T00:00:00Z',
        }),
      );

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.disbandRequested).not.toBe('2020-01-01T00:00:00Z');
    });

    it('should preserve other fields when updating', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({
          prNumber: 9001,
          chatId: 'oc_original',
          state: 'reviewing',
        }),
      );

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.chatId).toBe('oc_original');
      expect(data.prNumber).toBe(9001);
      expect(data.state).toBe('reviewing');
    });

    it('should verify file on disk matches output', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({ prNumber: 9001 }),
      );

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      expect(result.code).toBe(0);

      const fileContent = await readFile(stateFilePath(TEST_STATE_DIR, 9001), 'utf-8');
      const fileData = JSON.parse(fileContent);
      const stdoutData = JSON.parse(result.stdout);
      expect(fileData.disbandRequested).toBe(stdoutData.disbandRequested);
    });

    it('should fail for non-existent PR', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9999']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should fail without --pr', async () => {
      const result = await runLifecycle(['--action', 'mark-disband']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should fail with invalid --pr value', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid --pr value');
    });

    it('should fail for corrupted state file', async () => {
      await writeFile(stateFilePath(TEST_STATE_DIR, 9001), 'not json{{{');

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Corrupted');
    });
  });

  // ---- cleanup ----

  describe('cleanup', () => {
    it('should delete state file', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({ prNumber: 9001, chatId: 'oc_cleanup_test' }),
      );

      const result = await runLifecycle(['--action', 'cleanup', '--pr', '9001']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(9001);
      expect(data.chatId).toBe('oc_cleanup_test');
      expect(data.action).toBe('cleaned-up');

      // Verify file is deleted
      await expect(stat(stateFilePath(TEST_STATE_DIR, 9001))).rejects.toThrow();
    });

    it('should succeed even if state file does not exist', async () => {
      const result = await runLifecycle(['--action', 'cleanup', '--pr', '9001']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('WARN');
    });

    it('should fail without --pr', async () => {
      const result = await runLifecycle(['--action', 'cleanup']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should fail with invalid --pr value', async () => {
      const result = await runLifecycle(['--action', 'cleanup', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid --pr value');
    });

    it('with --repo should attempt label removal', async () => {
      const fakeGhDir = await createFakeGh();
      try {
        await writeFile(
          stateFilePath(TEST_STATE_DIR, 9001),
          createStateJson({ prNumber: 9001 }),
        );

        const result = await runLifecycle(
          ['--action', 'cleanup', '--pr', '9001', '--repo', 'test/repo'],
          { PATH: `${fakeGhDir}:${process.env.PATH}` },
        );
        expect(result.code).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.labelRemoved).toBe(true);
        // Label failure logged as WARN
        expect(result.stderr).toContain('WARN');
      } finally {
        await cleanupFakeGh();
      }
    });

    it('without --repo should not attempt label removal', async () => {
      await writeFile(
        stateFilePath(TEST_STATE_DIR, 9001),
        createStateJson({ prNumber: 9001 }),
      );

      const result = await runLifecycle(['--action', 'cleanup', '--pr', '9001']);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.labelRemoved).toBe(false);
    });
  });

  // ---- General CLI ----

  describe('CLI validation', () => {
    it('should fail without --action', async () => {
      const result = await runLifecycle([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--action is required');
    });

    it('should fail with unknown action', async () => {
      const result = await runLifecycle(['--action', 'unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown action');
    });
  });
});
