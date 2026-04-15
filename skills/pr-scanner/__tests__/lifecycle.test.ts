/**
 * Integration tests for lifecycle.ts — PR discussion group lifecycle management.
 *
 * Issue #2221: Tests all CLI actions (check-expired, mark-disband, confirm-disband, cleanup-state).
 * Uses temporary directories for state files (no real lark-cli or gh dependency).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

// Test-specific state directory
const TEST_STATE_DIR = resolve(PROJECT_ROOT, 'workspace/schedules/.temp-chats-test-lifecycle');

async function runScript(
  action: string,
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/pr-scanner/lifecycle.ts');
  const args = ['tsx', scriptPath, '--action', action, ...extraArgs];

  try {
    const result = await execFileAsync('npx', args, {
      env: { ...process.env, PR_STATE_DIR: TEST_STATE_DIR, ...env },
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

function createPRState(overrides: Record<string, unknown> = {}): string {
  const defaults = {
    prNumber: 100,
    chatId: 'oc_test_chat_100',
    state: 'reviewing',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2020-01-01T00:00:00Z', // Far in the past
    disbandRequested: null,
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

async function cleanupTestDir() {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

async function writePRFile(prNumber: number, data: string) {
  const filePath = resolve(TEST_STATE_DIR, `pr-${prNumber}.json`);
  await writeFile(filePath, data, 'utf-8');
  return filePath;
}

async function readPRFile(prNumber: number): Promise<string | null> {
  const filePath = resolve(TEST_STATE_DIR, `pr-${prNumber}.json`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('lifecycle.ts', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ---- check-expired ----

  describe('check-expired', () => {
    it('returns empty array when no state files exist', async () => {
      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('check-expired');
      expect(output.expired).toEqual([]);
    });

    it('returns empty array when state directory does not exist', async () => {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });
      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.expired).toEqual([]);
    });

    it('finds expired reviewing PRs that have never been requested', async () => {
      await writePRFile(100, createPRState({
        prNumber: 100,
        state: 'reviewing',
        expiresAt: '2020-01-01T00:00:00Z',
        disbandRequested: null,
      }));

      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.expired).toHaveLength(1);
      expect(output.expired[0].prNumber).toBe(100);
      expect(output.expired[0].disbandEligible).toBe(true);
      expect(output.expired[0].hoursSinceLastRequest).toBeNull();
    });

    it('finds expired PRs with stale disband requests (>= 24h)', async () => {
      const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writePRFile(200, createPRState({
        prNumber: 200,
        state: 'reviewing',
        expiresAt: '2020-01-01T00:00:00Z',
        disbandRequested: yesterday,
      }));

      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.expired).toHaveLength(1);
      expect(output.expired[0].prNumber).toBe(200);
      expect(output.expired[0].disbandEligible).toBe(true);
      expect(output.expired[0].hoursSinceLastRequest).toBeGreaterThanOrEqual(24);
    });

    it('skips PRs with recent disband requests (< 24h)', async () => {
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writePRFile(300, createPRState({
        prNumber: 300,
        state: 'reviewing',
        expiresAt: '2020-01-01T00:00:00Z',
        disbandRequested: oneHourAgo,
      }));

      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.expired).toHaveLength(1);
      expect(output.expired[0].prNumber).toBe(300);
      expect(output.expired[0].disbandEligible).toBe(false);
    });

    it('skips non-reviewing PRs', async () => {
      await writePRFile(400, createPRState({
        prNumber: 400,
        state: 'approved',
        expiresAt: '2020-01-01T00:00:00Z',
      }));
      await writePRFile(401, createPRState({
        prNumber: 401,
        state: 'closed',
        expiresAt: '2020-01-01T00:00:00Z',
      }));

      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.expired).toHaveLength(0);
    });

    it('skips non-expired PRs', async () => {
      const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writePRFile(500, createPRState({
        prNumber: 500,
        state: 'reviewing',
        expiresAt: future,
      }));

      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.expired).toHaveLength(0);
    });

    it('handles multiple PRs with mixed states', async () => {
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

      // PR 100: expired, reviewing, never requested -> eligible
      await writePRFile(100, createPRState({ prNumber: 100, state: 'reviewing', expiresAt: '2020-01-01T00:00:00Z', disbandRequested: null }));
      // PR 200: expired, reviewing, requested recently -> not eligible
      await writePRFile(200, createPRState({ prNumber: 200, state: 'reviewing', expiresAt: '2020-01-01T00:00:00Z', disbandRequested: oneHourAgo }));
      // PR 300: expired, reviewing, requested long ago -> eligible
      await writePRFile(300, createPRState({ prNumber: 300, state: 'reviewing', expiresAt: '2020-01-01T00:00:00Z', disbandRequested: yesterday }));
      // PR 400: expired, approved -> skip
      await writePRFile(400, createPRState({ prNumber: 400, state: 'approved', expiresAt: '2020-01-01T00:00:00Z' }));
      // PR 500: not expired -> skip
      await writePRFile(500, createPRState({ prNumber: 500, state: 'reviewing', expiresAt: future }));

      const result = await runScript('check-expired');
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.expired).toHaveLength(3);

      const prNumbers = output.expired.map((e: { prNumber: number }) => e.prNumber).sort();
      expect(prNumbers).toEqual([100, 200, 300]);

      const eligible = output.expired.filter((e: { disbandEligible: boolean }) => e.disbandEligible);
      expect(eligible.map((e: { prNumber: number }) => e.prNumber).sort()).toEqual([100, 300]);
    });

    it('skips non-pr-*.json files', async () => {
      await writePRFile(100, createPRState({ prNumber: 100 }));
      await writeFile(resolve(TEST_STATE_DIR, 'other-file.json'), '{}', 'utf-8');
      await writeFile(resolve(TEST_STATE_DIR, 'pr-notanumber.json'), '{}', 'utf-8');

      const result = await runScript('check-expired');
      expect(result.code).toBe(0);
      // Should not crash on invalid files
    });
  });

  // ---- mark-disband ----

  describe('mark-disband', () => {
    it('updates disbandRequested timestamp', async () => {
      await writePRFile(100, createPRState({
        prNumber: 100,
        state: 'reviewing',
        disbandRequested: null,
      }));

      const result = await runScript('mark-disband', ['--pr', '100']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.prNumber).toBe(100);
      expect(output.disbandRequested).toBeTruthy();

      // Verify file was updated
      const fileContent = await readPRFile(100);
      const stateFile = JSON.parse(fileContent!);
      expect(stateFile.disbandRequested).toBeTruthy();
      expect(stateFile.updatedAt).toBeTruthy();
    });

    it('fails for non-existent PR', async () => {
      const result = await runScript('mark-disband', ['--pr', '999']);
      expect(result.code).toBe(1);
    });

    it('overwrites existing disbandRequested timestamp', async () => {
      const oldTimestamp = '2020-01-01T00:00:00Z';
      await writePRFile(100, createPRState({
        prNumber: 100,
        disbandRequested: oldTimestamp,
      }));

      const result = await runScript('mark-disband', ['--pr', '100']);
      expect(result.code).toBe(0);

      const fileContent = await readPRFile(100);
      const stateFile = JSON.parse(fileContent!);
      expect(stateFile.disbandRequested).not.toBe(oldTimestamp);
      // New timestamp should be recent
      expect(new Date(stateFile.disbandRequested).getTime()).toBeGreaterThan(Date.now() - 60000);
    });
  });

  // ---- confirm-disband ----

  describe('confirm-disband', () => {
    it('confirms reviewing PR with instructions', async () => {
      await writePRFile(100, createPRState({
        prNumber: 100,
        chatId: 'oc_test_chat_100',
        state: 'reviewing',
      }));

      const result = await runScript('confirm-disband', ['--pr', '100']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.prNumber).toBe(100);
      expect(output.chatId).toBe('oc_test_chat_100');
      expect(output.instructions).toBeDefined();
      expect(output.instructions.dissolveGroup).toContain('lark-cli');
      expect(output.instructions.removeLabel).toContain('pr-scanner:reviewing');
    });

    it('rejects non-reviewing PR', async () => {
      await writePRFile(200, createPRState({
        prNumber: 200,
        state: 'approved',
      }));

      const result = await runScript('confirm-disband', ['--pr', '200']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(false);
      expect(output.reason).toContain('approved');
    });

    it('handles null chatId gracefully', async () => {
      await writePRFile(300, createPRState({
        prNumber: 300,
        chatId: null,
        state: 'reviewing',
      }));

      const result = await runScript('confirm-disband', ['--pr', '300']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.instructions.dissolveGroup).toBeNull();
    });

    it('fails for non-existent PR', async () => {
      const result = await runScript('confirm-disband', ['--pr', '999']);
      expect(result.code).toBe(1);
    });
  });

  // ---- cleanup-state ----

  describe('cleanup-state', () => {
    it('removes state file', async () => {
      await writePRFile(100, createPRState({ prNumber: 100 }));

      const result = await runScript('cleanup-state', ['--pr', '100']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);

      // Verify file is gone
      const content = await readPRFile(100);
      expect(content).toBeNull();
    });

    it('handles already-removed file gracefully', async () => {
      const result = await runScript('cleanup-state', ['--pr', '999']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(false);
      expect(output.reason).toContain('not found');
    });
  });

  // ---- CLI argument validation ----

  describe('CLI argument validation', () => {
    it('fails without --action', async () => {
      const result = await runScript('', []);
      expect(result.code).toBe(1);
    });

    it('fails with unknown action', async () => {
      const result = await runScript('unknown-action');
      expect(result.code).toBe(1);
    });

    it('fails mark-disband without --pr', async () => {
      const result = await runScript('mark-disband');
      expect(result.code).toBe(1);
    });

    it('fails confirm-disband with invalid --pr value', async () => {
      const result = await runScript('confirm-disband', ['--pr', 'abc']);
      expect(result.code).toBe(1);
    });
  });

  // ---- Custom cooldown hours ----

  describe('custom cooldown', () => {
    it('respects DISBAND_COOLDOWN_HOURS env var', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writePRFile(100, createPRState({
        prNumber: 100,
        state: 'reviewing',
        expiresAt: '2020-01-01T00:00:00Z',
        disbandRequested: twoHoursAgo,
      }));

      // Default 24h cooldown -> not eligible (only 2h ago)
      const result1 = await runScript('check-expired');
      const output1 = JSON.parse(result1.stdout);
      expect(output1.expired[0].disbandEligible).toBe(false);

      // 1h cooldown -> eligible (2h > 1h)
      const result2 = await runScript('check-expired', [], { DISBAND_COOLDOWN_HOURS: '1' });
      const output2 = JSON.parse(result2.stdout);
      expect(output2.expired[0].disbandEligible).toBe(true);
    });
  });
});
