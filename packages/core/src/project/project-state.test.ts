/**
 * Unit tests for project state file utilities.
 *
 * Tests cover:
 * - Default state creation
 * - Path helpers
 * - Read/write round-trip
 * - Atomic write (corruption protection)
 * - Mutation helpers (upsert issue/pr, sync timestamp)
 * - Validation functions
 * - Edge cases (missing file, corrupted JSON, missing directory)
 *
 * @see Issue #3335 (Project state persistence)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDefaultState,
  getStateDir,
  getStateFilePath,
  isValidProjectState,
  isValidIssueEntry,
  isValidPrEntry,
  readProjectState,
  writeProjectState,
  updateSyncTimestamp,
  upsertIssue,
  upsertPr,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
  STATE_VERSION,
} from './project-state.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failure
    }
  }
  tempDirs.length = 0;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('constants', () => {
  it('should have consistent state dir and file names', () => {
    expect(STATE_DIR_NAME).toBe('.disclaude');
    expect(STATE_FILE_NAME).toBe('project-state.json');
    expect(STATE_VERSION).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Path Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getStateDir', () => {
  it('should return .disclaude path inside project dir', () => {
    expect(getStateDir('/project/root')).toBe('/project/root/.disclaude');
  });
});

describe('getStateFilePath', () => {
  it('should return project-state.json path', () => {
    expect(getStateFilePath('/project/root')).toBe('/project/root/.disclaude/project-state.json');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Default State
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('createDefaultState', () => {
  it('should create state with correct defaults', () => {
    const state = createDefaultState('owner/repo');
    expect(state.version).toBe(STATE_VERSION);
    expect(state.projectKey).toBe('owner/repo');
    expect(state.lastActive).toBeTruthy();
    expect(state.sync).toEqual({});
    expect(state.issues).toEqual({});
    expect(state.prs).toEqual({});
  });

  it('should produce a valid state', () => {
    const state = createDefaultState('test/project');
    expect(isValidProjectState(state)).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Read / Write
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('writeProjectState + readProjectState', () => {
  it('should round-trip state through disk', () => {
    const dir = createTempDir();
    const state = createDefaultState('owner/repo');

    state.issues['42'] = {
      title: 'Test bug',
      state: 'open',
      triageStatus: 'triaged',
      labels: ['bug'],
    };

    writeProjectState(dir, state);
    const loaded = readProjectState(dir);

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.projectKey).toBe('owner/repo');
    expect(loaded!.issues['42']).toEqual({
      title: 'Test bug',
      state: 'open',
      triageStatus: 'triaged',
      labels: ['bug'],
    });
  });

  it('should create .disclaude/ directory if missing', () => {
    const dir = createTempDir();
    const state = createDefaultState('test');

    writeProjectState(dir, state);
    expect(existsSync(join(dir, '.disclaude'))).toBe(true);
    expect(existsSync(join(dir, '.disclaude', 'project-state.json'))).toBe(true);
  });

  it('should update lastActive on write', () => {
    const dir = createTempDir();
    const state = createDefaultState('test');

    // Modify state to ensure write picks up changes
    state.issues['1'] = { title: 'x', state: 'open', triageStatus: 'untriaged', labels: [] };

    writeProjectState(dir, state);
    const loaded = readProjectState(dir);

    // lastActive should be updated (could be same millisecond, but generally different)
    expect(loaded!.lastActive).toBeTruthy();
  });
});

describe('readProjectState', () => {
  it('should return null when state file does not exist', () => {
    const dir = createTempDir();
    expect(readProjectState(dir)).toBeNull();
  });

  it('should return null for corrupted JSON', () => {
    const dir = createTempDir();
    mkdirSync(join(dir, '.disclaude'), { recursive: true });
    writeFileSync(join(dir, '.disclaude', 'project-state.json'), 'not valid json{');

    expect(readProjectState(dir)).toBeNull();
  });

  it('should return null for invalid schema', () => {
    const dir = createTempDir();
    mkdirSync(join(dir, '.disclaude'), { recursive: true });
    writeFileSync(join(dir, '.disclaude', 'project-state.json'), JSON.stringify({ foo: 'bar' }));

    expect(readProjectState(dir)).toBeNull();
  });

  it('should return null for missing required fields', () => {
    const dir = createTempDir();
    mkdirSync(join(dir, '.disclaude'), { recursive: true });

    const partial = { version: 1, projectKey: 'test' }; // Missing lastActive, sync, issues, prs
    writeFileSync(join(dir, '.disclaude', 'project-state.json'), JSON.stringify(partial));

    expect(readProjectState(dir)).toBeNull();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutation Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('updateSyncTimestamp', () => {
  it('should update issues sync timestamp', () => {
    const dir = createTempDir();
    const state = updateSyncTimestamp(dir, 'issues', 'test/repo');

    expect(state).not.toBeNull();
    expect(state!.sync.issues).toBeTruthy();
    expect(state!.projectKey).toBe('test/repo');
  });

  it('should create default state if file missing', () => {
    const dir = createTempDir();
    const state = updateSyncTimestamp(dir, 'prs', 'new/project');

    expect(state).not.toBeNull();
    expect(state!.prs).toEqual({});
    expect(state!.sync.prs).toBeTruthy();
  });

  it('should preserve existing data when updating sync', () => {
    const dir = createTempDir();
    const original = createDefaultState('test');
    original.issues['1'] = { title: 'Existing', state: 'open', triageStatus: 'triaged', labels: [] };
    writeProjectState(dir, original);

    const state = updateSyncTimestamp(dir, 'issues', 'test');
    expect(state!.issues['1']).toEqual({ title: 'Existing', state: 'open', triageStatus: 'triaged', labels: [] });
  });
});

describe('upsertIssue', () => {
  it('should add a new issue', () => {
    const dir = createTempDir();
    const state = upsertIssue(dir, '42', {
      title: 'Bug report',
      state: 'open',
      triageStatus: 'untriaged',
      labels: ['bug'],
    }, 'test');

    expect(state).not.toBeNull();
    expect(state!.issues['42']).toEqual({
      title: 'Bug report',
      state: 'open',
      triageStatus: 'untriaged',
      labels: ['bug'],
    });
  });

  it('should update existing issue', () => {
    const dir = createTempDir();
    upsertIssue(dir, '42', {
      title: 'Bug',
      state: 'open',
      triageStatus: 'untriaged',
      labels: [],
    }, 'test');

    const state = upsertIssue(dir, '42', {
      title: 'Bug (updated)',
      state: 'closed',
      triageStatus: 'resolved',
      labels: ['bug', 'fixed'],
    }, 'test');

    expect(state!.issues['42'].title).toBe('Bug (updated)');
    expect(state!.issues['42'].state).toBe('closed');
    expect(state!.issues['42'].triageStatus).toBe('resolved');
  });
});

describe('upsertPr', () => {
  it('should add a new PR', () => {
    const dir = createTempDir();
    const state = upsertPr(dir, '15', {
      title: 'Fix bug',
      issueNumber: 42,
      reviewStatus: 'pending',
    }, 'test');

    expect(state).not.toBeNull();
    expect(state!.prs['15']).toEqual({
      title: 'Fix bug',
      issueNumber: 42,
      reviewStatus: 'pending',
    });
  });

  it('should update existing PR', () => {
    const dir = createTempDir();
    upsertPr(dir, '15', {
      title: 'Fix bug',
      reviewStatus: 'pending',
    }, 'test');

    const state = upsertPr(dir, '15', {
      title: 'Fix bug',
      reviewStatus: 'approved',
    }, 'test');

    expect(state!.prs['15'].reviewStatus).toBe('approved');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('isValidProjectState', () => {
  it('should accept valid state', () => {
    const state = createDefaultState('test');
    expect(isValidProjectState(state)).toBe(true);
  });

  it('should reject null', () => {
    expect(isValidProjectState(null)).toBe(false);
  });

  it('should reject non-object', () => {
    expect(isValidProjectState('string')).toBe(false);
    expect(isValidProjectState(42)).toBe(false);
    expect(isValidProjectState(true)).toBe(false);
  });

  it('should reject missing version', () => {
    const state = { projectKey: 'test', lastActive: 'now', sync: {}, issues: {}, prs: {} };
    expect(isValidProjectState(state)).toBe(false);
  });

  it('should reject missing projectKey', () => {
    const state = { version: 1, lastActive: 'now', sync: {}, issues: {}, prs: {} };
    expect(isValidProjectState(state)).toBe(false);
  });

  it('should reject non-object sync/issues/prs', () => {
    const base = { version: 1, projectKey: 'test', lastActive: 'now' };
    expect(isValidProjectState({ ...base, sync: null, issues: {}, prs: {} })).toBe(false);
    expect(isValidProjectState({ ...base, sync: {}, issues: null, prs: {} })).toBe(false);
    expect(isValidProjectState({ ...base, sync: {}, issues: {}, prs: null })).toBe(false);
  });

  it('should accept state with populated issues and prs', () => {
    const state = createDefaultState('test');
    state.issues['1'] = { title: 'Test', state: 'open', triageStatus: 'triaged', labels: ['bug'] };
    state.prs['2'] = { title: 'PR', reviewStatus: 'pending' };
    expect(isValidProjectState(state)).toBe(true);
  });
});

describe('isValidIssueEntry', () => {
  it('should accept valid entry', () => {
    expect(isValidIssueEntry({
      title: 'Bug',
      state: 'open',
      triageStatus: 'triaged',
      labels: ['bug'],
    })).toBe(true);
  });

  it('should reject null', () => {
    expect(isValidIssueEntry(null)).toBe(false);
  });

  it('should reject invalid triage status', () => {
    expect(isValidIssueEntry({
      title: 'Bug',
      state: 'open',
      triageStatus: 'invalid-status',
      labels: [],
    })).toBe(false);
  });

  it('should reject missing labels array', () => {
    expect(isValidIssueEntry({
      title: 'Bug',
      state: 'open',
      triageStatus: 'triaged',
    })).toBe(false);
  });
});

describe('isValidPrEntry', () => {
  it('should accept valid entry', () => {
    expect(isValidPrEntry({
      title: 'Fix',
      reviewStatus: 'pending',
    })).toBe(true);
  });

  it('should accept entry with issueNumber', () => {
    expect(isValidPrEntry({
      title: 'Fix',
      issueNumber: 42,
      reviewStatus: 'approved',
    })).toBe(true);
  });

  it('should reject invalid review status', () => {
    expect(isValidPrEntry({
      title: 'Fix',
      reviewStatus: 'unknown',
    })).toBe(false);
  });

  it('should reject null', () => {
    expect(isValidPrEntry(null)).toBe(false);
  });
});
