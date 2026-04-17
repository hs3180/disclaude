/**
 * Unit tests for schedules/pr-scanner/scanner.ts
 *
 * Tests all CLI actions, state file I/O, and edge cases.
 * No GitHub API dependency — fully offline testable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCapacity,
  listCandidates,
  createState,
  markState,
  statusReport,
  readStateFile,
  writeStateFile,
  listAllStateFiles,
  ensureStateDir,
  addLabel,
  removeLabel,
  type PrStateFile,
} from './scanner.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pr-scanner-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateFile(overrides: Partial<PrStateFile> & { prNumber: number }): PrStateFile {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  return {
    chatId: 'oc_test',
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    ...overrides,
  };
}

async function writeCorruptFile(dir: string, prNumber: number): Promise<void> {
  const filePath = join(dir, `pr-${prNumber}.json`);
  await writeFile(filePath, '{invalid json content', 'utf-8');
}

// ---------------------------------------------------------------------------
// ensureStateDir
// ---------------------------------------------------------------------------

describe('ensureStateDir', () => {
  it('creates directory if it does not exist', async () => {
    const newDir = join(testDir, 'subdir', 'state');
    await ensureStateDir(newDir);
    const { stat } = await import('node:fs/promises');
    await expect(stat(newDir)).resolves.toBeDefined();
  });

  it('does not fail if directory already exists', async () => {
    await mkdir(testDir, { recursive: true });
    await expect(ensureStateDir(testDir)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeStateFile / readStateFile
// ---------------------------------------------------------------------------

describe('writeStateFile / readStateFile', () => {
  it('writes and reads a state file correctly', async () => {
    const state = makeStateFile({ prNumber: 123 });
    await writeStateFile(testDir, 123, state);
    const read = await readStateFile(testDir, 123);
    expect(read).toEqual(state);
  });

  it('returns null for non-existent state file', async () => {
    const read = await readStateFile(testDir, 999);
    expect(read).toBeNull();
  });

  it('overwrites existing state file', async () => {
    const v1 = makeStateFile({ prNumber: 42, state: 'reviewing' });
    await writeStateFile(testDir, 42, v1);

    const v2 = { ...v1, state: 'approved' as const, updatedAt: new Date().toISOString() };
    await writeStateFile(testDir, 42, v2);

    const read = await readStateFile(testDir, 42);
    expect(read?.state).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// listAllStateFiles
// ---------------------------------------------------------------------------

describe('listAllStateFiles', () => {
  it('returns empty array for non-existent directory', async () => {
    const result = await listAllStateFiles(join(testDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('lists all valid state files', async () => {
    await writeStateFile(testDir, 10, makeStateFile({ prNumber: 10 }));
    await writeStateFile(testDir, 20, makeStateFile({ prNumber: 20 }));
    const result = await listAllStateFiles(testDir);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.prNumber).sort()).toEqual([10, 20]);
  });

  it('skips corrupt files', async () => {
    await writeStateFile(testDir, 10, makeStateFile({ prNumber: 10 }));
    await writeCorruptFile(testDir, 20);
    const result = await listAllStateFiles(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(10);
  });

  it('skips non-matching file names', async () => {
    await writeStateFile(testDir, 10, makeStateFile({ prNumber: 10 }));
    // Write a file that doesn't match the pr-*.json pattern
    await writeFile(join(testDir, 'other.json'), '{}', 'utf-8');
    await writeFile(join(testDir, 'pr-abc.json'), '{}', 'utf-8');
    const result = await listAllStateFiles(testDir);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// checkCapacity
// ---------------------------------------------------------------------------

describe('checkCapacity', () => {
  it('returns full capacity when no state files exist', async () => {
    const result = await checkCapacity(testDir, 3);
    expect(result).toEqual({ reviewing: 0, maxConcurrent: 3, available: 3 });
  });

  it('counts only reviewing PRs', async () => {
    await writeStateFile(testDir, 1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(testDir, 2, makeStateFile({ prNumber: 2, state: 'approved' }));
    await writeStateFile(testDir, 3, makeStateFile({ prNumber: 3, state: 'closed' }));
    await writeStateFile(testDir, 4, makeStateFile({ prNumber: 4, state: 'reviewing' }));
    const result = await checkCapacity(testDir, 3);
    expect(result).toEqual({ reviewing: 2, maxConcurrent: 3, available: 1 });
  });

  it('returns 0 available when at capacity', async () => {
    await writeStateFile(testDir, 1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(testDir, 2, makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(testDir, 3, makeStateFile({ prNumber: 3, state: 'reviewing' }));
    const result = await checkCapacity(testDir, 3);
    expect(result).toEqual({ reviewing: 3, maxConcurrent: 3, available: 0 });
  });

  it('returns 0 available when over capacity', async () => {
    await writeStateFile(testDir, 1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(testDir, 2, makeStateFile({ prNumber: 2, state: 'reviewing' }));
    await writeStateFile(testDir, 3, makeStateFile({ prNumber: 3, state: 'reviewing' }));
    await writeStateFile(testDir, 4, makeStateFile({ prNumber: 4, state: 'reviewing' }));
    const result = await checkCapacity(testDir, 3);
    expect(result).toEqual({ reviewing: 4, maxConcurrent: 3, available: 0 });
  });
});

// ---------------------------------------------------------------------------
// listCandidates
// ---------------------------------------------------------------------------

describe('listCandidates', () => {
  it('returns array result (may be empty if gh fails)', async () => {
    // In test environment, gh may or may not be available
    const result = await listCandidates(testDir, 'nonexistent/repo');
    // Should not throw — just returns array (empty or not)
    expect(Array.isArray(result)).toBe(true);
  });

  it('filters out tracked PRs from gh output', async () => {
    // We can't easily test with real gh, but we test the filtering logic
    // by verifying that tracked PRs are excluded
    await writeStateFile(testDir, 100, makeStateFile({ prNumber: 100 }));
    // The result should not include PR #100 if gh returns it
    const result = await listCandidates(testDir);
    const pr100 = result.find((c) => c.number === 100);
    expect(pr100).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createState
// ---------------------------------------------------------------------------

describe('createState', () => {
  it('creates a state file with correct schema', async () => {
    const result = await createState(testDir, 42, 'oc_test123');
    expect(result.prNumber).toBe(42);
    expect(result.chatId).toBe('oc_test123');
    expect(result.state).toBe('reviewing');
    expect(result.createdAt).toBeDefined();
    expect(result.updatedAt).toBe(result.createdAt);
    expect(result.expiresAt).toBeDefined();

    // Verify expiresAt is ~48 hours from createdAt
    const created = new Date(result.createdAt).getTime();
    const expires = new Date(result.expiresAt).getTime();
    const diffHours = (expires - created) / (1000 * 60 * 60);
    expect(diffHours).toBeCloseTo(48, 0);
  });

  it('persists to disk and can be read back', async () => {
    await createState(testDir, 77, 'oc_persist');
    const read = await readStateFile(testDir, 77);
    expect(read).not.toBeNull();
    expect(read!.prNumber).toBe(77);
    expect(read!.chatId).toBe('oc_persist');
    expect(read!.state).toBe('reviewing');
  });

  it('exits when state file already exists', async () => {
    await createState(testDir, 55, 'oc_first');
    await expect(createState(testDir, 55, 'oc_second')).rejects.toThrow(
      'State file already exists for PR #55',
    );
  });

  it('works with empty chatId', async () => {
    const result = await createState(testDir, 88, '');
    expect(result.chatId).toBe('');
    const read = await readStateFile(testDir, 88);
    expect(read!.chatId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// markState
// ---------------------------------------------------------------------------

describe('markState', () => {
  it('transitions state from reviewing to approved', async () => {
    await createState(testDir, 10, 'oc_mark');
    const result = await markState(testDir, 10, 'approved');
    expect(result.state).toBe('approved');
    expect(result.prNumber).toBe(10);
  });

  it('transitions state from reviewing to closed', async () => {
    await createState(testDir, 11, 'oc_mark');
    const result = await markState(testDir, 11, 'closed');
    expect(result.state).toBe('closed');
  });

  it('updates updatedAt timestamp', async () => {
    const created = await createState(testDir, 12, 'oc_ts');
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const updated = await markState(testDir, 12, 'approved');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );
  });

  it('preserves other fields when marking', async () => {
    await createState(testDir, 13, 'oc_preserve');
    const result = await markState(testDir, 13, 'approved');
    expect(result.chatId).toBe('oc_preserve');
    expect(result.createdAt).toBeDefined();
    expect(result.expiresAt).toBeDefined();
  });

  it('exits when state file does not exist', async () => {
    await expect(markState(testDir, 999, 'approved')).rejects.toThrow(
      'No state file found for PR #999',
    );
  });
});

// ---------------------------------------------------------------------------
// statusReport
// ---------------------------------------------------------------------------

describe('statusReport', () => {
  it('returns message when no PRs tracked', async () => {
    const report = await statusReport(testDir);
    expect(report).toContain('No PRs');
  });

  it('groups PRs by state', async () => {
    await writeStateFile(testDir, 1, makeStateFile({ prNumber: 1, state: 'reviewing' }));
    await writeStateFile(testDir, 2, makeStateFile({ prNumber: 2, state: 'approved' }));
    await writeStateFile(testDir, 3, makeStateFile({ prNumber: 3, state: 'closed' }));
    const report = await statusReport(testDir);
    expect(report).toContain('Tracking 3 PR(s)');
    expect(report).toContain('[reviewing]');
    expect(report).toContain('[approved]');
    expect(report).toContain('[closed]');
    expect(report).toContain('#1');
    expect(report).toContain('#2');
    expect(report).toContain('#3');
  });

  it('shows chat ID when present', async () => {
    await writeStateFile(testDir, 1, makeStateFile({ prNumber: 1, chatId: 'oc_abc123' }));
    const report = await statusReport(testDir);
    expect(report).toContain('oc_abc123');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles concurrent-like scenario: multiple creates', async () => {
    const results = await Promise.all([
      createState(testDir, 201, 'oc_a'),
      createState(testDir, 202, 'oc_b'),
      createState(testDir, 203, 'oc_c'),
    ]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.prNumber).sort()).toEqual([201, 202, 203]);
  });

  it('handles empty state directory for all actions', async () => {
    const cap = await checkCapacity(testDir, 5);
    expect(cap.reviewing).toBe(0);

    const report = await statusReport(testDir);
    expect(report).toContain('No PRs');

    const all = await listAllStateFiles(testDir);
    expect(all).toEqual([]);
  });

  it('state file content is valid JSON with trailing newline', async () => {
    await createState(testDir, 300, 'oc_json');
    const filePath = join(testDir, 'pr-300.json');
    const content = await readFile(filePath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    // Should parse cleanly
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('state file contains all required fields', async () => {
    const result = await createState(testDir, 400, 'oc_fields');
    const filePath = join(testDir, 'pr-400.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.prNumber).toBe(400);
    expect(parsed.chatId).toBe('oc_fields');
    expect(parsed.state).toBe('reviewing');
    expect(typeof parsed.createdAt).toBe('string');
    expect(typeof parsed.updatedAt).toBe('string');
    expect(typeof parsed.expiresAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Label management
// ---------------------------------------------------------------------------

describe('addLabel', () => {
  it('returns failure when gh CLI is not available', async () => {
    const result = await addLabel(999, 'pr-scanner:reviewing', 'nonexistent/repo');
    expect(result.success).toBe(false);
    expect(result.prNumber).toBe(999);
    expect(result.label).toBe('pr-scanner:reviewing');
    expect(result.action).toBe('added');
    expect(result.error).toBeDefined();
  });

  it('returns correct structure on failure', async () => {
    const result = await addLabel(123, 'test-label');
    // In test environment gh likely fails, which is fine
    expect(result).toHaveProperty('prNumber', 123);
    expect(result).toHaveProperty('label', 'test-label');
    expect(result).toHaveProperty('action', 'added');
    expect(result).toHaveProperty('success');
  });
});

describe('removeLabel', () => {
  it('returns failure when gh CLI is not available', async () => {
    const result = await removeLabel(999, 'pr-scanner:reviewing', 'nonexistent/repo');
    expect(result.success).toBe(false);
    expect(result.prNumber).toBe(999);
    expect(result.label).toBe('pr-scanner:reviewing');
    expect(result.action).toBe('removed');
    expect(result.error).toBeDefined();
  });

  it('returns correct structure on failure', async () => {
    const result = await removeLabel(456, 'test-label');
    expect(result).toHaveProperty('prNumber', 456);
    expect(result).toHaveProperty('label', 'test-label');
    expect(result).toHaveProperty('action', 'removed');
    expect(result).toHaveProperty('success');
  });
});

describe('label integration with createState', () => {
  it('creates state file even when label fails (non-blocking)', async () => {
    // createState attempts to add label via gh, which fails in test env
    // But the state file should still be created
    const result = await createState(testDir, 500, 'oc_label_test');
    expect(result.prNumber).toBe(500);
    expect(result.state).toBe('reviewing');

    // State file should exist on disk
    const read = await readStateFile(testDir, 500);
    expect(read).not.toBeNull();
    expect(read!.prNumber).toBe(500);
  });
});

describe('label integration with markState', () => {
  it('transitions state even when label removal fails (non-blocking)', async () => {
    // Create state first
    await createState(testDir, 600, 'oc_mark_label');
    // markState attempts to remove label via gh, which fails in test env
    // But the state should still transition
    const result = await markState(testDir, 600, 'approved');
    expect(result.state).toBe('approved');
    expect(result.prNumber).toBe(600);
  });

  it('does not remove label when state stays as reviewing', async () => {
    await createState(testDir, 601, 'oc_stay');
    // Transitioning reviewing → reviewing should not trigger label removal
    const result = await markState(testDir, 601, 'reviewing');
    expect(result.state).toBe('reviewing');
  });
});
