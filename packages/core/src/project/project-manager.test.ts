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
 * - Edge cases (empty inputs, re-binding, etc.)
 *
 * @see Issue #3519 (simplify /project command)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from './project-manager.js';
import type { ProjectConfig, ProjectManagerOptions } from './types.js';

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
      expect(pm2.getActive('chat-1').name).toBe('dir');
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Issue #3332: Project Config Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('project configs (Issue #3332)', () => {
    it('should load project configs and auto-bind chatIds', () => {
      const opts = createOptions();
      const projects: ProjectConfig[] = [
        { key: 'owner/repo', workingDir: '.', chatId: 'oc_chat1' },
        { key: 'other/project', workingDir: '/absolute/path', chatId: 'oc_chat2' },
      ];
      const pm = new ProjectManager({ ...opts, projects });

      // chatIds should be auto-bound
      expect(pm.getActive('oc_chat1').workingDir).toBe(resolve(opts.workspaceDir, '.'));
      expect(pm.getActive('oc_chat2').workingDir).toBe('/absolute/path');
    });

    it('should look up project config by key', () => {
      const opts = createOptions();
      const projects: ProjectConfig[] = [
        { key: 'owner/repo', workingDir: '.', chatId: 'oc_chat1', modelTier: 'low' },
      ];
      const pm = new ProjectManager({ ...opts, projects });

      const config = pm.getProjectConfig('owner/repo');
      expect(config).toBeDefined();
      expect(config!.key).toBe('owner/repo');
      expect(config!.modelTier).toBe('low');
    });

    it('should return undefined for unknown project key', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      expect(pm.getProjectConfig('nonexistent')).toBeUndefined();
    });

    it('should return all project configs', () => {
      const opts = createOptions();
      const projects: ProjectConfig[] = [
        { key: 'owner/repo-a', workingDir: '.', chatId: 'oc_chat1' },
        { key: 'owner/repo-b', workingDir: './other', chatId: 'oc_chat2' },
      ];
      const pm = new ProjectManager({ ...opts, projects });

      const allConfigs = pm.getAllProjectConfigs();
      expect(allConfigs).toHaveLength(2);
      expect(allConfigs.map(c => c.key).sort()).toEqual(['owner/repo-a', 'owner/repo-b']);
    });

    it('should return empty array when no projects configured', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      expect(pm.getAllProjectConfigs()).toEqual([]);
    });

    it('should not override user-initiated bindings', () => {
      const opts = createOptions();

      // First, create persisted binding
      const pm1 = new ProjectManager(opts);
      pm1.use('oc_chat1', '/user-bound-dir');

      // Now load with project config that has the same chatId
      const projects: ProjectConfig[] = [
        { key: 'owner/repo', workingDir: './project-dir', chatId: 'oc_chat1' },
      ];
      const pm2 = new ProjectManager({ ...opts, projects });

      // User binding should take precedence
      expect(pm2.getActive('oc_chat1').workingDir).toBe('/user-bound-dir');
      // But project config should still be available for lookup
      expect(pm2.getProjectConfig('owner/repo')).toBeDefined();
    });

    it('should skip project configs with missing required fields', () => {
      const opts = createOptions();
      const projects = [
        { key: 'valid/project', workingDir: '.', chatId: 'oc_chat1' },
        { key: '', workingDir: '.', chatId: 'oc_chat2' }, // empty key
        { key: 'no-dir', workingDir: '', chatId: 'oc_chat3' }, // empty workingDir
        { key: 'no-chatid', workingDir: '.', chatId: '' }, // empty chatId
      ] as ProjectConfig[];
      const pm = new ProjectManager({ ...opts, projects });

      expect(pm.getAllProjectConfigs()).toHaveLength(1);
      expect(pm.getProjectConfig('valid/project')).toBeDefined();
    });

    it('should support modelTier and idleTimeoutMs in project config', () => {
      const opts = createOptions();
      const projects: ProjectConfig[] = [
        { key: 'owner/repo', workingDir: '.', chatId: 'oc_chat1', modelTier: 'low', idleTimeoutMs: 60000 },
      ];
      const pm = new ProjectManager({ ...opts, projects });

      const config = pm.getProjectConfig('owner/repo');
      expect(config!.modelTier).toBe('low');
      expect(config!.idleTimeoutMs).toBe(60000);
    });

    it('project config bindings should work with CwdProvider', () => {
      const opts = createOptions();
      const projects: ProjectConfig[] = [
        { key: 'owner/repo', workingDir: '/project-dir', chatId: 'oc_chat1' },
      ];
      const pm = new ProjectManager({ ...opts, projects });
      const cwdProvider = pm.createCwdProvider();

      expect(cwdProvider('oc_chat1')).toBe('/project-dir');
      expect(cwdProvider('unknown-chat')).toBeUndefined();
    });

    it('should resolve relative workingDir against workspaceDir', () => {
      const opts = createOptions();
      const projects: ProjectConfig[] = [
        { key: 'owner/repo', workingDir: 'subdir/project', chatId: 'oc_chat1' },
      ];
      const pm = new ProjectManager({ ...opts, projects });

      expect(pm.getActive('oc_chat1').workingDir).toBe(resolve(opts.workspaceDir, 'subdir/project'));
    });
  });
});
