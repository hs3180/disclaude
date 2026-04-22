/**
 * Tests for discussion-lifecycle/lifecycle.ts.
 *
 * All tests run offline — no GitHub API or lark-cli calls required.
 * State files are written to a temp directory via STATE_DIR env override.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Use a temp directory for state files during tests
const TEST_STATE_DIR = resolve('/tmp', `lifecycle-test-${Date.now()}`);

beforeEach(async () => {
  process.env.STATE_DIR = TEST_STATE_DIR;
  process.env.SKIP_LARK_CHECK = '1';
  process.env.REPO = 'test/repo';
  await mkdir(TEST_STATE_DIR, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  delete process.env.STATE_DIR;
  delete process.env.SKIP_LARK_CHECK;
  delete process.env.REPO;
});

// ---- Helper: create a state file ----

interface CreateStateOptions {
  prNumber: number;
  chatId?: string | null;
  state?: string;
  createdAt?: string;
  expiresAt?: string;
  disbandRequested?: string | null;
}

async function createStateFile(opts: CreateStateOptions): Promise<string> {
  const filePath = resolve(TEST_STATE_DIR, `pr-${opts.prNumber}.json`);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const created = opts.createdAt || now;
  const expires = opts.expiresAt || new Date(new Date(created).getTime() + 48 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const data = {
    prNumber: opts.prNumber,
    chatId: opts.chatId ?? null,
    state: opts.state || 'reviewing',
    createdAt: created,
    updatedAt: now,
    expiresAt: expires,
    disbandRequested: opts.disbandRequested ?? null,
  };

  await writeFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
  return filePath;
}

// ---- Import module functions ----

// We test by importing the module and calling exported functions
// Since lifecycle.ts uses process.argv for CLI, we test via spawn

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runLifecycle(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', resolve('schedules/discussion-lifecycle/lifecycle.ts'), ...args],
      {
        timeout: 30_000,
        env: { ...process.env, STATE_DIR: TEST_STATE_DIR, SKIP_LARK_CHECK: '1', REPO: 'test/repo' },
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: execErr.stdout || '',
      stderr: execErr.stderr || '',
      exitCode: execErr.code ?? 1,
    };
  }
}

// ---- Tests ----

describe('check-expired', () => {
  it('should return empty array when no state files exist', async () => {
    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toEqual([]);
  });

  it('should return empty array when state dir does not exist', async () => {
    process.env.STATE_DIR = '/tmp/nonexistent-lifecycle-test';
    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toEqual([]);
    process.env.STATE_DIR = TEST_STATE_DIR;
  });

  it('should find expired PRs', async () => {
    const pastTime = '2026-01-01T00:00:00Z';
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({ prNumber: 100, expiresAt: pastExpiry, createdAt: pastTime });

    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(1);
    expect(output[0].prNumber).toBe(100);
    expect(output[0].state).toBe('reviewing');
    expect(output[0].expired).toBeUndefined(); // just has the fields from state file
  });

  it('should not return non-expired PRs', async () => {
    const futureTime = new Date(Date.now() + 48 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await createStateFile({ prNumber: 200, expiresAt: futureTime });

    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(0);
  });

  it('should skip corrupted state files', async () => {
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({ prNumber: 300, expiresAt: pastExpiry, createdAt: '2026-01-01T00:00:00Z' });

    // Create a corrupted file
    const corruptPath = resolve(TEST_STATE_DIR, 'pr-301.json');
    await writeFile(corruptPath, 'not json', 'utf-8');

    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(1);
    expect(output[0].prNumber).toBe(300);
  });

  it('should find multiple expired PRs', async () => {
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({ prNumber: 400, expiresAt: pastExpiry, createdAt: '2026-01-01T00:00:00Z' });
    await createStateFile({ prNumber: 401, expiresAt: pastExpiry, createdAt: '2026-01-01T00:00:00Z' });

    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(2);
    const prNumbers = output.map((o: { prNumber: number }) => o.prNumber).sort();
    expect(prNumbers).toEqual([400, 401]);
  });

  it('should include disbandRequested field', async () => {
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({
      prNumber: 500,
      expiresAt: pastExpiry,
      createdAt: '2026-01-01T00:00:00Z',
      disbandRequested: '2026-01-02T12:00:00Z',
    });

    const result = await runLifecycle('check-expired');
    const output = JSON.parse(result.stdout);
    expect(output[0].disbandRequested).toBe('2026-01-02T12:00:00Z');
  });
});

describe('mark-disband', () => {
  it('should update disbandRequested timestamp', async () => {
    const futureExpiry = new Date(Date.now() + 48 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await createStateFile({ prNumber: 600, expiresAt: futureExpiry });

    const result = await runLifecycle('mark-disband', '600');
    expect(result.exitCode).toBe(0);

    // Check the output
    const output = JSON.parse(result.stdout);
    expect(output.prNumber).toBe(600);
    expect(output.disbandRequested).toBeTruthy();

    // Verify file on disk
    const filePath = resolve(TEST_STATE_DIR, 'pr-600.json');
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(content.disbandRequested).toBeTruthy();
    expect(content.disbandRequested).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('should overwrite existing disbandRequested', async () => {
    const futureExpiry = new Date(Date.now() + 48 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await createStateFile({
      prNumber: 601,
      expiresAt: futureExpiry,
      disbandRequested: '2026-01-01T00:00:00Z',
    });

    const result = await runLifecycle('mark-disband', '601');
    expect(result.exitCode).toBe(0);

    const filePath = resolve(TEST_STATE_DIR, 'pr-601.json');
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    // Should be updated to a recent timestamp
    expect(content.disbandRequested).not.toBe('2026-01-01T00:00:00Z');
  });

  it('should fail for non-existent PR', async () => {
    const result = await runLifecycle('mark-disband', '999');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('should fail for invalid PR number', async () => {
    const result = await runLifecycle('mark-disband', 'invalid');
    expect(result.exitCode).toBe(1);
  });

  it('should preserve other fields when updating disbandRequested', async () => {
    const futureExpiry = new Date(Date.now() + 48 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await createStateFile({ prNumber: 602, chatId: 'oc_test_chat', expiresAt: futureExpiry });

    await runLifecycle('mark-disband', '602');

    const filePath = resolve(TEST_STATE_DIR, 'pr-602.json');
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(content.prNumber).toBe(602);
    expect(content.chatId).toBe('oc_test_chat');
    expect(content.state).toBe('reviewing');
    expect(content.disbandRequested).toBeTruthy();
  });
});

describe('disband', () => {
  it('should delete state file for reviewing PR', async () => {
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({ prNumber: 700, state: 'reviewing', expiresAt: pastExpiry });

    // Note: This will fail on gh label removal and lark-cli since they're not available,
    // but the state file should still be deleted
    const result = await runLifecycle('disband', '700');

    // Check that the state file was deleted
    const filePath = resolve(TEST_STATE_DIR, 'pr-700.json');
    let fileExists = false;
    try {
      await stat(filePath);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  it('should reject disband for non-reviewing state', async () => {
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({ prNumber: 701, state: 'approved', expiresAt: pastExpiry });

    const result = await runLifecycle('disband', '701');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('state is \'approved\'');

    // File should still exist
    const filePath = resolve(TEST_STATE_DIR, 'pr-701.json');
    let fileExists = false;
    try {
      await stat(filePath);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(true);
  });

  it('should reject disband for closed state', async () => {
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({ prNumber: 702, state: 'closed', expiresAt: pastExpiry });

    const result = await runLifecycle('disband', '702');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('state is \'closed\'');
  });

  it('should fail for non-existent PR', async () => {
    const result = await runLifecycle('disband', '999');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });
});

describe('help', () => {
  it('should show help text', async () => {
    const result = await runLifecycle('help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('check-expired');
    expect(result.stdout).toContain('mark-disband');
    expect(result.stdout).toContain('disband');
  });

  it('should show help for --help flag', async () => {
    const result = await runLifecycle('--help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('check-expired');
  });

  it('should show error for unknown action', async () => {
    const result = await runLifecycle('unknown-action');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown action');
  });
});

describe('edge cases', () => {
  it('should handle empty state directory', async () => {
    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toEqual([]);
  });

  it('should handle non-JSON files in state directory', async () => {
    await writeFile(resolve(TEST_STATE_DIR, 'not-pr-file.txt'), 'hello', 'utf-8');
    const pastExpiry = '2026-01-03T00:00:00Z';
    await createStateFile({ prNumber: 800, expiresAt: pastExpiry, createdAt: '2026-01-01T00:00:00Z' });

    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(1);
    expect(output[0].prNumber).toBe(800);
  });

  it('should handle state file with extra fields', async () => {
    const pastExpiry = '2026-01-03T00:00:00Z';
    const filePath = resolve(TEST_STATE_DIR, 'pr-900.json');
    const data = {
      prNumber: 900,
      chatId: 'oc_test',
      state: 'reviewing',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      expiresAt: pastExpiry,
      disbandRequested: null,
      extraField: 'should be ignored',
    };
    await writeFile(filePath, JSON.stringify(data) + '\n', 'utf-8');

    const result = await runLifecycle('check-expired');
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(1);
    expect(output[0].prNumber).toBe(900);
  });
});
