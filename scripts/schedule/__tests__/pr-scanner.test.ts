/**
 * Unit tests for pr-scanner.ts — PR Scanner v2 state management.
 *
 * Tests all CLI actions (check-capacity, create-state, mark, status)
 * plus state file parsing, validation, and edge cases.
 * Does NOT depend on GitHub API (list-candidates uses mock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseStateFile,
  parseArgs,
  type PRStateFile,
  type PRState,
  DEFAULT_MAX_REVIEWING,
  EXPIRY_HOURS,
} from '../pr-scanner.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-test');

// Helper to run the scanner script
async function runScanner(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/schedule/pr-scanner.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath, ...args], {
      env: {
        ...process.env,
        PR_SCANNER_STATE_DIR: TEST_STATE_DIR,
        ...env,
      },
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

function createStateData(overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = new Date();
  const expires = new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
  return {
    prNumber: 100,
    chatId: null,
    state: 'reviewing',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    disbandRequested: null,
    ...overrides,
  };
}

async function writeStateFile(data: PRStateFile): Promise<void> {
  const filePath = resolve(TEST_STATE_DIR, `pr-${data.prNumber}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function cleanupTestDir(): Promise<void> {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

// ---- parseStateFile tests ----

describe('parseStateFile', () => {
  it('should parse a valid state file', () => {
    const data = createStateData();
    const json = JSON.stringify(data);
    const result = parseStateFile(json, 'test.json');
    expect(result.prNumber).toBe(100);
    expect(result.state).toBe('reviewing');
    expect(result.chatId).toBeNull();
    expect(result.disbandRequested).toBeNull();
  });

  it('should parse a state file with chatId', () => {
    const data = createStateData({ chatId: 'oc_test123' });
    const result = parseStateFile(JSON.stringify(data), 'test.json');
    expect(result.chatId).toBe('oc_test123');
  });

  it('should reject invalid JSON', () => {
    expect(() => parseStateFile('not json', 'test.json')).toThrow('not valid JSON');
  });

  it('should reject non-object JSON', () => {
    expect(() => parseStateFile('"string"', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('null', 'test.json')).toThrow('not a valid JSON object');
  });

  it('should reject missing prNumber', () => {
    const data = createStateData();
    delete (data as Record<string, unknown>).prNumber;
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject non-integer prNumber', () => {
    const data = createStateData({ prNumber: 1.5 } as Partial<PRStateFile>);
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject zero prNumber', () => {
    const data = createStateData({ prNumber: 0 } as Partial<PRStateFile>);
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject negative prNumber', () => {
    const data = createStateData({ prNumber: -1 } as Partial<PRStateFile>);
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject invalid state', () => {
    const data = createStateData();
    (data as Record<string, unknown>).state = 'unknown';
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid \'state\'');
  });

  it('should reject non-null disbandRequested', () => {
    const data = createStateData();
    (data as Record<string, unknown>).disbandRequested = 'some-value';
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid \'disbandRequested\'');
  });

  it('should accept all valid states', () => {
    for (const state of ['reviewing', 'approved', 'closed'] as PRState[]) {
      const data = createStateData({ state });
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.state).toBe(state);
    }
  });

  it('should reject invalid createdAt format', () => {
    const data = createStateData();
    data.createdAt = '2026-04-07 10:00:00'; // missing T and Z
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'createdAt\'');
  });

  it('should reject non-string chatId', () => {
    const data = createStateData();
    (data as Record<string, unknown>).chatId = 123;
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid \'chatId\'');
  });
});

// ---- parseArgs tests ----

describe('parseArgs', () => {
  it('should parse --action flag', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'status']);
    expect(result.action).toBe('status');
  });

  it('should parse positional action', () => {
    const result = parseArgs(['node', 'script.ts', 'status']);
    expect(result.action).toBe('status');
  });

  it('should parse --pr and --state flags', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'mark', '--pr', '123', '--state', 'approved']);
    expect(result.action).toBe('mark');
    expect(result.pr).toBe(123);
    expect(result.state).toBe('approved');
  });

  it('should parse --chat-id flag', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'create-state', '--pr', '123', '--chat-id', 'oc_test']);
    expect(result.chatId).toBe('oc_test');
  });

  it('should default all values when no args', () => {
    const result = parseArgs(['node', 'script.ts']);
    expect(result.action).toBe('');
    expect(result.pr).toBeNull();
    expect(result.state).toBeNull();
    expect(result.chatId).toBeNull();
  });
});

// ---- Integration tests (run actual script) ----

describe('pr-scanner CLI', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ---- check-capacity ----

  describe('check-capacity', () => {
    it('should return default capacity for empty directory', async () => {
      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(0);
      expect(output.maxConcurrent).toBe(DEFAULT_MAX_REVIEWING);
      expect(output.available).toBe(DEFAULT_MAX_REVIEWING);
    });

    it('should count reviewing PRs correctly', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 2, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 3, state: 'approved' }));

      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(2);
      expect(output.available).toBe(1);
    });

    it('should respect PR_SCANNER_MAX_REVIEWING env var', async () => {
      const result = await runScanner(['check-capacity'], {
        PR_SCANNER_MAX_REVIEWING: '5',
      });
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.maxConcurrent).toBe(5);
      expect(output.available).toBe(5);
    });

    it('should report 0 available when at capacity', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 2, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 3, state: 'reviewing' }));

      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(3);
      expect(output.available).toBe(0);
    });

    it('should handle non-existent state directory', async () => {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });

      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(0);
    });
  });

  // ---- create-state ----

  describe('create-state', () => {
    it('should create a state file for a PR', async () => {
      const result = await runScanner(['create-state', '--pr', '42']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.prNumber).toBe(42);
      expect(output.state).toBe('reviewing');
      expect(output.chatId).toBeNull();
      expect(output.disbandRequested).toBeNull();

      // Verify file was written
      const filePath = resolve(TEST_STATE_DIR, 'pr-42.json');
      const fileContent = await readFile(filePath, 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.prNumber).toBe(42);
    });

    it('should create a state file with chatId', async () => {
      const result = await runScanner(['create-state', '--pr', '42', '--chat-id', 'oc_abc123']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.chatId).toBe('oc_abc123');
    });

    it('should set expiry to 48h from now', async () => {
      const before = Date.now();
      const result = await runScanner(['create-state', '--pr', '42']);
      const after = Date.now();

      const output = JSON.parse(result.stdout);
      const createdAt = new Date(output.createdAt).getTime();
      const expiresAt = new Date(output.expiresAt).getTime();

      const expectedExpiry = createdAt + EXPIRY_HOURS * 60 * 60 * 1000;
      expect(expiresAt).toBeCloseTo(expectedExpiry, -3); // within 1 second tolerance
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);
    });

    it('should fail without --pr', async () => {
      const result = await runScanner(['create-state']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should fail if state file already exists', async () => {
      await writeStateFile(createStateData({ prNumber: 42 }));

      const result = await runScanner(['create-state', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should create state directory if it does not exist', async () => {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });

      const result = await runScanner(['create-state', '--pr', '42']);
      expect(result.code).toBe(0);

      const dirStat = await stat(TEST_STATE_DIR);
      expect(dirStat.isDirectory()).toBe(true);
    });
  });

  // ---- mark ----

  describe('mark', () => {
    it('should update state from reviewing to approved', async () => {
      await writeStateFile(createStateData({ prNumber: 42, state: 'reviewing' }));

      const result = await runScanner(['mark', '--pr', '42', '--state', 'approved']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.state).toBe('approved');
      expect(output.prNumber).toBe(42);
    });

    it('should update state from reviewing to closed', async () => {
      await writeStateFile(createStateData({ prNumber: 42, state: 'reviewing' }));

      const result = await runScanner(['mark', '--pr', '42', '--state', 'closed']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.state).toBe('closed');
    });

    it('should update updatedAt timestamp', async () => {
      const original = createStateData({ prNumber: 42, state: 'reviewing' });
      original.updatedAt = '2020-01-01T00:00:00Z';
      await writeStateFile(original);

      const before = Date.now();
      const result = await runScanner(['mark', '--pr', '42', '--state', 'approved']);
      const after = Date.now();

      const output = JSON.parse(result.stdout);
      const updatedAt = new Date(output.updatedAt).getTime();
      expect(updatedAt).toBeGreaterThanOrEqual(before);
      expect(updatedAt).toBeLessThanOrEqual(after);
    });

    it('should persist the update to file', async () => {
      await writeStateFile(createStateData({ prNumber: 42, state: 'reviewing' }));

      await runScanner(['mark', '--pr', '42', '--state', 'approved']);

      const filePath = resolve(TEST_STATE_DIR, 'pr-42.json');
      const fileContent = await readFile(filePath, 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.state).toBe('approved');
    });

    it('should fail without --pr', async () => {
      const result = await runScanner(['mark', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should fail without --state', async () => {
      await writeStateFile(createStateData({ prNumber: 42 }));
      const result = await runScanner(['mark', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--state is required');
    });

    it('should fail for non-existent PR', async () => {
      const result = await runScanner(['mark', '--pr', '999', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should fail for invalid state value', async () => {
      const result = await runScanner(['mark', '--pr', '42', '--state', 'unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid --state');
    });
  });

  // ---- status ----

  describe('status', () => {
    it('should show "No tracked PRs" for empty directory', async () => {
      const result = await runScanner(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('should list PRs grouped by state', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 2, state: 'approved' }));
      await writeStateFile(createStateData({ prNumber: 3, state: 'closed' }));

      const result = await runScanner(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Total tracked: 3');
      expect(result.stdout).toContain('PR #1');
      expect(result.stdout).toContain('PR #2');
      expect(result.stdout).toContain('PR #3');
      expect(result.stdout).toContain('reviewing (1)');
      expect(result.stdout).toContain('approved (1)');
      expect(result.stdout).toContain('closed (1)');
    });

    it('should handle empty state groups', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));

      const result = await runScanner(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('reviewing (1)');
      expect(result.stdout).toContain('approved (0)');
      expect(result.stdout).toContain('closed (0)');
    });

    it('should sort PRs by updatedAt within groups', async () => {
      const now = Date.now();
      await writeStateFile(createStateData({
        prNumber: 1,
        state: 'reviewing',
        updatedAt: new Date(now - 1000).toISOString(),
      }));
      await writeStateFile(createStateData({
        prNumber: 2,
        state: 'reviewing',
        updatedAt: new Date(now).toISOString(),
      }));

      const result = await runScanner(['status']);
      expect(result.code).toBe(0);
      // PR #2 (most recent) should appear first
      const idx1 = result.stdout.indexOf('PR #1');
      const idx2 = result.stdout.indexOf('PR #2');
      expect(idx2).toBeLessThan(idx1);
    });
  });

  // ---- Corrupted files handling ----

  describe('corrupted files', () => {
    it('should skip corrupted files during check-capacity', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-999.json'),
        'this is not valid json',
        'utf-8',
      );

      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('WARN');

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(1);
    });

    it('should skip corrupted files during status', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-bad.json'),
        'not json',
        'utf-8',
      );

      const result = await runScanner(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Total tracked: 1');
      expect(result.stderr).toContain('WARN');
    });
  });

  // ---- Error cases ----

  describe('error handling', () => {
    it('should fail with unknown action', async () => {
      const result = await runScanner(['unknown-action']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown action');
    });

    it('should fail with no action', async () => {
      const result = await runScanner([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No action specified');
    });

    it('should fail with invalid --pr value', async () => {
      const result = await runScanner(['create-state', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid --pr');
    });

    it('should fail with zero --pr value', async () => {
      const result = await runScanner(['create-state', '--pr', '0']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid --pr');
    });
  });
});
