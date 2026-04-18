/**
 * schedules/pr-scanner.test.ts
 *
 * Unit tests for PR Scanner v2 基础脚本骨架。
 * 覆盖所有 action + 状态文件读写 + 边界情况。
 *
 * Related: #2219
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  parseStateFile,
  readAllStates,
  actionCheckCapacity,
  actionCreateState,
  actionMark,
  actionStatus,
  atomicWrite,
  calculateExpiresAt,
  stateFilePath,
  nowISO,
  type PRStateFile,
  type PRState,
  DEFAULT_DIR,
  DEFAULT_MAX_REVIEWING,
  EXPIRY_HOURS,
  VALID_STATES,
} from './pr-scanner.js';

const execFileAsync = promisify(execFile);

// ---- Test helpers ----

const TEST_DIR = resolve('.temp-chats-test-scanner');

function makeStateFile(overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = nowISO();
  return {
    prNumber: 1,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: calculateExpiresAt(now),
    disbandRequested: false,
    ...overrides,
  };
}

async function writeStateFile(state: PRStateFile): Promise<void> {
  const filePath = resolve(TEST_DIR, `pr-${state.prNumber}.json`);
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ---- Tests ----

describe('parseStateFile', () => {
  it('parses a valid state file', () => {
    const state = makeStateFile({ prNumber: 42 });
    const json = JSON.stringify(state);
    const result = parseStateFile(json, 'test.json');
    expect(result.prNumber).toBe(42);
    expect(result.state).toBe('reviewing');
    expect(result.chatId).toBeNull();
    expect(result.disbandRequested).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseStateFile('not json{', 'test.json')).toThrow('not valid JSON');
  });

  it('rejects non-object JSON', () => {
    expect(() => parseStateFile('42', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('"string"', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
  });

  it('rejects missing prNumber', () => {
    const state = makeStateFile();
    delete (state as Record<string, unknown>).prNumber;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('rejects non-integer prNumber', () => {
    const state = makeStateFile({ prNumber: 1.5 });
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('rejects negative prNumber', () => {
    const state = makeStateFile({ prNumber: -1 });
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('rejects invalid state', () => {
    const state = makeStateFile();
    (state as Record<string, unknown>).state = 'rejected';
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid \'state\'');
  });

  it('rejects invalid chatId', () => {
    const state = makeStateFile();
    (state as Record<string, unknown>).chatId = 123;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid \'chatId\'');
  });

  it('accepts string chatId', () => {
    const state = makeStateFile({ chatId: 'oc_abc123' });
    const result = parseStateFile(JSON.stringify(state), 'test.json');
    expect(result.chatId).toBe('oc_abc123');
  });

  it('rejects missing disbandRequested', () => {
    const state = makeStateFile();
    delete (state as Record<string, unknown>).disbandRequested;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid or missing \'disbandRequested\'');
  });

  it('rejects missing createdAt', () => {
    const state = makeStateFile();
    delete (state as Record<string, unknown>).createdAt;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid or missing \'createdAt\'');
  });

  it('rejects missing expiresAt', () => {
    const state = makeStateFile();
    delete (state as Record<string, unknown>).expiresAt;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid or missing \'expiresAt\'');
  });

  it('accepts all valid states', () => {
    for (const s of VALID_STATES) {
      const state = makeStateFile({ state: s as PRState });
      const result = parseStateFile(JSON.stringify(state), 'test.json');
      expect(result.state).toBe(s);
    }
  });
});

describe('calculateExpiresAt', () => {
  it('returns correct expiry time', () => {
    const created = '2026-04-18T10:00:00.000Z';
    const expires = calculateExpiresAt(created);
    const expected = new Date(created);
    expected.setTime(expected.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
    expect(expires).toBe(expected.toISOString());
  });

  it('expiresAt is 48 hours after createdAt', () => {
    const now = nowISO();
    const expires = calculateExpiresAt(now);
    const diffMs = new Date(expires).getTime() - new Date(now).getTime();
    const diffHours = diffMs / (100 * 0 * 1000);
    // Allow 1 second tolerance
    expect(Math.abs(diffMs - EXPIRY_HOURS * 60 * 60 * 1000)).toBeLessThan(1000);
  });
});

describe('atomicWrite', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  it('writes file content atomically', async () => {
    const filePath = resolve(TEST_DIR, 'test-atomic.json');
    await mkdir(TEST_DIR, { recursive: true });
    await atomicWrite(filePath, '{"test": true}\n');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('{"test": true}\n');
  });

  it('overwrites existing file', async () => {
    const filePath = resolve(TEST_DIR, 'test-atomic-overwrite.json');
    await mkdir(TEST_DIR, { recursive: true });
    await atomicWrite(filePath, '{"v": 1}\n');
    await atomicWrite(filePath, '{"v": 2}\n');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('{"v": 2}\n');
  });
});

describe('readAllStates', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  it('returns empty array for empty directory', async () => {
    const states = await readAllStates(TEST_DIR);
    expect(states).toEqual([]);
  });

  it('returns empty array for non-existent directory', async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    const states = await readAllStates(TEST_DIR);
    expect(states).toEqual([]);
  });

  it('reads all valid state files', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'approved' }));
    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(2);
    const numbers = states.map(s => s.prNumber).sort();
    expect(numbers).toEqual([1, 2]);
  });

  it('skips corrupted files and logs warning', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await writeFile(resolve(TEST_DIR, 'pr-999.json'), 'not valid json', 'utf-8');
    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(1);
    expect(states[0].prNumber).toBe(1);
  });

  it('ignores non-pr-*.json files', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await writeFile(resolve(TEST_DIR, 'other.json'), '{}', 'utf-8');
    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(1);
  });
});

describe('actionCheckCapacity', () => {
  const origDir = process.env.PR_SCANNER_DIR;

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
  });

  afterEach(() => {
    process.env.PR_SCANNER_DIR = origDir;
  });

  it('returns zero when no states exist', async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    // Capture stdout
    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionCheckCapacity();

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.reviewing).toBe(0);
    expect(result.maxConcurrent).toBe(DEFAULT_MAX_REVIEWING);
    expect(result.available).toBe(DEFAULT_MAX_REVIEWING);
  });

  it('counts reviewing PRs correctly', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 3, state: 'approved' }));

    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionCheckCapacity();

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.reviewing).toBe(2);
    expect(result.available).toBe(DEFAULT_MAX_REVIEWING - 2);
  });

  it('respects PR_SCANNER_MAX_REVIEWING env var', async () => {
    process.env.PR_SCANNER_MAX_REVIEWING = '5';

    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionCheckCapacity();

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.maxConcurrent).toBe(5);

    delete process.env.PR_SCANNER_MAX_REVIEWING;
  });
});

describe('actionCreateState', () => {
  const origDir = process.env.PR_SCANNER_DIR;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
  });

  afterEach(() => {
    process.env.PR_SCANNER_DIR = origDir;
  });

  it('creates a new state file', async () => {
    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionCreateState(42);

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.prNumber).toBe(42);
    expect(result.state).toBe('reviewing');
    expect(result.chatId).toBeNull();
    expect(result.disbandRequested).toBe(false);
    expect(result.expiresAt).toBeDefined();

    // Verify file exists on disk
    const filePath = resolve(TEST_DIR, 'pr-42.json');
    const content = await readFile(filePath, 'utf-8');
    const disk = JSON.parse(content);
    expect(disk.prNumber).toBe(42);
  });

  it('throws when state file already exists', async () => {
    await writeStateFile(makeStateFile({ prNumber: 42 }));
    await expect(actionCreateState(42)).rejects.toThrow('already exists');
  });

  it('creates .temp-chats directory if it does not exist', async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;

    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionCreateState(1);

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.prNumber).toBe(1);

    // Verify directory was created
    const files = await readdir(TEST_DIR);
    expect(files).toContain('pr-1.json');
  });
});

describe('actionMark', () => {
  const origDir = process.env.PR_SCANNER_DIR;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
  });

  afterEach(() => {
    process.env.PR_SCANNER_DIR = origDir;
  });

  it('updates state from reviewing to approved', async () => {
    await writeStateFile(makeStateFile({ prNumber: 42, state: 'reviewing' }));

    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionMark(42, 'approved');

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.state).toBe('approved');
    expect(result._previousState).toBe('reviewing');
    expect(result.prNumber).toBe(42);

    // Verify on disk
    const filePath = resolve(TEST_DIR, 'pr-42.json');
    const disk = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(disk.state).toBe('approved');
  });

  it('updates state from reviewing to closed', async () => {
    await writeStateFile(makeStateFile({ prNumber: 10, state: 'reviewing' }));

    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionMark(10, 'closed');

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.state).toBe('closed');
    expect(result._previousState).toBe('reviewing');
  });

  it('updates updatedAt timestamp', async () => {
    const state = makeStateFile({ prNumber: 5, state: 'reviewing' });
    const oldUpdatedAt = state.updatedAt;
    await writeStateFile(state);

    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));

    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionMark(5, 'approved');

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.updatedAt).not.toBe(oldUpdatedAt);
  });

  it('throws when state file not found', async () => {
    await expect(actionMark(999, 'approved')).rejects.toThrow('not found');
  });

  it('preserves other fields when updating state', async () => {
    const state = makeStateFile({
      prNumber: 7,
      chatId: 'oc_test123',
      disbandRequested: false,
    });
    await writeStateFile(state);

    const origLog = console.log;
    let output = '';
    console.log = (msg: string) => { output += msg; };

    await actionMark(7, 'approved');

    console.log = origLog;
    const result = JSON.parse(output);
    expect(result.chatId).toBe('oc_test123');
    expect(result.disbandRequested).toBe(false);
    expect(result.prNumber).toBe(7);
  });
});

describe('actionStatus', () => {
  const origDir = process.env.PR_SCANNER_DIR;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
  });

  afterEach(() => {
    process.env.PR_SCANNER_DIR = origDir;
  });

  it('shows empty status when no PRs tracked', async () => {
    const origLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => { outputs.push(msg); };

    await actionStatus();

    console.log = origLog;
    expect(outputs.some(o => o.includes('No tracked PRs'))).toBe(true);
  });

  it('groups PRs by state', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 3, state: 'approved' }));
    await writeStateFile(makeStateFile({ prNumber: 4, state: 'closed' }));

    const origLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => { outputs.push(msg); };

    await actionStatus();

    console.log = origLog;

    // Check human-readable output
    expect(outputs.some(o => o.includes('Reviewing: 2'))).toBe(true);
    expect(outputs.some(o => o.includes('Approved: 1'))).toBe(true);
    expect(outputs.some(o => o.includes('Closed: 1'))).toBe(true);

    // Check JSON output
    const jsonOutput = outputs.find(o => o.trim().startsWith('{'));
    expect(jsonOutput).toBeDefined();
    const summary = JSON.parse(jsonOutput!);
    expect(summary.total).toBe(4);
    expect(summary.reviewing).toHaveLength(2);
    expect(summary.approved).toHaveLength(1);
    expect(summary.closed).toHaveLength(1);
  });
});

describe('CLI integration', () => {
  const origDir = process.env.PR_SCANNER_DIR;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env.PR_SCANNER_DIR = origDir;
  });

  it('status command works via CLI', async () => {
    const { stdout } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts', '--action', 'status',
    ], {
      cwd: resolve('.'),
      timeout: 30000,
      env: { ...process.env, PR_SCANNER_DIR: TEST_DIR },
    });
    expect(stdout).toContain('No tracked PRs');
  });

  it('create-state + status + mark workflow via CLI', async () => {
    // Create state
    const { stdout: createOut } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts', '--action', 'create-state', '--pr', '100',
    ], {
      cwd: resolve('.'),
      timeout: 30000,
      env: { ...process.env, PR_SCANNER_DIR: TEST_DIR },
    });
    const created = JSON.parse(createOut);
    expect(created.prNumber).toBe(100);
    expect(created.state).toBe('reviewing');

    // Check status
    const { stdout: statusOut } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts', '--action', 'status',
    ], {
      cwd: resolve('.'),
      timeout: 30000,
      env: { ...process.env, PR_SCANNER_DIR: TEST_DIR },
    });
    expect(statusOut).toContain('PR #100');

    // Mark as approved
    const { stdout: markOut } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts', '--action', 'mark', '--pr', '100', '--state', 'approved',
    ], {
      cwd: resolve('.'),
      timeout: 30000,
      env: { ...process.env, PR_SCANNER_DIR: TEST_DIR },
    });
    const marked = JSON.parse(markOut);
    expect(marked.state).toBe('approved');
    expect(marked._previousState).toBe('reviewing');
  });

  it('check-capacity works via CLI', async () => {
    await writeStateFile(makeStateFile({ prNumber: 50, state: 'reviewing' }));

    const { stdout } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts', '--action', 'check-capacity',
    ], {
      cwd: resolve('.'),
      timeout: 30000,
      env: { ...process.env, PR_SCANNER_DIR: TEST_DIR },
    });
    const result = JSON.parse(stdout);
    expect(result.reviewing).toBe(1);
    expect(result.maxConcurrent).toBe(3);
    expect(result.available).toBe(2);
  });

  it('rejects invalid state via CLI', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));

    try {
      await execFileAsync('npx', [
        'tsx', 'schedules/pr-scanner.ts', '--action', 'mark', '--pr', '1', '--state', 'rejected',
      ], {
        cwd: resolve('.'),
        timeout: 30000,
        env: { ...process.env, PR_SCANNER_DIR: TEST_DIR },
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const e = err as { stderr?: string };
      expect(e.stderr).toContain("Invalid state 'rejected'");
    }
  });
});
