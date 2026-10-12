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
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
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

function createProjectDir(workspaceDir: string, name = 'project'): string {
  const dir = join(workspaceDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
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
      pm1.use('chat-1', createProjectDir(opts.workspaceDir, 'dir'));

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
      pm.use('chat-1', createProjectDir(opts.workspaceDir, 'project'));

      const active = pm.getActive('chat-1');
      expect(active.workingDir).toBe(join(opts.workspaceDir, 'project'));
    });
  });

  describe('use()', () => {
    it('should bind chatId to absolute workingDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', createProjectDir(opts.workspaceDir, 'absolute/path'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.workingDir).toBe(join(opts.workspaceDir, 'absolute/path'));
      }
    });

    it('should resolve relative path against workspaceDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      createProjectDir(opts.workspaceDir, 'projects/my-app');
      const result = pm.use('chat-1', 'projects/my-app');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.workingDir).toBe(resolve(opts.workspaceDir, 'projects/my-app'));
      }
    });

    it('should re-bind chatId to new workingDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      pm.use('chat-1', createProjectDir(opts.workspaceDir, 'first'));
      const result = pm.use('chat-1', createProjectDir(opts.workspaceDir, 'second'));

      expect(result.ok).toBe(true);
      expect(pm.getActive('chat-1').workingDir).toBe(join(opts.workspaceDir, 'second'));
    });

    it.each(['missing', 'file'])('rejects a %s target without altering the previous binding or disk', (kind) => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const original = createProjectDir(opts.workspaceDir, 'original');
      expect(pm.use('chat-1', original).ok).toBe(true);
      const before = readFileSync(pm.getPersistPath(), 'utf8');
      const target = join(opts.workspaceDir, kind);
      if (kind === 'file') { writeFileSync(target, 'not a directory'); }

      const result = pm.use('chat-1', target);
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).toContain(kind === 'file' ? '不是目录' : '不存在'); }
      expect(pm.getActive('chat-1').workingDir).toBe(original);
      expect(readFileSync(pm.getPersistPath(), 'utf8')).toBe(before);
    });

    it('does not create persistence when a new binding targets a missing directory', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      expect(pm.use('chat-1', 'missing @_user_1').ok).toBe(false);
      expect(pm.listBindings()).toEqual([]);
      expect(existsSync(pm.getPersistPath())).toBe(false);
    });

    it('supports existing directory names containing spaces and literal @ characters', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const projectDir = createProjectDir(opts.workspaceDir, 'my project@home');
      expect(pm.use('chat-1', projectDir).ok).toBe(true);
      expect(pm.resolveCwd('chat-1').effectiveCwd).toBe(projectDir);
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

      pm.use('chat-1', createProjectDir(opts.workspaceDir, 'my-project'));

      const persistPath = pm.getPersistPath();
      expect(existsSync(persistPath)).toBe(true);

      const data = JSON.parse(readFileSync(persistPath, 'utf8'));
      expect(data.version).toBe(1);
      expect(data.bindings['chat-1']).toBe(join(opts.workspaceDir, 'my-project'));
    });
  });

  describe('reset()', () => {
    it('should remove binding and return default', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      pm.use('chat-1', createProjectDir(opts.workspaceDir, 'project'));
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

      pm.use('chat-1', createProjectDir(opts.workspaceDir, 'project-a'));
      pm.use('chat-2', createProjectDir(opts.workspaceDir, 'project-b'));

      const bindings = pm.listBindings();
      expect(bindings).toHaveLength(2);
      expect(bindings.find((b) => b.chatId === 'chat-1')?.workingDir).toBe(join(opts.workspaceDir, 'project-a'));
      expect(bindings.find((b) => b.chatId === 'chat-2')?.workingDir).toBe(join(opts.workspaceDir, 'project-b'));
    });
  });

  describe('createCwdProvider()', () => {
    it('should return undefined for default (unbound) chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const cwdProvider = pm.createCwdProvider();

      expect(cwdProvider('chat-1')).toBeUndefined();
    });

    it('should return workingDir for bound chatId with existing directory', () => {
      const opts = createOptions();
      const projectDir = join(opts.workspaceDir, 'my-project');
      mkdirSync(projectDir, { recursive: true });
      const pm = new ProjectManager(opts);
      pm.use('chat-1', projectDir);

      const cwdProvider = pm.createCwdProvider();
      expect(cwdProvider('chat-1')).toBe(projectDir);
    });

    it('should return undefined when bound directory does not exist (Issue #3977)', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const removedDir = createProjectDir(opts.workspaceDir, 'vanished');
      pm.use('chat-1', removedDir);
      rmSync(removedDir, { recursive: true });

      const cwdProvider = pm.createCwdProvider();
      expect(cwdProvider('chat-1')).toBeUndefined();
    });

    it('should reflect changes after binding', () => {
      const opts = createOptions();
      const projectDir = join(opts.workspaceDir, 'new-project');
      mkdirSync(projectDir, { recursive: true });
      const pm = new ProjectManager(opts);
      const cwdProvider = pm.createCwdProvider();

      expect(cwdProvider('chat-1')).toBeUndefined();
      pm.use('chat-1', projectDir);
      expect(cwdProvider('chat-1')).toBe(projectDir);
    });
  });

  describe('resolveCwd() (Issue #4448)', () => {
    it('keeps a directory named default bound', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const projectDir = createProjectDir(opts.workspaceDir, 'default');
      expect(pm.use('chat-1', projectDir).ok).toBe(true);
      expect(pm.resolveCwd('chat-1')).toEqual({ reason: 'bound', boundWorkingDir: projectDir, effectiveCwd: projectDir });
    });

    it('rejects a legacy binding replaced by a file', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const projectDir = createProjectDir(opts.workspaceDir);
      expect(pm.use('chat-1', projectDir).ok).toBe(true);
      rmSync(projectDir, { recursive: true });
      writeFileSync(projectDir, 'file replacement');
      expect(pm.resolveCwd('chat-1').reason).toBe('bound-missing');
      expect(pm.getActive('chat-1').workingDir).toBe(projectDir);
    });

    it('should report unbound for default chatId', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const resolution = pm.resolveCwd('chat-1');
      expect(resolution.reason).toBe('unbound');
      expect(resolution.effectiveCwd).toBeUndefined();
      expect(resolution.boundWorkingDir).toBeUndefined();
    });

    it('should report bound when the directory exists', () => {
      const opts = createOptions();
      const projectDir = join(opts.workspaceDir, 'my-project');
      mkdirSync(projectDir, { recursive: true });
      const pm = new ProjectManager(opts);
      pm.use('chat-1', projectDir);

      const resolution = pm.resolveCwd('chat-1');
      expect(resolution.reason).toBe('bound');
      expect(resolution.effectiveCwd).toBe(projectDir);
      expect(resolution.boundWorkingDir).toBe(projectDir);
    });

    it('should report bound-missing when the bound directory does not exist', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      const removedDir = createProjectDir(opts.workspaceDir, 'vanished');
      pm.use('chat-1', removedDir);
      rmSync(removedDir, { recursive: true });

      const resolution = pm.resolveCwd('chat-1');
      // Distinguishable from unbound — this is the core of #4448
      expect(resolution.reason).toBe('bound-missing');
      expect(resolution.effectiveCwd).toBeUndefined();
      expect(resolution.boundWorkingDir).toBe(removedDir);
    });

    it('createCwdProvider should stay consistent with resolveCwd', () => {
      const opts = createOptions();
      const projectDir = join(opts.workspaceDir, 'existing');
      mkdirSync(projectDir, { recursive: true });
      const pm = new ProjectManager(opts);
      const cwdProvider = pm.createCwdProvider();

      const removedDir = createProjectDir(opts.workspaceDir, 'vanished');
      pm.use('chat-missing', removedDir);
      rmSync(removedDir, { recursive: true });
      pm.use('chat-bound', projectDir);

      // unbound
      expect(cwdProvider('chat-none')).toBe(pm.resolveCwd('chat-none').effectiveCwd);
      // bound-missing
      expect(cwdProvider('chat-missing')).toBe(pm.resolveCwd('chat-missing').effectiveCwd);
      // bound
      expect(cwdProvider('chat-bound')).toBe(pm.resolveCwd('chat-bound').effectiveCwd);
    });
  });

  describe('persistence', () => {
    it('preserves a legacy polluted binding until reset and supports rebinding an existing directory', () => {
      const opts = createOptions();
      const persistPath = join(opts.workspaceDir, '.disclaude', 'project-bindings.json');
      mkdirSync(join(opts.workspaceDir, '.disclaude'));
      const actualDir = createProjectDir(opts.workspaceDir);
      const polluted = `${actualDir} @_user_1`;
      writeFileSync(persistPath, JSON.stringify({ version: 1, bindings: { 'chat-1': polluted } }));
      const pm = new ProjectManager(opts);
      expect(pm.resolveCwd('chat-1')).toEqual({ reason: 'bound-missing', boundWorkingDir: polluted, effectiveCwd: undefined });
      expect(pm.reset('chat-1').ok).toBe(true);
      expect(pm.resolveCwd('chat-1').reason).toBe('unbound');
      expect(pm.use('chat-1', actualDir).ok).toBe(true);
      expect(new ProjectManager(opts).resolveCwd('chat-1').effectiveCwd).toBe(actualDir);
    });

    it('should persist and restore bindings', () => {
      const opts = createOptions();
      const pm1 = new ProjectManager(opts);
      pm1.use('chat-1', createProjectDir(opts.workspaceDir, 'project-a'));
      pm1.use('chat-2', createProjectDir(opts.workspaceDir, 'project-b'));

      // Create new instance with same workspace
      const pm2 = new ProjectManager(opts);
      expect(pm2.getActive('chat-1').workingDir).toBe(join(opts.workspaceDir, 'project-a'));
      expect(pm2.getActive('chat-2').workingDir).toBe(join(opts.workspaceDir, 'project-b'));
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
      writeFileSync(
        join(dataDir, 'project-bindings.json'),
        JSON.stringify({
          version: 99,
          bindings: {},
        })
      );

      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').name).toBe('default');
    });

    it('should skip invalid binding entries', () => {
      const opts = createOptions();
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'project-bindings.json'),
        JSON.stringify({
          version: 1,
          bindings: {
            'chat-1': '/valid/path',
            'chat-2': '',
            'chat-3': 123,
          },
        })
      );

      const pm = new ProjectManager(opts);
      expect(pm.getActive('chat-1').workingDir).toBe('/valid/path');
      expect(pm.getActive('chat-2').name).toBe('default');
      expect(pm.getActive('chat-3').name).toBe('default');
    });

    it('should use atomic write-then-rename pattern', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      pm.use('chat-1', createProjectDir(opts.workspaceDir, 'project'));

      // .tmp file should not remain
      const tmpPath = `${pm.getPersistPath()}.tmp`;
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
        const result = pm.use('chat-1', createProjectDir(opts.workspaceDir, 'project'));
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
