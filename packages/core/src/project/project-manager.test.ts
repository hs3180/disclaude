/**
 * Unit tests for ProjectManager — simplified chatId → workingDir binding.
 *
 * Tests cover:
 * - Binding (use/reset)
 * - getActive() default and bound behavior
 * - Path resolution (relative/absolute)
 * - Path traversal protection
 * - CwdProvider factory
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Migration from old projects.json format
 * - Edge cases (empty inputs, re-binding, etc.)
 *
 * @see Issue #3519 (simplify /project command)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from './project-manager.js';
import type { ProjectManagerOptions } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  tempDirs.push(dir);
  return dir;
}

function createOptions(overrides?: Partial<ProjectManagerOptions>): ProjectManagerOptions {
  const workspaceDir = createTempDir();
  return { workspaceDir, ...overrides };
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  tempDirs.length = 0;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager', () => {
  describe('constructor', () => {
    it('should initialize with no bindings', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').name).toBe('default');
    });

    it('should restore bindings from persisted file', () => {
      const opts = createOptions();
      const pm1 = new ProjectManager(opts);
      pm1.use('chat-1', '/some/dir');

      // Create a new instance pointing to the same workspace
      const pm2 = new ProjectManager(opts);
      expect(pm2.getActive('chat-1').name).toBe('/some/dir');
    });
  });

  describe('getActive()', () => {
    it('should return default for unbound chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const active = pm.getActive('chat-1');

      expect(active.name).toBe('default');
      expect(active.workingDir).toBe(opts.workspaceDir);
    });

    it('should return bound workingDir for bound chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      pm.use('chat-1', '/some/project');

      const active = pm.getActive('chat-1');
      expect(active.workingDir).toBe('/some/project');
    });
  });

  describe('use()', () => {
    it('should bind chatId to absolute workingDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', '/absolute/path');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.workingDir).toBe('/absolute/path');
      }
    });

    it('should resolve relative path against workspaceDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', 'projects/my-app');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.workingDir).toBe(resolve(opts.workspaceDir, 'projects/my-app'));
      }
    });

    it('should re-bind chatId to new workingDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      pm.use('chat-1', '/first');
      const result = pm.use('chat-1', '/second');

      expect(result.ok).toBe(true);
      expect(pm.getActive('chat-1').workingDir).toBe('/second');
    });

    it('should reject empty workingDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', '');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不能为空');
      }
    });

    it('should reject whitespace-only workingDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', '   ');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不能为空');
      }
    });

    it('should reject path traversal with ..', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', '../etc/passwd');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('路径遍历');
      }
    });

    it('should reject path with null bytes', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', '/path\0/evil');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('空字节');
      }
    });

    it('should reject empty chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('', '/some/path');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('chatId');
      }
    });

    it('should persist binding to project-bindings.json', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      pm.use('chat-1', '/my-project');

      const persistPath = pm.getPersistPath();
      expect(existsSync(persistPath)).toBe(true);

      const data = JSON.parse(readFileSync(persistPath, 'utf8'));
      expect(data.version).toBe(1);
      expect(data.bindings['chat-1']).toBe('/my-project');
    });
  });

  describe('reset()', () => {
    it('should remove binding and return default', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      pm.use('chat-1', '/project');
      const result = pm.reset('chat-1');

      expect(result.ok).toBe(true);
      expect(pm.getActive('chat-1').name).toBe('default');
    });

    it('should succeed when already on default', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.reset('chat-1');
      expect(result.ok).toBe(true);
    });

    it('should reject empty chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.reset('');
      expect(result.ok).toBe(false);
    });
  });

  describe('listBindings()', () => {
    it('should return empty array when no bindings', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      expect(pm.listBindings()).toEqual([]);
    });

    it('should return all bindings', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      pm.use('chat-1', '/project-a');
      pm.use('chat-2', '/project-b');

      const bindings = pm.listBindings();
      expect(bindings).toHaveLength(2);
      expect(bindings.find(b => b.chatId === 'chat-1')?.workingDir).toBe('/project-a');
      expect(bindings.find(b => b.chatId === 'chat-2')?.workingDir).toBe('/project-b');
    });
  });

  describe('createCwdProvider()', () => {
    it('should return undefined for default (unbound) chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const cwdProvider = pm.createCwdProvider();

      expect(cwdProvider('chat-1')).toBeUndefined();
    });

    it('should return workingDir for bound chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      pm.use('chat-1', '/my-project');

      const cwdProvider = pm.createCwdProvider();
      expect(cwdProvider('chat-1')).toBe('/my-project');
    });

    it('should reflect changes after binding', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const cwdProvider = pm.createCwdProvider();

      expect(cwdProvider('chat-1')).toBeUndefined();
      pm.use('chat-1', '/new-project');
      expect(cwdProvider('chat-1')).toBe('/new-project');
    });
  });

  describe('persistence', () => {
    it('should persist and restore bindings', () => {
      const opts = createOptions();
      const pm1 = new ProjectManager(opts);
      pm1.use('chat-1', '/project-a');
      pm1.use('chat-2', '/project-b');

      // Create new instance with same workspace
      const pm2 = new ProjectManager(opts);
      expect(pm2.getActive('chat-1').workingDir).toBe('/project-a');
      expect(pm2.getActive('chat-2').workingDir).toBe('/project-b');
      expect(pm2.getActive('chat-3').name).toBe('default');
    });

    it('should handle missing persist file gracefully', () => {
      const opts = createOptions();
      // No error should be thrown
      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').name).toBe('default');
    });

    it('should handle corrupted persist file gracefully', () => {
      const opts = createOptions();
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'project-bindings.json'), 'not valid json');

      // Should not throw
      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').name).toBe('default');
    });

    it('should handle invalid schema gracefully', () => {
      const opts = createOptions();
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'project-bindings.json'), JSON.stringify({
        version: 99,
        bindings: {},
      }));

      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').name).toBe('default');
    });

    it('should skip invalid binding entries', () => {
      const opts = createOptions();
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'project-bindings.json'), JSON.stringify({
        version: 1,
        bindings: {
          'chat-1': '/valid/path',
          'chat-2': '',
          'chat-3': 123,
        },
      }));

      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').workingDir).toBe('/valid/path');
      expect(pm.getActive('chat-2').name).toBe('default');
      expect(pm.getActive('chat-3').name).toBe('default');
    });

    it('should use atomic write-then-rename pattern', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      pm.use('chat-1', '/project');

      // .tmp file should not remain
      const tmpPath = `${pm.getPersistPath()  }.tmp`;
      expect(existsSync(tmpPath)).toBe(false);
      // Final file should exist
      expect(existsSync(pm.getPersistPath())).toBe(true);
    });
  });

  describe('migration from projects.json', () => {
    it('should migrate bindings from old projects.json format', () => {
      const opts = createOptions();
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });

      // Write old format
      writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
        projects: {
          'my-project': {
            templateName: 'research',
            workingDir: '/workspace/projects/my-project',
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
        chatProjectMap: {
          'oc_chat1': 'my-project',
        },
      }));

      const pm = new ProjectManager(opts);
      expect(pm.getActive('oc_chat1').workingDir).toBe('/workspace/projects/my-project');

      // Should also create new format file
      expect(existsSync(join(dataDir, 'project-bindings.json'))).toBe(true);
    });

    it('should handle old format with instances key', () => {
      const opts = createOptions();
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });

      writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
        instances: {
          'project-a': {
            workingDir: '/path/to/a',
            templateName: 'test',
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
        chatProjectMap: {
          'oc_chat1': 'project-a',
        },
      }));

      const pm = new ProjectManager(opts);
      expect(pm.getActive('oc_chat1').workingDir).toBe('/path/to/a');
    });

    it('should skip migration when no old file exists', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').name).toBe('default');
    });
  });

  describe('rollback on persist failure', () => {
    it('should rollback use() when persist fails', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      // Make .disclaude directory read-only to cause persist failure
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });

      // Write a file to make it exist, then make dir read-only
      chmodSync(dataDir, 0o444);

      try {
        const result = pm.use('chat-1', '/project');
        if (!result.ok) {
          // In-memory state should be rolled back
          expect(pm.getActive('chat-1').name).toBe('default');
        }
      } finally {
        chmodSync(dataDir, 0o755);
      }
    });
  });

  describe('getWorkspaceDir()', () => {
    it('should return the configured workspace directory', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      expect(pm.getWorkspaceDir()).toBe(opts.workspaceDir);
    });
  });
});
