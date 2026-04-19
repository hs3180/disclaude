/**
 * schedules/pr-scanner.test.ts
 *
 * Unit tests for PR Scanner v2 基础脚本骨架。
 * 覆盖所有 action + 状态文件读写 + Label 管理 + 边界情况。
 *
 * Related: #2219, #2220
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  actionAddLabel,
  actionRemoveLabel,
  addReviewingLabel,
  removeReviewingLabel,
  atomicWrite,
  calculateExpiresAt,
  stateFilePath,
  nowISO,
  getRepo,
  REVIEWING_LABEL,
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

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty array when dir does not exist', async () => {
    const states = await readAllStates('/nonexistent/dir');
    expect(states).toEqual([]);
  });

  it('returns empty array when dir is empty', async () => {
    const states = await readAllStates(TEST_DIR);
    expect(states).toEqual([]);
  });

  it('reads valid state files', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await writeStateFile(makeStateFile({ prNumber: 2 }));
    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(2);
    const numbers = states.map(s => s.prNumber).sort();
    expect(numbers).toEqual([1, 2]);
  });

  it('skips corrupted files', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    // Write a corrupted file
    const badFile = resolve(TEST_DIR, 'pr-999.json');
    await writeFile(badFile, 'not json{', 'utf-8');
    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(1);
    expect(states[0].prNumber).toBe(1);
  });

  it('ignores non-pr json files', async () => {
    await writeFile(resolve(TEST_DIR, 'other.json'), '{}', 'utf-8');
    const states = await readAllStates(TEST_DIR);
    expect(states).toEqual([]);
  });
});

describe('actionCheckCapacity', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
    process.env.PR_SCANNER_MAX_REVIEWING = '3';
  });

  afterEach(async () => {
    delete process.env.PR_SCANNER_DIR;
    delete process.env.PR_SCANNER_MAX_REVIEWING;
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('reports full capacity when empty', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionCheckCapacity();
    const output = spy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.reviewing).toBe(0);
    expect(parsed.maxConcurrent).toBe(3);
    expect(parsed.available).toBe(3);
    spy.mockRestore();
  });

  it('counts reviewing PRs', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 3, state: 'approved' }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionCheckCapacity();
    const output = spy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.reviewing).toBe(2);
    expect(parsed.available).toBe(1);
    spy.mockRestore();
  });

  it('reports 0 available when at max', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 3, state: 'reviewing' }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionCheckCapacity();
    const output = spy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.available).toBe(0);
    spy.mockRestore();
  });
});

describe('actionCreateState', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
  });

  afterEach(async () => {
    delete process.env.PR_SCANNER_DIR;
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a state file with reviewing state', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionCreateState(42);

    // Check console output
    const stateOutput = spy.mock.calls[0][0];
    const parsed = JSON.parse(stateOutput);
    expect(parsed.prNumber).toBe(42);
    expect(parsed.state).toBe('reviewing');
    expect(parsed.chatId).toBeNull();
    expect(parsed.disbandRequested).toBe(false);
    spy.mockRestore();

    // Check file on disk
    const filePath = stateFilePath(42);
    const content = await readFile(filePath, 'utf-8');
    const fileState = JSON.parse(content);
    expect(fileState.prNumber).toBe(42);
  });

  it('throws when state file already exists', async () => {
    await writeStateFile(makeStateFile({ prNumber: 42 }));
    await expect(actionCreateState(42)).rejects.toThrow('already exists');
  });

  it('creates directory if missing', async () => {
    const newDir = resolve(TEST_DIR, 'subdir');
    process.env.PR_SCANNER_DIR = newDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionCreateState(99);
    spy.mockRestore();

    const filePath = resolve(newDir, 'pr-99.json');
    const content = await readFile(filePath, 'utf-8');
    expect(JSON.parse(content).prNumber).toBe(99);
  });
});

describe('actionMark', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
  });

  afterEach(async () => {
    delete process.env.PR_SCANNER_DIR;
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('updates state from reviewing to approved', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionMark(1, 'approved');
    const output = spy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.state).toBe('approved');
    expect(parsed._previousState).toBe('reviewing');
    spy.mockRestore();

    // Verify file updated
    const content = await readFile(stateFilePath(1), 'utf-8');
    const fileState = JSON.parse(content);
    expect(fileState.state).toBe('approved');
  });

  it('updates state from reviewing to closed', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionMark(1, 'closed');
    spy.mockRestore();

    const content = await readFile(stateFilePath(1), 'utf-8');
    expect(JSON.parse(content).state).toBe('closed');
  });

  it('throws when state file not found', async () => {
    await expect(actionMark(999, 'approved')).rejects.toThrow('not found');
  });

  it('updates updatedAt timestamp', async () => {
    const original = makeStateFile({ prNumber: 1, state: 'reviewing' });
    original.updatedAt = '2026-01-01T00:00:00.000Z';
    await writeStateFile(original);

    await actionMark(1, 'approved');

    const content = await readFile(stateFilePath(1), 'utf-8');
    const updated = JSON.parse(content);
    expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('actionStatus', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
    process.env.PR_SCANNER_DIR = TEST_DIR;
  });

  afterEach(async () => {
    delete process.env.PR_SCANNER_DIR;
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('reports no tracked PRs', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionStatus();
    expect(spy.mock.calls[0][0]).toContain('No tracked PRs');
    spy.mockRestore();
  });

  it('groups PRs by state', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'approved' }));
    await writeStateFile(makeStateFile({ prNumber: 3, state: 'closed' }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await actionStatus();

    const jsonOutput = spy.mock.calls.find(c => c[0].includes('"total"'))?.[0];
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.total).toBe(3);
    expect(parsed.reviewing).toHaveLength(1);
    expect(parsed.approved).toHaveLength(1);
    expect(parsed.closed).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('Label Management', () => {
  describe('getRepo', () => {
    it('returns default repo', () => {
      delete process.env.PR_SCANNER_REPO;
      expect(getRepo()).toBe('hs3180/disclaude');
    });

    it('returns env override', () => {
      process.env.PR_SCANNER_REPO = 'owner/repo';
      expect(getRepo()).toBe('owner/repo');
      delete process.env.PR_SCANNER_REPO;
    });
  });

  describe('REVIEWING_LABEL constant', () => {
    it('has correct label name', () => {
      expect(REVIEWING_LABEL).toBe('pr-scanner:reviewing');
    });
  });

  describe('addReviewingLabel', () => {
    afterEach(() => {
      delete process.env.PR_SCANNER_REPO;
      vi.restoreAllMocks();
    });

    it('logs warning on gh not available (integration)', async () => {
      // In test env, gh is not available, so addReviewingLabel logs a warning
      // This effectively tests that the function calls gh with the right args
      // and handles failure gracefully
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await addReviewingLabel(999);
      // Should have logged a warning about gh failure
      const warnCalls = warnSpy.mock.calls.filter(c =>
        c[0].includes && c[0].includes('WARN')
      );
      expect(warnCalls.length).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });

    it('does not throw on gh failure', async () => {
      // addReviewingLabel should catch errors and log warnings
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // This will fail because gh is not available in test, but should not throw
      await expect(addReviewingLabel(999)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('removeReviewingLabel', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does not throw on gh failure', async () => {
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(removeReviewingLabel(999)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('actionAddLabel / actionRemoveLabel', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('actionAddLabel does not throw on failure', async () => {
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(actionAddLabel(999)).resolves.toBeUndefined();
      warnSpy.mockRestore();
    });

    it('actionRemoveLabel does not throw on failure', async () => {
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(actionRemoveLabel(999)).resolves.toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe('Label integration in actionCreateState', () => {
    beforeEach(async () => {
      await rm(TEST_DIR, { recursive: true, force: true });
      await mkdir(TEST_DIR, { recursive: true });
      process.env.PR_SCANNER_DIR = TEST_DIR;
    });

    afterEach(async () => {
      delete process.env.PR_SCANNER_DIR;
      await rm(TEST_DIR, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('creates state file even when label fails', async () => {
      // gh is not available in test env, so label will fail
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await actionCreateState(55);

      // State file should still be created
      const content = await readFile(stateFilePath(55), 'utf-8');
      const fileState = JSON.parse(content);
      expect(fileState.prNumber).toBe(55);
      expect(fileState.state).toBe('reviewing');

      // Warning should have been logged for label failure
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  describe('Label integration in actionMark', () => {
    beforeEach(async () => {
      await rm(TEST_DIR, { recursive: true, force: true });
      await mkdir(TEST_DIR, { recursive: true });
      process.env.PR_SCANNER_DIR = TEST_DIR;
    });

    afterEach(async () => {
      delete process.env.PR_SCANNER_DIR;
      await rm(TEST_DIR, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('attempts label removal when leaving reviewing state', async () => {
      await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));

      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await actionMark(1, 'approved');

      // State should be updated
      const content = await readFile(stateFilePath(1), 'utf-8');
      expect(JSON.parse(content).state).toBe('approved');

      // Warning for label removal failure (gh not available in test)
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('does not attempt label removal when staying in reviewing', async () => {
      await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));

      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await actionMark(1, 'reviewing');

      // State stays reviewing
      const content = await readFile(stateFilePath(1), 'utf-8');
      expect(JSON.parse(content).state).toBe('reviewing');

      // No label warning since we're not leaving reviewing
      // (only 1 call from the state update itself, no label call)
      const labelCalls = warnSpy.mock.calls.filter(c =>
        c[0].includes && c[0].includes('label')
      );
      expect(labelCalls).toHaveLength(0);

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('does not attempt label removal when not in reviewing', async () => {
      await writeStateFile(makeStateFile({ prNumber: 1, state: 'approved' }));

      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await actionMark(1, 'closed');

      const content = await readFile(stateFilePath(1), 'utf-8');
      expect(JSON.parse(content).state).toBe('closed');

      // No label removal attempted since old state wasn't reviewing
      const labelCalls = warnSpy.mock.calls.filter(c =>
        c[0].includes && c[0].includes('label')
      );
      expect(labelCalls).toHaveLength(0);

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});

describe('CLI integration', () => {
  it('shows help when no action provided', async () => {
    const { stdout, stderr } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts',
    ], { timeout: 30000 }).catch(e => e);
    // Should fail with usage message
    expect(stderr || stdout).toContain('Usage');
  });

  it('runs status action', async () => {
    process.env.PR_SCANNER_DIR = '/nonexistent/dir';
    const { stdout } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts',
      '--action', 'status',
    ], { timeout: 30000, env: { ...process.env } });
    expect(stdout).toContain('No tracked PRs');
    delete process.env.PR_SCANNER_DIR;
  });

  it('runs check-capacity action', async () => {
    process.env.PR_SCANNER_DIR = '/nonexistent/dir';
    const { stdout } = await execFileAsync('npx', [
      'tsx', 'schedules/pr-scanner.ts',
      '--action', 'check-capacity',
    ], { timeout: 30000, env: { ...process.env } });
    // Find the JSON object in output (may be multi-line)
    const startIdx = stdout.indexOf('{');
    const endIdx = stdout.lastIndexOf('}');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const jsonStr = stdout.substring(startIdx, endIdx + 1);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.reviewing).toBe(0);
    expect(parsed.available).toBeGreaterThan(0);
    delete process.env.PR_SCANNER_DIR;
  });
});
