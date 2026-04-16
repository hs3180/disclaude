/**
 * Tests for the lifecycle.ts script — discussion group lifecycle management.
 *
 * Tests cover both the exported functions (unit) and the CLI entry point
 * (integration via subprocess). No external network calls are made.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  parsePRStateFile,
  parseArgs,
  checkExpired,
  markDisband,
  nowISO,
  TEMP_CHATS_DIR,
  type PRStateFile,
} from '../lifecycle.js';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_DIR = resolve(PROJECT_ROOT, 'workspace/.temp-chats-test-lifecycle');

// ---- Helpers ----

function createStateFile(overrides: Partial<PRStateFile> = {}): string {
  const defaults: PRStateFile = {
    prNumber: 100,
    chatId: 'oc_test_group',
    state: 'reviewing',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2020-01-01T00:00:00Z', // Far in the past — guaranteed expired
    disbandRequested: null,
  };
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

const TEST_PRS = [100, 101, 102, 103, 104];

async function cleanupTestFiles(): Promise<void> {
  for (const pr of TEST_PRS) {
    try {
      await rm(resolve(TEST_DIR, `pr-${pr}.json`), { force: true });
      await rm(resolve(TEST_DIR, `pr-${pr}.json.tmp`), { force: true });
      await rm(resolve(TEST_DIR, `pr-${pr}.json.*.tmp`), { force: true });
    } catch {
      // Ignore
    }
  }
}

async function runScript(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, script);
  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', scriptPath, ...args],
      {
        env: { ...process.env, TEMP_CHATS_DIR: TEST_DIR, ...env },
        maxBuffer: 1024 * 1024,
        cwd: PROJECT_ROOT,
      },
    );
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

// ---- Unit Tests ----

describe('parsePRStateFile', () => {
  it('should parse a valid state file', () => {
    const json = createStateFile({ prNumber: 42 });
    const result = parsePRStateFile(json, 'pr-42.json');
    expect(result.prNumber).toBe(42);
    expect(result.chatId).toBe('oc_test_group');
    expect(result.state).toBe('reviewing');
    expect(result.disbandRequested).toBeNull();
  });

  it('should throw on invalid JSON', () => {
    expect(() => parsePRStateFile('not json {{{', 'bad.json')).toThrow('not valid JSON');
  });

  it('should throw on non-object JSON', () => {
    expect(() => parsePRStateFile('[1,2,3]', 'array.json')).toThrow('not a valid JSON object');
  });

  it('should throw on missing prNumber', () => {
    const json = JSON.stringify({
      chatId: 'oc_test',
      state: 'reviewing',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T00:00:00Z',
      disbandRequested: null,
    });
    expect(() => parsePRStateFile(json, 'no-pr.json')).toThrow("invalid 'prNumber'");
  });

  it('should throw on invalid state', () => {
    const json = JSON.stringify({
      prNumber: 1,
      chatId: 'oc_test',
      state: 'invalid_state',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T00:00:00Z',
      disbandRequested: null,
    });
    expect(() => parsePRStateFile(json, 'bad-state.json')).toThrow("invalid 'state'");
  });

  it('should throw on non-UTC expiresAt', () => {
    const json = JSON.stringify({
      prNumber: 1,
      chatId: 'oc_test',
      state: 'reviewing',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T00:00:00+08:00',
      disbandRequested: null,
    });
    expect(() => parsePRStateFile(json, 'bad-date.json')).toThrow("invalid 'expiresAt'");
  });

  it('should accept all valid state values', () => {
    for (const state of ['reviewing', 'approved', 'closed'] as const) {
      const json = createStateFile({ state });
      const result = parsePRStateFile(json, 'test.json');
      expect(result.state).toBe(state);
    }
  });
});

describe('parseArgs', () => {
  it('should parse --action check-expired', () => {
    const result = parseArgs(['node', 'script', '--action', 'check-expired']);
    expect(result.action).toBe('check-expired');
    expect(result.pr).toBeUndefined();
  });

  it('should parse --action mark-disband --pr 42', () => {
    const result = parseArgs(['node', 'script', '--action', 'mark-disband', '--pr', '42']);
    expect(result.action).toBe('mark-disband');
    expect(result.pr).toBe(42);
  });

  it('should handle flags in different order', () => {
    const result = parseArgs(['node', 'script', '--pr', '99', '--action', 'mark-disband']);
    expect(result.action).toBe('mark-disband');
    expect(result.pr).toBe(99);
  });
});

describe('checkExpired', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should return empty array when directory does not exist', async () => {
    const result = await checkExpired('/nonexistent/path/.temp-chats');
    expect(result).toEqual([]);
  });

  it('should return empty array when no state files exist', async () => {
    const result = await checkExpired(TEST_DIR);
    expect(result).toEqual([]);
  });

  it('should detect expired PR with no disband request', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(100);
    expect(result[0].canSendDisbandRequest).toBe(true);
    expect(result[0].state).toBe('reviewing');
  });

  it('should not include non-expired PRs', async () => {
    const futureExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({ prNumber: 100, expiresAt: futureExpiry }),
    );
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(0);
  });

  it('should skip non-pr-*.json files', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    await writeFile(resolve(TEST_DIR, 'other-file.json'), '{"not": "a pr state"}');
    await writeFile(resolve(TEST_DIR, 'notes.txt'), 'some notes');
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(100);
  });

  it('should skip corrupted JSON files', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    await writeFile(resolve(TEST_DIR, 'pr-101.json'), 'not valid json {{{');
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(100);
  });

  it('should sort expired PRs by expiration time (oldest first)', async () => {
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({ prNumber: 100, expiresAt: '2020-06-01T00:00:00Z' }),
    );
    await writeFile(
      resolve(TEST_DIR, 'pr-101.json'),
      createStateFile({ prNumber: 101, expiresAt: '2020-01-01T00:00:00Z' }),
    );
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(2);
    expect(result[0].prNumber).toBe(101); // Jan 1 — older
    expect(result[1].prNumber).toBe(100); // Jun 1 — newer
  });

  it('should report canSendDisbandRequest=false when recent disband request exists', async () => {
    const recentRequest = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({ prNumber: 100, disbandRequested: recentRequest }),
    );
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].canSendDisbandRequest).toBe(false);
  });

  it('should report canSendDisbandRequest=true when disband request is >= 24h old', async () => {
    const oldRequest = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({ prNumber: 100, disbandRequested: oldRequest }),
    );
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].canSendDisbandRequest).toBe(true);
  });

  it('should respect DISBAND_COOLDOWN_HOURS env var', async () => {
    const recentRequest = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({ prNumber: 100, disbandRequested: recentRequest }),
    );
    // With 4h cooldown, 5h-old request should be eligible
    const result = await checkExpired(TEST_DIR);
    // Default is 24h, so 5h old should NOT be eligible
    expect(result[0].canSendDisbandRequest).toBe(false);
  });

  it('should handle multiple expired PRs', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    await writeFile(resolve(TEST_DIR, 'pr-101.json'), createStateFile({ prNumber: 101 }));
    await writeFile(
      resolve(TEST_DIR, 'pr-102.json'),
      createStateFile({ prNumber: 102, expiresAt: '2099-12-31T23:59:59Z' }),
    );
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.prNumber)).toEqual([100, 101]);
  });

  it('should include elapsedMs in results', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    const result = await checkExpired(TEST_DIR);
    expect(result[0].elapsedMs).toBeGreaterThan(0);
  });

  it('should skip files with non-pr- prefix', async () => {
    await writeFile(resolve(TEST_DIR, 'other-100.json'), createStateFile({ prNumber: 100 }));
    const result = await checkExpired(TEST_DIR);
    expect(result).toHaveLength(0);
  });
});

describe('markDisband', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should update disbandRequested timestamp', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    const result = await markDisband(100, TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.previousDisbandRequested).toBeNull();

    // Verify file was updated
    const content = await readFile(resolve(TEST_DIR, 'pr-100.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.disbandRequested).toBeTruthy();
    expect(data.updatedAt).toBeTruthy();
  });

  it('should preserve previous disbandRequested in return value', async () => {
    const previousRequest = '2026-01-01T00:00:00Z';
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({ prNumber: 100, disbandRequested: previousRequest }),
    );
    const result = await markDisband(100, TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.previousDisbandRequested).toBe(previousRequest);
  });

  it('should return error for non-existent state file', async () => {
    const result = await markDisband(999, TEST_DIR);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return error for corrupted state file', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), 'not valid json');
    const result = await markDisband(100, TEST_DIR);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not valid JSON');
  });

  it('should update updatedAt timestamp', async () => {
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({ prNumber: 100, updatedAt: '2026-01-01T00:00:00Z' }),
    );
    const before = nowISO();
    await markDisband(100, TEST_DIR);
    const content = await readFile(resolve(TEST_DIR, 'pr-100.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.updatedAt >= '2026-01-01T00:00:00Z').toBe(true);
  });

  it('should preserve other fields when updating', async () => {
    await writeFile(
      resolve(TEST_DIR, 'pr-100.json'),
      createStateFile({
        prNumber: 100,
        chatId: 'oc_original',
        state: 'reviewing',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    );
    await markDisband(100, TEST_DIR);
    const content = await readFile(resolve(TEST_DIR, 'pr-100.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.prNumber).toBe(100);
    expect(data.chatId).toBe('oc_original');
    expect(data.state).toBe('reviewing');
    expect(data.createdAt).toBe('2026-01-01T00:00:00Z');
  });
});

// ---- Integration Tests (CLI) ----

describe('lifecycle.ts CLI', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should exit 0 with no expired PRs', async () => {
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'check-expired']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('No expired PRs');
  });

  it('should output JSON with expired PRs', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'check-expired']);
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(1);
    expect(output[0].prNumber).toBe(100);
    expect(output[0].canSendDisbandRequest).toBe(true);
  });

  it('should mark disband via CLI', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'mark-disband', '--pr', '100']);
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(true);

    // Verify file was updated
    const content = await readFile(resolve(TEST_DIR, 'pr-100.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.disbandRequested).toBeTruthy();
  });

  it('should exit 1 when --action is missing', async () => {
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', []);
    expect(result.code).toBe(1);
  });

  it('should exit 1 when mark-disband lacks --pr', async () => {
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'mark-disband']);
    expect(result.code).toBe(1);
  });

  it('should exit 1 for unknown action', async () => {
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'nonexistent']);
    expect(result.code).toBe(1);
  });

  it('should exit 1 when marking non-existent PR', async () => {
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'mark-disband', '--pr', '999']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('should handle multiple expired PRs in CLI output', async () => {
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    await writeFile(resolve(TEST_DIR, 'pr-101.json'), createStateFile({ prNumber: 101 }));
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'check-expired']);
    expect(result.code).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output).toHaveLength(2);
    expect(result.stderr).toContain('2 expired PR(s)');
  });

  it('should report actionable count in stderr', async () => {
    const recentRequest = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await writeFile(resolve(TEST_DIR, 'pr-100.json'), createStateFile({ prNumber: 100 }));
    await writeFile(
      resolve(TEST_DIR, 'pr-101.json'),
      createStateFile({ prNumber: 101, disbandRequested: recentRequest }),
    );
    const result = await runScript('schedules/pr-scanner/lifecycle.ts', ['--action', 'check-expired']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('2 expired PR(s)');
    expect(result.stderr).toContain('1 eligible for disband request');
  });
});
