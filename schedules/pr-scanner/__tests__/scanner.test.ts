/**
 * Unit tests for schedules/pr-scanner/scanner.ts
 *
 * Covers:
 *   - CLI argument parsing and validation
 *   - State file creation, reading, updating
 *   - check-capacity, create-state, mark, status actions
 *   - Edge cases: corrupted files, missing directory, idempotency
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
const SCRIPT_PATH = resolve(__dir, '../scanner.ts');
const TEST_STATE_DIR = resolve(__dir, '__test_state__');

// Helper to run the scanner script
async function runScanner(
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

// Clean up entire test state directory
async function cleanupTestDir() {
  try {
    const files = await readdir(TEST_STATE_DIR);
    for (const f of files) {
      await rm(resolve(TEST_STATE_DIR, f), { force: true });
    }
  } catch {
    // Directory doesn't exist yet
  }
}

describe('scanner.ts', () => {
  beforeEach(async () => {
    await mkdir(TEST_STATE_DIR, { recursive: true });
    await cleanupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ---- CLI Argument Validation ----

  describe('CLI validation', () => {
    it('should error when --action is missing', async () => {
      const result = await runScanner([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --action');
    });

    it('should error on unknown action', async () => {
      const result = await runScanner(['--action', 'unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Unknown action: 'unknown'");
    });

    it('should error on invalid PR number', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });

    it('should error on negative PR number', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '-1']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });

    it('should error on invalid state for mark', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '1', '--state', 'rejected']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Invalid state: 'rejected'");
    });

    it('should error when --pr is missing for create-state', async () => {
      const result = await runScanner(['--action', 'create-state']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --pr');
    });

    it('should error when --state is missing for mark', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '9001']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --state');
    });
  });

  // ---- create-state action ----

  describe('create-state', () => {
    it('should create a state file for a new PR', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '9001']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.prNumber).toBe(9001);
      expect(output.state).toBe('reviewing');
      expect(output.chatId).toBeNull();
      expect(output.disbandRequested).toBeNull();
      expect(output.createdAt).toBeTruthy();
      expect(output.updatedAt).toBeTruthy();
      expect(output.expiresAt).toBeTruthy();
    });

    it('should persist the state file to disk', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const filePath = resolve(TEST_STATE_DIR, 'pr-9001.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(9001);
      expect(parsed.state).toBe('reviewing');
    });

    it('should set expiresAt to 48h from creation', async () => {
      const before = Date.now();
      const result = await runScanner(['--action', 'create-state', '--pr', '9001']);
      const after = Date.now();

      const output = JSON.parse(result.stdout);
      const expiresAt = new Date(output.expiresAt).getTime();
      const expectedMin = before + 48 * 60 * 60 * 1000 - 1000;
      const expectedMax = after + 48 * 60 * 60 * 1000 + 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('should error if state file already exists', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      const result = await runScanner(['--action', 'create-state', '--pr', '9001']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });
  });

  // ---- mark action ----

  describe('mark', () => {
    it('should update state from reviewing to approved', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.prNumber).toBe(9001);
      expect(output.state).toBe('approved');
    });

    it('should update state from reviewing to closed', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'closed']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.state).toBe('closed');
    });

    it('should update updatedAt timestamp', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 50));

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      const output = JSON.parse(result.stdout);
      expect(new Date(output.updatedAt).getTime()).toBeGreaterThan(new Date(output.createdAt).getTime());
    });

    it('should persist the updated state to disk', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);

      const filePath = resolve(TEST_STATE_DIR, 'pr-9001.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.state).toBe('approved');
    });

    it('should error if state file does not exist', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '9999', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });

    it('should allow transitioning between any valid states', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9002']);

      // reviewing -> approved
      let result = await runScanner(['--action', 'mark', '--pr', '9002', '--state', 'approved']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).state).toBe('approved');

      // approved -> closed
      result = await runScanner(['--action', 'mark', '--pr', '9002', '--state', 'closed']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).state).toBe('closed');
    }, 30_000);

    it('should preserve other fields when updating state', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      const output = JSON.parse(result.stdout);

      // Fields that should be preserved
      expect(output.prNumber).toBe(9001);
      expect(output.chatId).toBeNull();
      expect(output.disbandRequested).toBeNull();
      expect(output.createdAt).toBeTruthy();
      expect(output.expiresAt).toBeTruthy();
    });
  });

  // ---- check-capacity action ----

  describe('check-capacity', () => {
    it('should report full availability when no PRs tracked', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(0);
      expect(output.maxConcurrent).toBe(3);
      expect(output.available).toBe(3);
    });

    it('should count reviewing PRs correctly', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'create-state', '--pr', '9002']);

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(2);
      expect(output.available).toBe(1);
    }, 30_000);

    it('should not count approved/closed PRs as reviewing', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'create-state', '--pr', '9002']);
      await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      await runScanner(['--action', 'mark', '--pr', '9002', '--state', 'closed']);

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(0);
      expect(output.available).toBe(3);
    }, 60_000);

    it('should report zero availability when at max capacity', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'create-state', '--pr', '9002']);
      await runScanner(['--action', 'create-state', '--pr', '9003']);

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(3);
      expect(output.available).toBe(0);
    }, 30_000);

    it('should not report negative availability', async () => {
      // Create more than MAX_CONCURRENT PRs manually
      for (const pr of [9001, 9002, 9003, 9004]) {
        await runScanner(['--action', 'create-state', '--pr', String(pr)]);
      }

      const result = await runScanner(['--action', 'check-capacity']);
      const output = JSON.parse(result.stdout);
      expect(output.available).toBe(0);
    }, 60_000);
  });

  // ---- status action ----

  describe('status', () => {
    it('should report no tracked PRs when empty', async () => {
      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('should group PRs by state', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'create-state', '--pr', '9002']);
      await runScanner(['--action', 'mark', '--pr', '9002', '--state', 'approved']);

      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('reviewing');
      expect(result.stdout).toContain('approved');
      expect(result.stdout).toContain('PR #9001');
      expect(result.stdout).toContain('PR #9002');
    }, 30_000);

    it('should show all three state groups', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);
      await runScanner(['--action', 'create-state', '--pr', '9002']);
      await runScanner(['--action', 'create-state', '--pr', '9003']);
      await runScanner(['--action', 'mark', '--pr', '9002', '--state', 'approved']);
      await runScanner(['--action', 'mark', '--pr', '9003', '--state', 'closed']);

      const result = await runScanner(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[reviewing]');
      expect(result.stdout).toContain('[approved]');
      expect(result.stdout).toContain('[closed]');
    }, 60_000);
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('should handle corrupted state files gracefully', async () => {
      // Write a corrupted JSON file
      const filePath = resolve(TEST_STATE_DIR, 'pr-9005.json');
      await writeFile(filePath, '{ invalid json', 'utf-8');

      // check-capacity should still work, skipping the corrupted file
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Skipping corrupted state file');

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(0);
    });

    it('should handle empty state directory', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
    });

    it('should handle missing --action value', async () => {
      const result = await runScanner(['--action']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument');
    });

    it('should work with state file containing all valid states', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      // reviewing -> approved -> closed -> reviewing (re-open scenario)
      let result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.code).toBe(0);

      result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'closed']);
      expect(result.code).toBe(0);

      result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'reviewing']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).state).toBe('reviewing');
    }, 30_000);

    it('should preserve chatId when marking state changes', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      // Manually set a chatId
      const filePath = resolve(TEST_STATE_DIR, 'pr-9001.json');
      const content = JSON.parse(await readFile(filePath, 'utf-8'));
      content.chatId = 'oc_test_chat_id';
      await writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      const output = JSON.parse(result.stdout);
      expect(output.chatId).toBe('oc_test_chat_id');
    });
  });

  // ---- State File Schema Validation ----

  describe('state file schema', () => {
    it('should match the exact schema from issue specification', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const filePath = resolve(TEST_STATE_DIR, 'pr-9001.json');
      const content = JSON.parse(await readFile(filePath, 'utf-8'));

      // Verify all required fields
      expect(content).toHaveProperty('prNumber');
      expect(content).toHaveProperty('chatId');
      expect(content).toHaveProperty('state');
      expect(content).toHaveProperty('createdAt');
      expect(content).toHaveProperty('updatedAt');
      expect(content).toHaveProperty('expiresAt');
      expect(content).toHaveProperty('disbandRequested');

      // Verify types
      expect(typeof content.prNumber).toBe('number');
      expect(content.chatId).toBeNull();
      expect(typeof content.state).toBe('string');
      expect(typeof content.createdAt).toBe('string');
      expect(typeof content.updatedAt).toBe('string');
      expect(typeof content.expiresAt).toBe('string');
      expect(content.disbandRequested).toBeNull();

      // Verify initial values
      expect(content.prNumber).toBe(9001);
      expect(content.state).toBe('reviewing');
    });

    it('should use UTC ISO 8601 timestamps', async () => {
      await runScanner(['--action', 'create-state', '--pr', '9001']);

      const filePath = resolve(TEST_STATE_DIR, 'pr-9001.json');
      const content = JSON.parse(await readFile(filePath, 'utf-8'));

      // All timestamps should end with 'Z' (UTC)
      expect(content.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(content.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(content.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  // ---- add-label action ----

  describe('add-label', () => {
    it('should error when --pr is missing', async () => {
      const result = await runScanner(['--action', 'add-label']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --pr');
    });

    it('should handle gh CLI failure gracefully (non-blocking)', async () => {
      // gh pr edit will fail in test environment (no auth / no repo)
      const result = await runScanner(['--action', 'add-label', '--pr', '9001']);
      // Non-blocking: should exit 0 even on failure
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.prNumber).toBe(9001);
      expect(output.label).toBe('pr-scanner:reviewing');
      expect(output.operation).toBe('add');
      expect(typeof output.success).toBe('boolean');
      // In test env, gh likely fails
      if (!output.success) {
        expect(output.error).toBeTruthy();
      }
    });

    it('should output valid JSON structure on add-label', async () => {
      const result = await runScanner(['--action', 'add-label', '--pr', '9001']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('prNumber', 9001);
      expect(output).toHaveProperty('label', 'pr-scanner:reviewing');
      expect(output).toHaveProperty('operation', 'add');
      expect(output).toHaveProperty('success');
    });
  });

  // ---- remove-label action ----

  describe('remove-label', () => {
    it('should error when --pr is missing', async () => {
      const result = await runScanner(['--action', 'remove-label']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing required argument: --pr');
    });

    it('should handle gh CLI failure gracefully (non-blocking)', async () => {
      // gh pr edit will fail in test environment (no auth / no repo)
      const result = await runScanner(['--action', 'remove-label', '--pr', '9001']);
      // Non-blocking: should exit 0 even on failure
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(Array.isArray(output)).toBe(true);
      // Should attempt to remove all SCANNER_LABELS
      expect(output.length).toBe(3);

      for (const item of output) {
        expect(item).toHaveProperty('prNumber', 9001);
        expect(item).toHaveProperty('operation', 'remove');
        expect(item).toHaveProperty('success');
        expect(item).toHaveProperty('label');
        expect(item.label).toMatch(/^pr-scanner:/);
      }
    });

    it('should attempt removal of all scanner labels', async () => {
      const result = await runScanner(['--action', 'remove-label', '--pr', '9001']);
      expect(result.code).toBe(0);

      const output: Array<{ label: string }> = JSON.parse(result.stdout);
      const labels = output.map((item) => item.label);
      expect(labels).toContain('pr-scanner:reviewing');
      expect(labels).toContain('pr-scanner:approved');
      expect(labels).toContain('pr-scanner:closed');
    });
  });
});
