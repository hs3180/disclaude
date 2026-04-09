/**
 * Unit tests for pr-scanner-lifecycle.ts — Discussion group lifecycle management.
 *
 * Tests all CLI actions (check-expired, mark-disband)
 * plus state file parsing, validation, and edge cases.
 * Does NOT depend on lark-cli or GitHub API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseStateFile,
  parseArgs,
  type PRStateFile,
  type PRState,
  DEFAULT_DISBAND_COOLDOWN_HOURS,
  UTC_DATETIME_REGEX,
} from '../pr-scanner-lifecycle.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-lifecycle-test');

// Helper to run the lifecycle script
async function runLifecycle(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/schedule/pr-scanner-lifecycle.ts');
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
  const expires = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago (expired)
  return {
    prNumber: 100,
    chatId: null,
    state: 'reviewing',
    createdAt: new Date(now.getTime() - 50 * 60 * 60 * 1000).toISOString(), // 50h ago
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

async function readStateFile(prNumber: number): Promise<PRStateFile> {
  const filePath = resolve(TEST_STATE_DIR, `pr-${prNumber}.json`);
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content);
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
  it('should parse a valid state file with null disbandRequested', () => {
    const data = createStateData();
    const json = JSON.stringify(data);
    const result = parseStateFile(json, 'test.json');
    expect(result.prNumber).toBe(100);
    expect(result.state).toBe('reviewing');
    expect(result.disbandRequested).toBeNull();
  });

  it('should parse a state file with string disbandRequested', () => {
    const data = createStateData({
      disbandRequested: '2026-04-09T10:00:00Z',
    });
    const result = parseStateFile(JSON.stringify(data), 'test.json');
    expect(result.disbandRequested).toBe('2026-04-09T10:00:00Z');
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
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow("invalid or missing 'prNumber'");
  });

  it('should reject invalid state', () => {
    const data = createStateData();
    (data as Record<string, unknown>).state = 'unknown';
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow("invalid 'state'");
  });

  it('should accept all valid states', () => {
    for (const state of ['reviewing', 'approved', 'closed'] as PRState[]) {
      const data = createStateData({ state });
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.state).toBe(state);
    }
  });

  it('should reject non-string disbandRequested', () => {
    const data = createStateData();
    (data as Record<string, unknown>).disbandRequested = 123;
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow("invalid 'disbandRequested'");
  });

  it('should reject invalid disbandRequested format', () => {
    const data = createStateData();
    (data as Record<string, unknown>).disbandRequested = '2026-04-09 10:00:00'; // missing T and Z
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow("invalid 'disbandRequested'");
  });

  it('should reject invalid createdAt format', () => {
    const data = createStateData();
    data.createdAt = '2026-04-07 10:00:00'; // missing T and Z
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow("invalid or missing 'createdAt'");
  });
});

// ---- parseArgs tests ----

describe('parseArgs', () => {
  it('should parse --action flag', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'check-expired']);
    expect(result.action).toBe('check-expired');
  });

  it('should parse positional action', () => {
    const result = parseArgs(['node', 'script.ts', 'check-expired']);
    expect(result.action).toBe('check-expired');
  });

  it('should parse --pr flag', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'mark-disband', '--pr', '123']);
    expect(result.action).toBe('mark-disband');
    expect(result.pr).toBe(123);
  });

  it('should default all values when no args', () => {
    const result = parseArgs(['node', 'script.ts']);
    expect(result.action).toBe('');
    expect(result.pr).toBeNull();
  });
});

// ---- Integration tests (run actual script) ----

describe('pr-scanner-lifecycle CLI', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ---- check-expired ----

  describe('check-expired', () => {
    it('should return empty array for empty directory', async () => {
      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should find expired reviewing PRs with needsDisband=true', async () => {
      await writeStateFile(createStateData({ prNumber: 1 }));

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(1);
      expect(output[0].prNumber).toBe(1);
      expect(output[0].state).toBe('reviewing');
      expect(output[0].needsDisband).toBe(true);
    });

    it('should not include non-expired PRs', async () => {
      const futureExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await writeStateFile(createStateData({ prNumber: 1, expiresAt: futureExpires }));

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should not include non-reviewing PRs', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'approved' }));
      await writeStateFile(createStateData({ prNumber: 2, state: 'closed' }));

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should respect disband cooldown', async () => {
      // PR with recent disbandRequested (within cooldown)
      const recentDisband = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
      await writeStateFile(createStateData({
        prNumber: 1,
        disbandRequested: recentDisband,
      }));

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(1);
      expect(output[0].needsDisband).toBe(false); // within 24h cooldown
    });

    it('should set needsDisband=true after cooldown elapses', async () => {
      // PR with old disbandRequested (beyond cooldown)
      const oldDisband = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
      await writeStateFile(createStateData({
        prNumber: 1,
        disbandRequested: oldDisband,
      }));

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(1);
      expect(output[0].needsDisband).toBe(true); // cooldown passed
    });

    it('should respect custom cooldown via env var', async () => {
      // PR with disbandRequested 2h ago, default cooldown 24h → needsDisband=false
      // But with LIFECYCLE_DISBAND_COOLDOWN_HOURS=1 → needsDisband=true
      const recentDisband = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await writeStateFile(createStateData({
        prNumber: 1,
        disbandRequested: recentDisband,
      }));

      const result = await runLifecycle(['check-expired'], {
        LIFECYCLE_DISBAND_COOLDOWN_HOURS: '1',
      });
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(1);
      expect(output[0].needsDisband).toBe(true);
    });

    it('should handle non-existent state directory', async () => {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('should skip corrupted files', async () => {
      await writeStateFile(createStateData({ prNumber: 1 }));
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-999.json'),
        'this is not valid json',
        'utf-8',
      );

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('WARN');

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(1);
      expect(output[0].prNumber).toBe(1);
    });

    it('should handle multiple expired PRs', async () => {
      await writeStateFile(createStateData({ prNumber: 1 }));
      await writeStateFile(createStateData({ prNumber: 2 }));
      // Non-expired PR
      const futureExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await writeStateFile(createStateData({ prNumber: 3, expiresAt: futureExpires }));

      const result = await runLifecycle(['check-expired']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(2);
      const prNumbers = output.map((e: { prNumber: number }) => e.prNumber).sort();
      expect(prNumbers).toEqual([1, 2]);
    });
  });

  // ---- mark-disband ----

  describe('mark-disband', () => {
    it('should set disbandRequested timestamp', async () => {
      await writeStateFile(createStateData({ prNumber: 42 }));

      const before = Date.now();
      const result = await runLifecycle(['mark-disband', '--pr', '42']);
      const after = Date.now();

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.prNumber).toBe(42);
      expect(output.disbandRequested).not.toBeNull();

      const disbandTime = new Date(output.disbandRequested).getTime();
      expect(disbandTime).toBeGreaterThanOrEqual(before);
      expect(disbandTime).toBeLessThanOrEqual(after);
    });

    it('should update updatedAt timestamp', async () => {
      const original = createStateData({ prNumber: 42 });
      original.updatedAt = '2020-01-01T00:00:00Z';
      await writeStateFile(original);

      const before = Date.now();
      const result = await runLifecycle(['mark-disband', '--pr', '42']);
      const after = Date.now();

      const output = JSON.parse(result.stdout);
      const updatedAt = new Date(output.updatedAt).getTime();
      expect(updatedAt).toBeGreaterThanOrEqual(before);
      expect(updatedAt).toBeLessThanOrEqual(after);
    });

    it('should persist the update to file', async () => {
      await writeStateFile(createStateData({ prNumber: 42 }));

      await runLifecycle(['mark-disband', '--pr', '42']);

      const fileData = await readStateFile(42);
      expect(fileData.disbandRequested).not.toBeNull();
      expect(fileData.disbandRequested).toMatch(UTC_DATETIME_REGEX);
    });

    it('should overwrite previous disbandRequested', async () => {
      const original = createStateData({
        prNumber: 42,
        disbandRequested: '2026-04-01T00:00:00Z',
      });
      await writeStateFile(original);

      const result = await runLifecycle(['mark-disband', '--pr', '42']);
      expect(result.code).toBe(0);

      const fileData = await readStateFile(42);
      // Should be a recent timestamp, not the old one
      expect(fileData.disbandRequested).not.toBe('2026-04-01T00:00:00Z');
    });

    it('should fail without --pr', async () => {
      const result = await runLifecycle(['mark-disband']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should fail for non-existent PR', async () => {
      const result = await runLifecycle(['mark-disband', '--pr', '999']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should fail for non-reviewing PR', async () => {
      await writeStateFile(createStateData({ prNumber: 42, state: 'approved' }));

      const result = await runLifecycle(['mark-disband', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("state is 'approved'");
      expect(result.stderr).toContain("expected 'reviewing'");
    });

    it('should fail for closed PR', async () => {
      await writeStateFile(createStateData({ prNumber: 42, state: 'closed' }));

      const result = await runLifecycle(['mark-disband', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("state is 'closed'");
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('should fail with unknown action', async () => {
      const result = await runLifecycle(['unknown-action']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown action');
    });

    it('should fail with no action', async () => {
      const result = await runLifecycle([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No action specified');
    });

    it('should fail with invalid --pr value', async () => {
      const result = await runLifecycle(['mark-disband', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid --pr');
    });
  });
});
