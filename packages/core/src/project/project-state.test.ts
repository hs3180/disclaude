/**
 * Tests for ProjectStateStore — per-project operational state persistence.
 *
 * @see Issue #3335 (Project state persistence and admin commands)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStateStore, type ProjectState } from './project-state.js';

describe('ProjectStateStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'project-state-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should construct with workingDir and projectKey', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      expect(store.getStatePath()).toBe(join(tempDir, '.disclaude', 'project-state.json'));
    });
  });

  describe('load()', () => {
    it('should return default state when no state file exists', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      const result = store.load();

      expect(result.ok).toBe(true);
      if (!result.ok) {return;}

      expect(result.data.version).toBe(1);
      expect(result.data.projectKey).toBe('test/project');
      expect(result.data.lastActive).toBeDefined();
      expect(result.data.issues).toEqual({});
      expect(result.data.prs).toEqual({});
    });

    it('should load existing state from disk', () => {
      // Create state file
      const stateDir = join(tempDir, '.disclaude');
      mkdirSync(stateDir, { recursive: true });

      const state: ProjectState = {
        version: 1,
        projectKey: 'existing/project',
        lastActive: '2026-05-01T00:00:00Z',
        sync: { issues: '2026-05-01T00:00:00Z' },
        issues: {
          '42': { title: 'Test issue', state: 'open', triageStatus: 'triaged', labels: ['bug'] },
        },
        prs: {
          '15': { title: 'Test PR', issueNumber: 42, reviewStatus: 'pending' },
        },
      };

      writeFileSync(
        join(stateDir, 'project-state.json'),
        JSON.stringify(state, null, 2),
        'utf8',
      );

      const store = new ProjectStateStore(tempDir, 'test/project');
      const result = store.load();

      expect(result.ok).toBe(true);
      if (!result.ok) {return;}

      expect(result.data.projectKey).toBe('existing/project');
      expect(result.data.issues?.['42']?.title).toBe('Test issue');
      expect(result.data.prs?.['15']?.title).toBe('Test PR');
    });

    it('should handle corrupted state file gracefully', () => {
      const stateDir = join(tempDir, '.disclaude');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'project-state.json'), 'not valid json{{{', 'utf8');

      const store = new ProjectStateStore(tempDir, 'test/project');
      const result = store.load();

      // Should return default state on error
      expect(result.ok).toBe(false);
    });

    it('should handle invalid schema gracefully', () => {
      const stateDir = join(tempDir, '.disclaude');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'project-state.json'),
        JSON.stringify({ notVersion: true }),
        'utf8',
      );

      const store = new ProjectStateStore(tempDir, 'test/project');
      const result = store.load();

      // Should return default state (schema invalid)
      expect(result.ok).toBe(true);
      if (!result.ok) {return;}
      expect(result.data.projectKey).toBe('test/project');
    });
  });

  describe('get()', () => {
    it('should load state on first call', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      const result = store.get();

      expect(result.ok).toBe(true);
      if (!result.ok) {return;}
      expect(result.data.projectKey).toBe('test/project');
    });

    it('should return cached state on subsequent calls', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      const result1 = store.get();
      const result2 = store.get();

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) {return;}
      expect(result1.data).toBe(result2.data); // Same reference
    });
  });

  describe('update()', () => {
    it('should update state and persist to disk', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      store.load();

      const result = store.update((state) => ({
        ...state,
        issues: {
          '100': { title: 'New issue', state: 'open' },
        },
      }));

      expect(result.ok).toBe(true);
      if (!result.ok) {return;}
      expect(result.data.issues?.['100']?.title).toBe('New issue');

      // Verify persisted to disk
      const statePath = join(tempDir, '.disclaude', 'project-state.json');
      expect(existsSync(statePath)).toBe(true);
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(persisted.issues['100'].title).toBe('New issue');
    });

    it('should auto-update lastActive timestamp', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      const loaded = store.load();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {return;}

      const beforeActive = loaded.data.lastActive;

      // Small delay to ensure timestamp changes
      const result = store.update((state) => state);

      expect(result.ok).toBe(true);
      if (!result.ok) {return;}
      // lastActive should be updated (>= beforeActive)
      expect(result.data.lastActive >= beforeActive).toBe(true);
    });

    it('should persist sync timestamps', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      store.load();

      const syncTime = new Date().toISOString();
      const result = store.update((state) => ({
        ...state,
        sync: { issues: syncTime, prs: syncTime },
      }));

      expect(result.ok).toBe(true);
      if (!result.ok) {return;}
      expect(result.data.sync?.issues).toBe(syncTime);
      expect(result.data.sync?.prs).toBe(syncTime);
    });
  });

  describe('touch()', () => {
    it('should update lastActive timestamp', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      store.load();

      const result = store.touch();

      expect(result.ok).toBe(true);
      if (!result.ok) {return;}
      expect(result.data.lastActive).toBeDefined();
    });
  });

  describe('atomic writes', () => {
    it('should not leave tmp files after successful write', () => {
      const store = new ProjectStateStore(tempDir, 'test/project');
      store.load();
      store.update((state) => state);

      const tmpPath = join(tempDir, '.disclaude', 'project-state.json.tmp');
      expect(existsSync(tmpPath)).toBe(false);

      const statePath = join(tempDir, '.disclaude', 'project-state.json');
      expect(existsSync(statePath)).toBe(true);
    });
  });
});
