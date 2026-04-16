/**
 * Unit tests for PR Scanner CLI script.
 *
 * Issue #2219: All actions + state file read/write + edge cases.
 * These tests are fully offline — no GitHub API calls needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseStateFile,
  createPRStateObject,
  getStateFilePath,
  ensureStateDir,
  writeStateFile,
  readStateFile,
  readAllStateFiles,
  checkCapacity,
  createPRState,
  markPRState,
  getStatus,
  formatStatusText,
  filterCandidates,
  type PRStateFile,
  type PRInfo,
} from './scanner.js';

// ---- Test helpers ----

let tempDir: string;

async function createTempDir(): Promise<string> {
  const dir = join('/tmp', `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeStateFile(
  overrides: Partial<PRStateFile> & { prNumber: number },
): PRStateFile {
  const now = new Date();
  return {
    prNumber: overrides.prNumber,
    chatId: overrides.chatId ?? 'oc_test',
    state: overrides.state ?? 'reviewing',
    createdAt: overrides.createdAt ?? now.toISOString(),
    updatedAt: overrides.updatedAt ?? now.toISOString(),
    expiresAt:
      overrides.expiresAt ??
      new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
    disbandRequested: null,
  };
}

// ---- Tests ----

describe('parseStateFile', () => {
  it('should parse a valid state file', () => {
    const valid = JSON.stringify({
      prNumber: 123,
      chatId: 'oc_xxx',
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });
    const result = parseStateFile(valid);
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(123);
    expect(result!.state).toBe('reviewing');
  });

  it('should reject invalid JSON', () => {
    expect(parseStateFile('not json')).toBeNull();
  });

  it('should reject missing required fields', () => {
    expect(parseStateFile('{}')).toBeNull();
  });

  it('should reject invalid state value', () => {
    const invalid = JSON.stringify({
      prNumber: 1,
      chatId: 'oc_x',
      state: 'invalid_state',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: null,
    });
    expect(parseStateFile(invalid)).toBeNull();
  });

  it('should reject non-null disbandRequested', () => {
    const invalid = JSON.stringify({
      prNumber: 1,
      chatId: 'oc_x',
      state: 'reviewing',
      createdAt: '2026-04-07T10:00:00Z',
      updatedAt: '2026-04-07T10:00:00Z',
      expiresAt: '2026-04-09T10:00:00Z',
      disbandRequested: 'something',
    });
    expect(parseStateFile(invalid)).toBeNull();
  });

  it('should accept all valid states', () => {
    for (const state of ['reviewing', 'approved', 'closed']) {
      const json = JSON.stringify({
        prNumber: 1,
        chatId: 'oc_x',
        state,
        createdAt: '2026-04-07T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-09T10:00:00Z',
        disbandRequested: null,
      });
      expect(parseStateFile(json)).not.toBeNull();
    }
  });
});

describe('createPRStateObject', () => {
  it('should create a valid state with reviewing', () => {
    const fixedDate = new Date('2026-04-07T10:00:00Z');
    const state = createPRStateObject(42, 'oc_test', fixedDate);
    expect(state.prNumber).toBe(42);
    expect(state.chatId).toBe('oc_test');
    expect(state.state).toBe('reviewing');
    expect(state.createdAt).toBe('2026-04-07T10:00:00.000Z');
    expect(state.updatedAt).toBe('2026-04-07T10:00:00.000Z');
    expect(state.disbandRequested).toBeNull();
  });

  it('should set expiresAt to 48 hours after creation', () => {
    const fixedDate = new Date('2026-04-07T10:00:00Z');
    const state = createPRStateObject(1, 'oc_x', fixedDate);
    const expectedExpiry = new Date('2026-04-09T10:00:00.000Z');
    expect(state.expiresAt).toBe(expectedExpiry.toISOString());
  });
});

describe('getStateFilePath', () => {
  it('should return correct path', () => {
    expect(getStateFilePath('/data/.temp-chats', 123)).toBe(
      '/data/.temp-chats/pr-123.json',
    );
  });
});

describe('file I/O operations', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('ensureStateDir should create directory', async () => {
    const dir = join(tempDir, 'nested', 'state');
    await ensureStateDir(dir);
    const files = await readdir(join(tempDir, 'nested'));
    expect(files).toContain('state');
  });

  it('writeStateFile + readStateFile roundtrip', async () => {
    const state = makeStateFile({ prNumber: 99 });
    await writeStateFile(tempDir, state);
    const loaded = await readStateFile(tempDir, 99);
    expect(loaded).not.toBeNull();
    expect(loaded!.prNumber).toBe(99);
    expect(loaded!.state).toBe('reviewing');
  });

  it('readStateFile returns null for non-existent file', async () => {
    const result = await readStateFile(tempDir, 999);
    expect(result).toBeNull();
  });

  it('readStateFile returns null for corrupted file', async () => {
    await writeFile(join(tempDir, 'pr-500.json'), 'corrupted{}', 'utf-8');
    const result = await readStateFile(tempDir, 500);
    expect(result).toBeNull();
  });

  it('readAllStateFiles skips corrupted files', async () => {
    const validState = makeStateFile({ prNumber: 1 });
    await writeStateFile(tempDir, validState);
    await writeFile(join(tempDir, 'pr-2.json'), 'invalid', 'utf-8');
    await writeFile(join(tempDir, 'other.txt'), 'not a pr file', 'utf-8');

    const all = await readAllStateFiles(tempDir);
    expect(all).toHaveLength(1);
    expect(all[0].prNumber).toBe(1);
  });

  it('readAllStateFiles returns empty array for empty directory', async () => {
    const all = await readAllStateFiles(tempDir);
    expect(all).toEqual([]);
  });

  it('readAllStateFiles returns empty array for non-existent directory', async () => {
    const all = await readAllStateFiles(join(tempDir, 'no-such-dir'));
    expect(all).toEqual([]);
  });
});

describe('checkCapacity', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return correct capacity with no reviewing PRs', async () => {
    const result = await checkCapacity(tempDir, 3);
    expect(result).toEqual({ reviewing: 0, maxConcurrent: 3, available: 3 });
  });

  it('should count reviewing PRs correctly', async () => {
    await writeStateFile(tempDir, makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 3, state: 'approved' }));

    const result = await checkCapacity(tempDir, 3);
    expect(result.reviewing).toBe(2);
    expect(result.available).toBe(1);
  });

  it('should not go below 0 available', async () => {
    await writeStateFile(tempDir, makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 3, state: 'reviewing' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 4, state: 'reviewing' }));

    const result = await checkCapacity(tempDir, 3);
    expect(result.available).toBe(0);
  });

  it('should respect custom maxConcurrent from env', async () => {
    const result = await checkCapacity(tempDir, 5);
    expect(result.maxConcurrent).toBe(5);
    expect(result.available).toBe(5);
  });
});

describe('createPRState', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create a new state file', async () => {
    const state = await createPRState(tempDir, 42, 'oc_chat123');
    expect(state.prNumber).toBe(42);
    expect(state.chatId).toBe('oc_chat123');
    expect(state.state).toBe('reviewing');

    // Verify persisted
    const loaded = await readStateFile(tempDir, 42);
    expect(loaded).not.toBeNull();
    expect(loaded!.chatId).toBe('oc_chat123');
  });

  it('should throw if state file already exists', async () => {
    await createPRState(tempDir, 10, 'oc_first');
    await expect(createPRState(tempDir, 10, 'oc_second')).rejects.toThrow(
      'State file already exists for PR #10',
    );
  });

  it('should create directory if it does not exist', async () => {
    const nestedDir = join(tempDir, 'sub', 'dir');
    const state = await createPRState(nestedDir, 1, 'oc_x');
    expect(state.prNumber).toBe(1);
  });
});

describe('markPRState', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should update state from reviewing to approved', async () => {
    await createPRState(tempDir, 10, 'oc_chat');
    const updated = await markPRState(tempDir, 10, 'approved');
    expect(updated.state).toBe('approved');
    expect(updated.prNumber).toBe(10);
    expect(updated.chatId).toBe('oc_chat');
  });

  it('should update state from reviewing to closed', async () => {
    await createPRState(tempDir, 10, 'oc_chat');
    const updated = await markPRState(tempDir, 10, 'closed');
    expect(updated.state).toBe('closed');
  });

  it('should throw for invalid state', async () => {
    await createPRState(tempDir, 10, 'oc_chat');
    await expect(
      markPRState(tempDir, 10, 'invalid' as 'reviewing'),
    ).rejects.toThrow('Invalid state "invalid"');
  });

  it('should throw for non-existent PR', async () => {
    await expect(markPRState(tempDir, 999, 'approved')).rejects.toThrow(
      'No state file found for PR #999',
    );
  });

  it('should update updatedAt timestamp', async () => {
    const original = await createPRState(tempDir, 10, 'oc_chat');
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const updated = await markPRState(tempDir, 10, 'approved');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(original.updatedAt).getTime(),
    );
  });
});

describe('getStatus', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should group PRs by state', async () => {
    await writeStateFile(tempDir, makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 3, state: 'approved' }));
    await writeStateFile(tempDir, makeStateFile({ prNumber: 4, state: 'closed' }));

    const status = await getStatus(tempDir);
    expect(status.reviewing).toHaveLength(2);
    expect(status.approved).toHaveLength(1);
    expect(status.closed).toHaveLength(1);
  });

  it('should return empty arrays for empty directory', async () => {
    const status = await getStatus(tempDir);
    expect(status.reviewing).toEqual([]);
    expect(status.approved).toEqual([]);
    expect(status.closed).toEqual([]);
  });
});

describe('formatStatusText', () => {
  it('should show empty message when no PRs', () => {
    const text = formatStatusText({
      reviewing: [],
      approved: [],
      closed: [],
    });
    expect(text).toBe('No tracked PRs found.');
  });

  it('should format reviewing PRs', () => {
    const text = formatStatusText({
      reviewing: [makeStateFile({ prNumber: 1 })],
      approved: [],
      closed: [],
    });
    expect(text).toContain('PR Scanner Status (1 tracked)');
    expect(text).toContain('📋 Reviewing:');
    expect(text).toContain('PR #1');
  });

  it('should format all state groups', () => {
    const text = formatStatusText({
      reviewing: [makeStateFile({ prNumber: 1 })],
      approved: [makeStateFile({ prNumber: 2, state: 'approved' })],
      closed: [makeStateFile({ prNumber: 3, state: 'closed' })],
    });
    expect(text).toContain('📋 Reviewing:');
    expect(text).toContain('✅ Approved:');
    expect(text).toContain('❌ Closed:');
  });
});

describe('filterCandidates', () => {
  const openPRs: PRInfo[] = [
    { number: 1, title: 'PR 1', labels: [] },
    { number: 2, title: 'PR 2', labels: [] },
    { number: 3, title: 'PR 3', labels: [] },
    { number: 4, title: 'PR 4', labels: [] },
  ];

  it('should return all PRs when no states exist', () => {
    const candidates = filterCandidates(openPRs, []);
    expect(candidates).toHaveLength(4);
  });

  it('should exclude PRs with existing states', () => {
    const states = [
      makeStateFile({ prNumber: 1 }),
      makeStateFile({ prNumber: 3 }),
    ];
    const candidates = filterCandidates(openPRs, states);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.number)).toEqual([2, 4]);
  });

  it('should return empty when all PRs are tracked', () => {
    const states = openPRs.map((pr) => makeStateFile({ prNumber: pr.number }));
    const candidates = filterCandidates(openPRs, states);
    expect(candidates).toHaveLength(0);
  });

  it('should handle empty open PRs list', () => {
    const candidates = filterCandidates([], []);
    expect(candidates).toHaveLength(0);
  });
});

describe('concurrent operations', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should handle creating multiple PR states concurrently', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      createPRState(tempDir, i + 1, `oc_chat_${i}`),
    );
    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(results[i].prNumber).toBe(i + 1);
    }

    // Verify all files exist
    const allStates = await readAllStateFiles(tempDir);
    expect(allStates).toHaveLength(10);
  });
});
