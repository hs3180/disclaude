/**
 * Unit tests for project state persistence.
 *
 * @see Issue #3335 (Phase 5: Project state persistence and admin commands)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveStatePath,
  createEmptyState,
  readProjectState,
  writeProjectState,
  updateProjectState,
  isValidProjectState,
  formatStateSummary,
  PROJECT_STATE_FILENAME,
} from './project-state.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'project-state-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────
// resolveStatePath
// ───────────────────────────────────────────

describe('resolveStatePath', () => {
  it('should resolve to .disclaude/project-state.json', () => {
    const path = resolveStatePath('/workspace/projects/my-project');
    expect(path).toBe('/workspace/projects/my-project/.disclaude/project-state.json');
  });
});

// ───────────────────────────────────────────
// createEmptyState
// ───────────────────────────────────────────

describe('createEmptyState', () => {
  it('should create state with given projectKey', () => {
    const state = createEmptyState('owner/repo');
    expect(state.version).toBe(1);
    expect(state.projectKey).toBe('owner/repo');
    expect(state.issues).toEqual({});
    expect(state.prs).toEqual({});
    expect(state.sync).toEqual({});
    expect(state.lastActive).toBeTruthy();
  });

  it('should create state with empty projectKey', () => {
    const state = createEmptyState('');
    expect(state.projectKey).toBe('');
  });
});

// ───────────────────────────────────────────
// readProjectState
// ───────────────────────────────────────────

describe('readProjectState', () => {
  it('should return empty state when no state file exists', () => {
    const result = readProjectState(tempDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    expect(result.data.version).toBe(1);
    expect(result.data.projectKey).toBe('');
    expect(result.data.issues).toEqual({});
  });

  it('should read valid state from disk', () => {
    const disclaudeDir = join(tempDir, '.disclaude');
    mkdirSync(disclaudeDir, { recursive: true });
    const statePath = join(disclaudeDir, PROJECT_STATE_FILENAME);

    const state = {
      version: 1,
      projectKey: 'owner/repo',
      lastActive: '2026-05-06T10:00:00Z',
      sync: { issues: '2026-05-06T09:00:00Z' },
      issues: {
        '42': { title: 'Bug fix', state: 'open', triageStatus: 'triaged', labels: ['bug'] },
      },
      prs: {},
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    const result = readProjectState(tempDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    expect(result.data.projectKey).toBe('owner/repo');
    expect(result.data.issues['42'].title).toBe('Bug fix');
  });

  it('should return error for invalid JSON', () => {
    const disclaudeDir = join(tempDir, '.disclaude');
    mkdirSync(disclaudeDir, { recursive: true });
    const statePath = join(disclaudeDir, PROJECT_STATE_FILENAME);
    writeFileSync(statePath, 'not json', 'utf8');

    const result = readProjectState(tempDir);
    expect(result.ok).toBe(false);
    if (result.ok) {return;}
    expect(result.error).toContain('读取');
  });

  it('should return error for invalid schema', () => {
    const disclaudeDir = join(tempDir, '.disclaude');
    mkdirSync(disclaudeDir, { recursive: true });
    const statePath = join(disclaudeDir, PROJECT_STATE_FILENAME);
    writeFileSync(statePath, JSON.stringify({ version: 2, foo: 'bar' }), 'utf8');

    const result = readProjectState(tempDir);
    expect(result.ok).toBe(false);
    if (result.ok) {return;}
    expect(result.error).toContain('格式无效');
  });
});

// ───────────────────────────────────────────
// writeProjectState
// ───────────────────────────────────────────

describe('writeProjectState', () => {
  it('should write state to disk', () => {
    const state = createEmptyState('owner/repo');
    const result = writeProjectState(tempDir, state);

    expect(result.ok).toBe(true);

    const statePath = resolveStatePath(tempDir);
    expect(existsSync(statePath)).toBe(true);

    const written = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(written.projectKey).toBe('owner/repo');
  });

  it('should create .disclaude directory if it does not exist', () => {
    const state = createEmptyState('owner/repo');
    const result = writeProjectState(tempDir, state);

    expect(result.ok).toBe(true);
    expect(existsSync(join(tempDir, '.disclaude'))).toBe(true);
  });

  it('should update lastActive on write', () => {
    const state = createEmptyState('owner/repo');

    const result = writeProjectState(tempDir, state);
    expect(result.ok).toBe(true);

    const statePath = resolveStatePath(tempDir);
    const written = JSON.parse(readFileSync(statePath, 'utf8'));
    // lastActive should be updated and be a valid ISO string
    expect(written.lastActive).toBeTruthy();
    expect(new Date(written.lastActive).getTime()).not.toBeNaN();
  });

  it('should write valid JSON', () => {
    const state = createEmptyState('owner/repo');
    state.issues['42'] = { title: 'Test issue', state: 'open', triageStatus: 'untriaged', labels: [] };

    writeProjectState(tempDir, state);

    const statePath = resolveStatePath(tempDir);
    const written = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(written.issues['42'].title).toBe('Test issue');
  });
});

// ───────────────────────────────────────────
// updateProjectState
// ───────────────────────────────────────────

describe('updateProjectState', () => {
  it('should create new state if none exists', () => {
    const result = updateProjectState(tempDir, 'owner/repo', (state) => {
      state.issues['1'] = { title: 'New issue', state: 'open', triageStatus: 'untriaged', labels: [] };
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    expect(result.data.projectKey).toBe('owner/repo');
    expect(result.data.issues['1'].title).toBe('New issue');
  });

  it('should update existing state', () => {
    // Create initial state
    const initial = createEmptyState('owner/repo');
    initial.issues['1'] = { title: 'First', state: 'open', triageStatus: 'triaged', labels: ['bug'] };
    writeProjectState(tempDir, initial);

    // Update it
    const result = updateProjectState(tempDir, 'owner/repo', (state) => {
      state.issues['2'] = { title: 'Second', state: 'open', triageStatus: 'untriaged', labels: [] };
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    expect(result.data.issues['1'].title).toBe('First');
    expect(result.data.issues['2'].title).toBe('Second');
  });

  it('should persist updates to disk', () => {
    updateProjectState(tempDir, 'owner/repo', (state) => {
      state.sync.issues = '2026-05-06T10:00:00Z';
    });

    // Read back from disk
    const readResult = readProjectState(tempDir);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {return;}
    expect(readResult.data.sync.issues).toBe('2026-05-06T10:00:00Z');
  });
});

// ───────────────────────────────────────────
// isValidProjectState
// ───────────────────────────────────────────

describe('isValidProjectState', () => {
  it('should validate a correct state', () => {
    const state = createEmptyState('owner/repo');
    expect(isValidProjectState(state)).toBe(true);
  });

  it('should reject null', () => {
    expect(isValidProjectState(null)).toBe(false);
  });

  it('should reject non-object', () => {
    expect(isValidProjectState('string')).toBe(false);
    expect(isValidProjectState(42)).toBe(false);
  });

  it('should reject wrong version', () => {
    const state = { ...createEmptyState('owner/repo'), version: 2 };
    expect(isValidProjectState(state)).toBe(false);
  });

  it('should reject missing projectKey', () => {
    const { projectKey: _, ...state } = createEmptyState('owner/repo');
    expect(isValidProjectState(state)).toBe(false);
  });

  it('should reject non-string projectKey', () => {
    const state = { ...createEmptyState('owner/repo'), projectKey: 42 };
    expect(isValidProjectState(state)).toBe(false);
  });

  it('should reject array issues', () => {
    const state = { ...createEmptyState('owner/repo'), issues: [] };
    expect(isValidProjectState(state)).toBe(false);
  });

  it('should reject array prs', () => {
    const state = { ...createEmptyState('owner/repo'), prs: [] };
    expect(isValidProjectState(state)).toBe(false);
  });

  it('should accept state without sync', () => {
    const state = createEmptyState('owner/repo');
    // Omit sync by creating a new object
    const { sync: _, ...stateWithoutSync } = state;
    expect(isValidProjectState(stateWithoutSync)).toBe(true);
  });
});

// ───────────────────────────────────────────
// formatStateSummary
// ───────────────────────────────────────────

describe('formatStateSummary', () => {
  it('should format empty state', () => {
    const state = createEmptyState('owner/repo');
    const summary = formatStateSummary(state);
    expect(summary).toContain('owner/repo');
    expect(summary).toContain('Issues');
    expect(summary).toContain('0 个已跟踪');
  });

  it('should include sync timestamps', () => {
    const state = createEmptyState('owner/repo');
    state.sync.issues = '2026-05-06T09:00:00Z';
    state.sync.prs = '2026-05-06T09:30:00Z';
    const summary = formatStateSummary(state);
    expect(summary).toContain('2026-05-06T09:00:00Z');
    expect(summary).toContain('2026-05-06T09:30:00Z');
  });

  it('should show tracked counts', () => {
    const state = createEmptyState('owner/repo');
    state.issues['1'] = { title: 'Bug', state: 'open', triageStatus: 'triaged', labels: ['bug'] };
    state.issues['2'] = { title: 'Feature', state: 'open', triageStatus: 'untriaged', labels: [] };
    state.prs['10'] = { title: 'Fix bug', reviewStatus: 'pending' };
    const summary = formatStateSummary(state);
    expect(summary).toContain('2 个已跟踪');
    expect(summary).toContain('1 个已跟踪');
  });

  it('should handle empty projectKey', () => {
    const state = createEmptyState('');
    const summary = formatStateSummary(state);
    expect(summary).toContain('未设置');
  });
});
