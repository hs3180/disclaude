/**
 * Unit tests for PR Scanner state management (pr-scanner.ts).
 *
 * Tests all CLI actions + state file read/write + edge cases.
 * Does not depend on GitHub API (list-candidates uses mock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseStateFile,
  readAllStates,
  type PrStateFile,
  type PrState,
} from './pr-scanner.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats');

function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

function makeStateFile(overrides: Partial<PrStateFile> = {}): PrStateFile {
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

const TEST_PRS = [9001, 9002, 9003];

async function cleanupTestFiles() {
  for (const pr of TEST_PRS) {
    try {
      await rm(stateFilePath(pr), { force: true });
      await rm(`${stateFilePath(pr)}.lock`, { force: true });
    } catch {
      // Ignore
    }
  }
  // Clean up any .tmp files
  try {
    const files = await readdir(STATE_DIR);
    for (const f of files) {
      if (f.includes('9001') || f.includes('9002') || f.includes('9003')) {
        await rm(resolve(STATE_DIR, f), { force: true });
      }
    }
  } catch {
    // Ignore
  }
}

async function writeStateFile(prNumber: number, data: PrStateFile) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(stateFilePath(prNumber), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function runScanner(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', resolve(__dirname, 'pr-scanner.ts'), ...args],
      {
        cwd: PROJECT_ROOT,
        timeout: 15_000,
        env: { ...process.env, ...env },
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

describe('pr-scanner', () => {
  beforeEach(async () => {
    await mkdir(STATE_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  // ---- parseStateFile ----

  describe('parseStateFile', () => {
    it('should parse a valid state file', () => {
      const data = makeStateFile();
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.prNumber).toBe(1);
      expect(result.state).toBe('reviewing');
      expect(result.disbandRequested).toBeNull();
    });

    it('should accept all valid states', () => {
      for (const state of ['reviewing', 'approved', 'closed'] as const) {
        const data = makeStateFile({ state });
        const result = parseStateFile(JSON.stringify(data), 'test.json');
        expect(result.state).toBe(state);
      }
    });

    it('should reject invalid JSON', () => {
      expect(() => parseStateFile('not json', 'test.json')).toThrow('not valid JSON');
    });

    it('should reject non-object JSON', () => {
      expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('"string"', 'test.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('null', 'test.json')).toThrow('not a valid JSON object');
    });

    it('should reject missing prNumber', () => {
      const data = makeStateFile();
      delete (data as Record<string, unknown>).prNumber;
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('prNumber');
    });

    it('should reject non-integer prNumber', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), prNumber: 1.5 }), 'test.json')).toThrow('prNumber');
    });

    it('should reject zero or negative prNumber', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), prNumber: 0 }), 'test.json')).toThrow('prNumber');
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), prNumber: -1 }), 'test.json')).toThrow('prNumber');
    });

    it('should reject invalid state values', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), state: 'rejected' }), 'test.json')).toThrow('state');
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), state: 'pending' }), 'test.json')).toThrow('state');
    });

    it('should reject non-null disbandRequested', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), disbandRequested: 'yes' }), 'test.json')).toThrow('disbandRequested');
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), disbandRequested: false }), 'test.json')).toThrow('disbandRequested');
    });

    it('should accept chatId as null', () => {
      const data = makeStateFile({ chatId: null });
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.chatId).toBeNull();
    });

    it('should accept chatId as string', () => {
      const data = makeStateFile({ chatId: 'oc_abc123' });
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.chatId).toBe('oc_abc123');
    });

    it('should reject invalid timestamps', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), createdAt: '2026-04-07' }), 'test.json')).toThrow('createdAt');
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), updatedAt: 'invalid' }), 'test.json')).toThrow('updatedAt');
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), expiresAt: '2026-04-09T10:00:00+08:00' }), 'test.json')).toThrow('expiresAt');
    });
  });

  // ---- readAllStates ----

  describe('readAllStates', () => {
    it('should return empty array when state dir does not exist', async () => {
      const states = await readAllStates();
      expect(Array.isArray(states)).toBe(true);
    });

    it('should read valid state files', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001 }));
      await writeStateFile(9002, makeStateFile({ prNumber: 9002, state: 'approved' }));

      const states = await readAllStates();
      const nums = states.map((s) => s.prNumber);
      expect(nums).toContain(9001);
      expect(nums).toContain(9002);
    });

    it('should skip corrupted files gracefully', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001 }));
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(stateFilePath(9002), 'corrupted json{{{', 'utf-8');

      const states = await readAllStates();
      expect(states.length).toBe(1);
      expect(states[0].prNumber).toBe(9001);
    });

    it('should ignore non-pr JSON files', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001 }));
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(resolve(STATE_DIR, 'other-file.json'), '{}', 'utf-8');

      const states = await readAllStates();
      expect(states.length).toBe(1);
    });
  });

  // ---- CLI: check-capacity ----

  describe('action: check-capacity', () => {
    it('should report zero reviewing when empty', async () => {
      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(0);
      expect(data.available).toBeGreaterThanOrEqual(0);
    });

    it('should count reviewing state files', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001, state: 'reviewing' }));
      await writeStateFile(9002, makeStateFile({ prNumber: 9002, state: 'approved' }));

      const result = await runScanner(['--action', 'check-capacity']);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.reviewing).toBe(1);
    });
  });

  // ---- CLI: create-state ----

  describe('action: create-state', () => {
    it('should create a new state file', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', '9001']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.prNumber).toBe(9001);
      expect(data.state).toBe('reviewing');
      expect(data.chatId).toBeNull();
      expect(data.disbandRequested).toBeNull();

      // Verify file exists on disk
      const content = await readFile(stateFilePath(9001), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(9001);

      // Verify expiresAt is ~48h after createdAt
      const created = new Date(data.createdAt);
      const expires = new Date(data.expiresAt);
      const diffHours = (expires.getTime() - created.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBe(48);
    });

    it('should reject creating duplicate state file', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001 }));

      const result = await runScanner(['--action', 'create-state', '--pr', '9001']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should require --pr flag', async () => {
      const result = await runScanner(['--action', 'create-state']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should reject invalid --pr value', async () => {
      const result = await runScanner(['--action', 'create-state', '--pr', 'abc']);
      expect(result.exitCode).toBe(1);
    });
  });

  // ---- CLI: mark ----

  describe('action: mark', () => {
    it('should update state from reviewing to approved', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('approved');
      expect(data.prNumber).toBe(9001);

      // Verify on disk
      const content = await readFile(stateFilePath(9001), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.state).toBe('approved');
    });

    it('should update state from reviewing to closed', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'closed']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('closed');
    });

    it('should return current state without changes when same state', async () => {
      const original = makeStateFile({ prNumber: 9001, state: 'approved' });
      await writeStateFile(9001, original);

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'approved']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      expect(data.state).toBe('approved');
      expect(data.updatedAt).toBe(original.updatedAt); // No update
    });

    it('should fail for non-existent PR', async () => {
      const result = await runScanner(['--action', 'mark', '--pr', '9999', '--state', 'approved']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should reject invalid state value', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001 }));

      const result = await runScanner(['--action', 'mark', '--pr', '9001', '--state', 'rejected']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid state');
    });

    it('should require --pr and --state flags', async () => {
      const r1 = await runScanner(['--action', 'mark']);
      expect(r1.exitCode).toBe(1);
      expect(r1.stderr).toContain('--pr is required');

      const r2 = await runScanner(['--action', 'mark', '--pr', '9001']);
      expect(r2.exitCode).toBe(1);
      expect(r2.stderr).toContain('--state is required');
    });
  });

  // ---- CLI: status ----

  describe('action: status', () => {
    it('should show empty message when no tracked PRs', async () => {
      await cleanupTestFiles();

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('should group PRs by state', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001, state: 'reviewing' }));
      await writeStateFile(9002, makeStateFile({ prNumber: 9002, state: 'approved' }));
      await writeStateFile(9003, makeStateFile({ prNumber: 9003, state: 'closed' }));

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('REVIEWING');
      expect(result.stdout).toContain('APPROVED');
      expect(result.stdout).toContain('CLOSED');
      expect(result.stdout).toContain('9001');
      expect(result.stdout).toContain('9002');
      expect(result.stdout).toContain('9003');
      expect(result.stdout).toContain('Total: 3 tracked PR');
    });

    it('should only show states with entries', async () => {
      await writeStateFile(9001, makeStateFile({ prNumber: 9001, state: 'reviewing' }));

      const result = await runScanner(['--action', 'status']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('REVIEWING');
      expect(result.stdout).not.toContain('APPROVED');
      expect(result.stdout).not.toContain('CLOSED');
    });
  });

  // ---- CLI: general ----

  describe('CLI argument parsing', () => {
    it('should show help with --help', async () => {
      const result = await runScanner(['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('check-capacity');
    });

    it('should error on missing --action', async () => {
      const result = await runScanner([]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--action');
    });

    it('should error on unknown action', async () => {
      const result = await runScanner(['--action', 'nonexistent']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown action');
    });

    it('should error on unknown argument', async () => {
      const result = await runScanner(['--bogus']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown argument');
    });
  });

  // ---- 48h expiry calculation ----

  describe('expiry calculation', () => {
    it('should set expiresAt to 48h after createdAt', async () => {
      const before = new Date();
      const result = await runScanner(['--action', 'create-state', '--pr', '9001']);
      expect(result.exitCode).toBe(0);

      const data = JSON.parse(result.stdout);
      const created = new Date(data.createdAt);
      const expires = new Date(data.expiresAt);

      const diffMs = expires.getTime() - created.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      expect(diffHours).toBe(48);
      expect(created.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    });
  });
});
