/**
 * schedules/pr-scanner/scanner.test.ts
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
  DEFAULT_DIR,
  DEFAULT_MAX_REVIEWING,
  EXPIRY_HOURS,
  VALID_STATES,
  type PRStateFile,
  type PRState,
} from './scanner.js';

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
    disbandRequested: null,
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
    expect(result.disbandRequested).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseStateFile('not json{', 'test.json')).toThrow('not valid JSON');
  });

  it('rejects non-object JSON', () => {
    expect(() => parseStateFile('42', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('"string"', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('null', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
  });

  it('rejects missing prNumber', () => {
    const state = makeStateFile();
    delete (state as Record<string, unknown>).prNumber;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('prNumber');
  });

  it('rejects non-integer prNumber', () => {
    const state = makeStateFile({ prNumber: 1.5 });
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('prNumber');
  });

  it('rejects zero prNumber', () => {
    const state = makeStateFile({ prNumber: 0 });
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('prNumber');
  });

  it('rejects negative prNumber', () => {
    const state = makeStateFile({ prNumber: -1 });
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('prNumber');
  });

  it('rejects invalid state', () => {
    const state = makeStateFile();
    (state as Record<string, unknown>).state = 'invalid';
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid \'state\'');
  });

  it('rejects non-null disbandRequested', () => {
    const state = makeStateFile();
    (state as Record<string, unknown>).disbandRequested = true;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('disbandRequested');
  });

  it('rejects invalid timestamp format', () => {
    const state = makeStateFile();
    state.createdAt = '2026-04-07 10:00:00'; // wrong format
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('createdAt');
  });

  it('accepts all valid states', () => {
    for (const s of VALID_STATES) {
      const state = makeStateFile({ state: s });
      expect(() => parseStateFile(JSON.stringify(state), 'test.json')).not.toThrow();
    }
  });

  it('accepts chatId as string', () => {
    const state = makeStateFile({ chatId: 'oc_abc123' });
    expect(parseStateFile(JSON.stringify(state), 'test.json').chatId).toBe('oc_abc123');
  });
});

describe('calculateExpiresAt', () => {
  it('adds EXPIRY_HOURS to createdAt', () => {
    const createdAt = '2026-04-07T10:00:00Z';
    const expiresAt = calculateExpiresAt(createdAt);
    expect(expiresAt).toBe('2026-04-09T10:00:00Z'); // +48h
  });

  it('handles day boundaries', () => {
    const createdAt = '2026-04-07T20:00:00Z';
    const expiresAt = calculateExpiresAt(createdAt);
    expect(expiresAt).toBe('2026-04-09T20:00:00Z');
  });

  it('handles month boundaries', () => {
    const createdAt = '2026-04-30T10:00:00Z';
    const expiresAt = calculateExpiresAt(createdAt);
    expect(expiresAt).toBe('2026-05-02T10:00:00Z');
  });
});

describe('stateFilePath', () => {
  it('returns correct path with default dir', () => {
    const path = stateFilePath(123);
    expect(path).toContain(DEFAULT_DIR);
    expect(path).toContain('pr-123.json');
  });

  it('returns correct path with custom dir', () => {
    const path = stateFilePath(456, '/custom/dir');
    expect(path).toBe('/custom/dir/pr-456.json');
  });
});

describe('atomicWrite', () => {
  it('writes file atomically', async () => {
    const filePath = resolve(TEST_DIR, 'atomic-test.json');
    const data = '{"test": true}\n';
    await atomicWrite(filePath, data);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe(data);
  });
});

describe('readAllStates', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('returns empty array for non-existent directory', async () => {
    const states = await readAllStates('/non/existent/dir');
    expect(states).toEqual([]);
  });

  it('returns empty array for empty directory', async () => {
    const states = await readAllStates(TEST_DIR);
    expect(states).toEqual([]);
  });

  it('reads valid state files', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'approved' }));

    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(2);
    expect(states.map((s) => s.prNumber).sort()).toEqual([1, 2]);
  });

  it('skips non-matching files', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await writeFile(resolve(TEST_DIR, 'other.json'), '{}\n', 'utf-8');
    await writeFile(resolve(TEST_DIR, 'not-json.txt'), 'hello\n', 'utf-8');

    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(1);
    expect(states[0].prNumber).toBe(1);
  });

  it('skips corrupted state files', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await writeFile(resolve(TEST_DIR, 'pr-999.json'), 'not valid json\n', 'utf-8');

    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(1);
    expect(states[0].prNumber).toBe(1);
  });
});

describe('actionCheckCapacity', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('returns zero when no state files', async () => {
    const result = await actionCheckCapacity(TEST_DIR);
    expect(result).toEqual({
      reviewing: 0,
      maxConcurrent: DEFAULT_MAX_REVIEWING,
      available: DEFAULT_MAX_REVIEWING,
    });
  });

  it('counts reviewing states correctly', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 3, state: 'approved' }));

    const result = await actionCheckCapacity(TEST_DIR);
    expect(result.reviewing).toBe(2);
    expect(result.available).toBe(DEFAULT_MAX_REVIEWING - 2);
  });

  it('returns zero available when at capacity', async () => {
    for (let i = 1; i <= DEFAULT_MAX_REVIEWING; i++) {
      await writeStateFile(makeStateFile({ prNumber: i, state: 'reviewing' }));
    }
    await writeStateFile(makeStateFile({ prNumber: 99, state: 'approved' }));

    const result = await actionCheckCapacity(TEST_DIR);
    expect(result.reviewing).toBe(DEFAULT_MAX_REVIEWING);
    expect(result.available).toBe(0);
  });

  it('returns zero available when over capacity', async () => {
    for (let i = 1; i <= DEFAULT_MAX_REVIEWING + 2; i++) {
      await writeStateFile(makeStateFile({ prNumber: i, state: 'reviewing' }));
    }

    const result = await actionCheckCapacity(TEST_DIR);
    expect(result.available).toBe(0);
  });
});

describe('actionCreateState', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('creates a valid state file', async () => {
    const state = await actionCreateState(42, TEST_DIR);

    expect(state.prNumber).toBe(42);
    expect(state.state).toBe('reviewing');
    expect(state.chatId).toBeNull();
    expect(state.disbandRequested).toBeNull();

    // Verify file exists on disk
    const filePath = stateFilePath(42, TEST_DIR);
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.prNumber).toBe(42);
  });

  it('sets expiresAt to createdAt + 48h', async () => {
    const state = await actionCreateState(42, TEST_DIR);
    const expected = calculateExpiresAt(state.createdAt);
    expect(state.expiresAt).toBe(expected);
  });

  it('throws if state file already exists', async () => {
    await writeStateFile(makeStateFile({ prNumber: 42 }));
    await expect(actionCreateState(42, TEST_DIR)).rejects.toThrow('already exists');
  });

  it('can create multiple state files', async () => {
    await actionCreateState(1, TEST_DIR);
    await actionCreateState(2, TEST_DIR);
    await actionCreateState(3, TEST_DIR);

    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(3);
  });
});

describe('actionMark', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('updates state to approved', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    const updated = await actionMark(1, 'approved', TEST_DIR);
    expect(updated.state).toBe('approved');
    expect(updated.prNumber).toBe(1);
  });

  it('updates state to closed', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    const updated = await actionMark(1, 'closed', TEST_DIR);
    expect(updated.state).toBe('closed');
  });

  it('updates updatedAt timestamp', async () => {
    const original = makeStateFile({ prNumber: 1 });
    // Force a known updatedAt in the past
    original.updatedAt = '2026-01-01T00:00:00Z';
    await writeStateFile(original);

    const updated = await actionMark(1, 'approved', TEST_DIR);
    // updatedAt should be updated to a recent timestamp (different from original)
    expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00Z');
    // Verify it's a valid timestamp format
    expect(updated.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('throws if state file not found', async () => {
    await expect(actionMark(999, 'approved', TEST_DIR)).rejects.toThrow('not found');
  });

  it('throws for invalid state', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await expect(actionMark(1, 'invalid' as PRState, TEST_DIR)).rejects.toThrow('Invalid state');
  });

  it('persists changes to disk', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));
    await actionMark(1, 'approved', TEST_DIR);

    // Re-read from disk
    const states = await readAllStates(TEST_DIR);
    expect(states).toHaveLength(1);
    expect(states[0].state).toBe('approved');
  });

  it('can transition reviewing → approved → closed', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1 }));

    await actionMark(1, 'approved', TEST_DIR);
    let states = await readAllStates(TEST_DIR);
    expect(states[0].state).toBe('approved');

    await actionMark(1, 'closed', TEST_DIR);
    states = await readAllStates(TEST_DIR);
    expect(states[0].state).toBe('closed');
  });
});

describe('actionStatus', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('returns message when no tracked PRs', async () => {
    const result = await actionStatus(TEST_DIR);
    expect(result).toContain('No tracked PRs');
  });

  it('groups PRs by state', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(makeStateFile({ prNumber: 3, state: 'approved' }));
    await writeStateFile(makeStateFile({ prNumber: 4, state: 'closed' }));

    const result = await actionStatus(TEST_DIR);

    expect(result).toContain('4 total');
    expect(result).toContain('2 reviewing');
    expect(result).toContain('1 approved');
    expect(result).toContain('1 closed');
    expect(result).toContain('PR #1');
    expect(result).toContain('PR #2');
    expect(result).toContain('PR #3');
    expect(result).toContain('PR #4');
  });

  it('shows only states with PRs', async () => {
    await writeStateFile(makeStateFile({ prNumber: 1, state: 'reviewing' }));

    const result = await actionStatus(TEST_DIR);

    expect(result).toContain('REVIEWING');
    expect(result).not.toContain('APPROVED');
    expect(result).not.toContain('CLOSED');
  });
});

describe('nowISO', () => {
  it('returns UTC Z-suffix format', () => {
    const result = nowISO();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('constants', () => {
  it('DEFAULT_MAX_REVIEWING is 3', () => {
    expect(DEFAULT_MAX_REVIEWING).toBe(3);
  });

  it('EXPIRY_HOURS is 48', () => {
    expect(EXPIRY_HOURS).toBe(48);
  });

  it('VALID_STATES contains correct values', () => {
    expect(VALID_STATES).toEqual(['reviewing', 'approved', 'closed']);
  });
});
