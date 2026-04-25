/**
 * Unit tests for schedules/discussion-lifecycle/lifecycle.ts
 *
 * Covers:
 *   - CLI argument parsing and validation
 *   - check-expired: detecting expired PRs with notification logic
 *   - mark-disband: updating disbandRequested timestamp
 *   - cleanup: removing state files
 *   - Edge cases: corrupted files, missing directory, 24h notification interval
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const SCRIPT_PATH = resolve(__dir, '../lifecycle.ts');
const TEST_STATE_DIR = resolve(__dir, '__test_state__');

// Helper to run the lifecycle script
async function runLifecycle(
  args: string[],
  timeout = 15_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT_PATH, ...args], {
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PR_STATE_DIR: TEST_STATE_DIR },
      timeout,
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

// Create a state file for testing
async function createStateFile(prNumber: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const now = new Date();
  const filePath = resolve(TEST_STATE_DIR, `pr-${prNumber}.json`);

  const defaults = {
    prNumber,
    chatId: `oc_test_chat_${prNumber}`,
    state: 'reviewing',
    createdAt: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(), // 72h ago
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), // expired 24h ago
    disbandRequested: null,
  };

  const state = { ...defaults, ...overrides };
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  return filePath;
}

// Clean up entire test state directory
async function cleanupTestDir() {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Directory doesn't exist
  }
}

describe('lifecycle.ts', () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_DIR, { recursive: true });
    await cleanupTestDir();
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ---- CLI Argument Validation ----

  describe('CLI validation', () => {
    it('should error when --action is missing', async () => {
      const result = await runLifecycle([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --action');
    });

    it('should error on unknown action', async () => {
      const result = await runLifecycle(['--action', 'unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Unknown action: 'unknown'");
    });

    it('should error on invalid PR number', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });

    it('should error on negative PR number', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '-1']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });

    it('should error when --pr is missing for mark-disband', async () => {
      const result = await runLifecycle(['--action', 'mark-disband']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --pr');
    });

    it('should error when --pr is missing for cleanup', async () => {
      const result = await runLifecycle(['--action', 'cleanup']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --pr');
    });
  });

  // ---- check-expired action ----

  describe('check-expired', () => {
    it('should return empty array when no state files', async () => {
      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should detect expired PRs (now > expiresAt)', async () => {
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), // expired 10h ago
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(1);
      expect(output[0].prNumber).toBe(9001);
      expect(output[0].needsDisbandNotification).toBe(true);
      expect(output[0].hoursSinceExpiry).toBeGreaterThan(9);
      expect(output[0].hoursSinceDisband).toBeNull();
    });

    it('should not include non-expired PRs', async () => {
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // expires in 24h
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should not include PRs that have not yet expired', async () => {
      // Set expiresAt to 1 minute in the future (generous margin for subprocess startup)
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() + 60_000).toISOString(), // expires in 1 minute
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should sort expired PRs by expiry time (oldest first)', async () => {
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30h ago
      });
      await createStateFile(9002, {
        expiresAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5h ago
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(2);
      expect(output[0].prNumber).toBe(9001); // expired earlier
      expect(output[1].prNumber).toBe(9002); // expired later
    });

    it('should detect PRs needing disband notification (no previous request)', async () => {
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        disbandRequested: null,
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      expect(output[0].needsDisbandNotification).toBe(true);
    });

    it('should not flag PRs for notification if disband was requested within 24h', async () => {
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        disbandRequested: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      expect(output[0].needsDisbandNotification).toBe(false);
      expect(output[0].hoursSinceDisband).toBeLessThan(3);
    });

    it('should flag PRs for notification if disband was requested >= 24h ago', async () => {
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        disbandRequested: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      expect(output[0].needsDisbandNotification).toBe(true);
      expect(output[0].hoursSinceDisband).toBeGreaterThan(24);
    });

    it('should handle mixed expired and non-expired PRs', async () => {
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), // expired
      });
      await createStateFile(9002, {
        expiresAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(), // not expired
      });
      await createStateFile(9003, {
        expiresAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // expired
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(2);
      expect(output.map((e: { prNumber: number }) => e.prNumber)).toContain(9001);
      expect(output.map((e: { prNumber: number }) => e.prNumber)).toContain(9003);
    });

    it('should preserve state information for expired PRs', async () => {
      await createStateFile(9001, {
        state: 'approved',
        chatId: 'oc_specific_chat',
        expiresAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      expect(output[0].state).toBe('approved');
      expect(output[0].chatId).toBe('oc_specific_chat');
    });
  });

  // ---- mark-disband action ----

  describe('mark-disband', () => {
    it('should set disbandRequested timestamp on existing state file', async () => {
      await createStateFile(9001);

      const before = Date.now();
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      const after = Date.now();
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.prNumber).toBe(9001);
      expect(output.disbandRequested).toBeTruthy();

      const disbandTime = new Date(output.disbandRequested).getTime();
      expect(disbandTime).toBeGreaterThanOrEqual(before - 1000);
      expect(disbandTime).toBeLessThanOrEqual(after + 1000);
    });

    it('should persist disbandRequested to disk', async () => {
      await createStateFile(9001);
      await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);

      const filePath = resolve(TEST_STATE_DIR, 'pr-9001.json');
      const content = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(content.disbandRequested).toBeTruthy();
    });

    it('should update updatedAt timestamp', async () => {
      await createStateFile(9001, {
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
      });

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      const output = JSON.parse(result.stdout);

      // updatedAt should be close to now
      const updatedMs = new Date(output.updatedAt).getTime();
      expect(Date.now() - updatedMs).toBeLessThan(5000);
    });

    it('should overwrite previous disbandRequested timestamp', async () => {
      await createStateFile(9001, {
        disbandRequested: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), // 10h ago
      });

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      const output = JSON.parse(result.stdout);

      // New disbandRequested should be recent
      const disbandMs = new Date(output.disbandRequested).getTime();
      expect(Date.now() - disbandMs).toBeLessThan(5000);
    });

    it('should preserve all other fields', async () => {
      await createStateFile(9001, {
        chatId: 'oc_preserved_chat',
        state: 'reviewing',
      });

      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9001']);
      const output = JSON.parse(result.stdout);

      expect(output.prNumber).toBe(9001);
      expect(output.chatId).toBe('oc_preserved_chat');
      expect(output.state).toBe('reviewing');
      expect(output.createdAt).toBeTruthy();
      expect(output.expiresAt).toBeTruthy();
    });

    it('should error if state file does not exist', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '9999']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });
  });

  // ---- cleanup action ----

  describe('cleanup', () => {
    it('should delete the state file', async () => {
      await createStateFile(9001);

      const result = await runLifecycle(['--action', 'cleanup', '--pr', '9001']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.prNumber).toBe(9001);
      expect(output.deleted).toBe(true);

      // Verify file is actually deleted
      const filePath = resolve(TEST_STATE_DIR, 'pr-9001.json');
      await expect(readFile(filePath, 'utf-8')).rejects.toThrow();
    });

    it('should output valid JSON with timestamp', async () => {
      await createStateFile(9001);

      const result = await runLifecycle(['--action', 'cleanup', '--pr', '9001']);
      const output = JSON.parse(result.stdout);

      expect(output).toHaveProperty('prNumber', 9001);
      expect(output).toHaveProperty('action', 'cleanup');
      expect(output).toHaveProperty('deleted', true);
      expect(output).toHaveProperty('timestamp');
      expect(new Date(output.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should error if state file does not exist', async () => {
      const result = await runLifecycle(['--action', 'cleanup', '--pr', '9999']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });

    it('should not affect other state files', async () => {
      await createStateFile(9001);
      await createStateFile(9002);

      await runLifecycle(['--action', 'cleanup', '--pr', '9001']);

      // PR 9002 file should still exist
      const filePath = resolve(TEST_STATE_DIR, 'pr-9002.json');
      const content = await readFile(filePath, 'utf-8');
      expect(JSON.parse(content).prNumber).toBe(9002);
    });
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('should handle corrupted state files gracefully in check-expired', async () => {
      const filePath = resolve(TEST_STATE_DIR, 'pr-9005.json');
      await writeFile(filePath, '{ invalid json', 'utf-8');

      // Should not crash, just skip the corrupted file
      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Skipping corrupted');
    });

    it('should handle empty state directory', async () => {
      const result = await runLifecycle(['--action', 'check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should handle missing --action value', async () => {
      const result = await runLifecycle(['--action']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument');
    });

    it('should handle zero PR number', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '0']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });

    it('should handle float PR number', async () => {
      const result = await runLifecycle(['--action', 'mark-disband', '--pr', '1.5']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });

    it('should accept positional action argument', async () => {
      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);
    });

    it('should handle state file with null chatId', async () => {
      await createStateFile(9001, { chatId: null });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      expect(output[0].chatId).toBeNull();
    });

    it('should handle boundary 24h disband interval', async () => {
      // disbandRequested exactly 24h ago (should still need notification)
      await createStateFile(9001, {
        expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        disbandRequested: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      // Exactly 24h ago should still trigger (>= comparison)
      expect(output[0].needsDisbandNotification).toBe(true);
    });

    it('should handle state file with approved state in check-expired', async () => {
      await createStateFile(9001, {
        state: 'approved',
        expiresAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
      });

      const result = await runLifecycle(['--action', 'check-expired']);
      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(1);
      expect(output[0].state).toBe('approved');
    });
  });
});
