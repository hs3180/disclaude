/**
 * Unit tests for ProjectManager — chatId → workingDir binding with template/instance support.
 *
 * Tests cover:
 * - Binding (use/reset)
 * - getActive() default and bound behavior
 * - Path resolution (relative/absolute)
 * - Path traversal protection
 * - CwdProvider factory
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Template/Instance model (create, use by name, list)
 * - Edge cases (empty inputs, re-binding, reserved names, etc.)
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (template/instance model)
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

/** Create a packageDir with a template CLAUDE.md */
function createPackageDir(templateName = 'research'): string {
  const packageDir = createTempDir();
  const templateDir = join(packageDir, 'templates', templateName);
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, 'CLAUDE.md'), '# Research Mode\n\nYou are in research mode.');
  return packageDir;
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

    it('should load templates from config', () => {
      const opts = createOptions({
        projectTemplates: {
          research: { displayName: 'Research', description: 'Research mode' },
        },
      });
      const pm = new ProjectManager(opts);

      const templates = pm.listTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('research');
      expect(templates[0].displayName).toBe('Research');
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

    it('should return instance info for template-bound chatId', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');
      const active = pm.getActive('chat-1');

      expect(active.name).toBe('my-research');
      expect(active.templateName).toBe('research');
      expect(active.workingDir).toContain('projects/my-research');
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
        expect(result.error).toContain('实例名');
      }
    });

    it('should reject whitespace-only workingDir', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      const result = pm.use('chat-1', '   ');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('实例名');
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

    it('should bind to existing instance by name', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');
      // chat-2 binds to existing instance
      const result = pm.use('chat-2', 'my-research');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-research');
        expect(result.data.templateName).toBe('research');
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

    it('should reset template-based binding', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');
      expect(pm.getActive('chat-1').name).toBe('my-research');

      const result = pm.reset('chat-1');
      expect(result.ok).toBe(true);
      expect(pm.getActive('chat-1').name).toBe('default');
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

    it('should return instance workingDir for template-bound chatId', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');
      const cwdProvider = pm.createCwdProvider();
      expect(cwdProvider('chat-1')).toContain('projects/my-research');
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

    it('should persist and restore instances', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm1 = new ProjectManager(opts);
      pm1.create('chat-1', 'research', 'my-research');

      // Create new instance with same workspace + templates
      const pm2 = new ProjectManager(opts);
      const active = pm2.getActive('chat-1');
      expect(active.name).toBe('my-research');
      expect(active.templateName).toBe('research');
    });

    it('should persist projects.json with correct schema', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);
      pm.create('chat-1', 'research', 'my-research');

      const projectsPath = pm.getProjectsPath();
      expect(existsSync(projectsPath)).toBe(true);

      const data = JSON.parse(readFileSync(projectsPath, 'utf8'));
      expect(data.version).toBe(2);
      expect(data.instances['my-research']).toBeDefined();
      expect(data.instances['my-research'].templateName).toBe('research');
      expect(data.chatProjectMap['chat-1']).toBe('my-research');
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
  // Template/Instance Model (Issue #1916)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('create()', () => {
    it('should create instance from template and bind to chatId', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'research', 'my-research');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-research');
        expect(result.data.templateName).toBe('research');
        expect(result.data.workingDir).toContain('projects/my-research');
      }
    });

    it('should copy CLAUDE.md from template to instance workingDir', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');

      const active = pm.getActive('chat-1');
      expect(existsSync(join(active.workingDir, 'CLAUDE.md'))).toBe(true);

      const content = readFileSync(join(active.workingDir, 'CLAUDE.md'), 'utf8');
      expect(content).toContain('Research Mode');
    });

    it('should reject unknown template', () => {
      const opts = createOptions({
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'nonexistent', 'my-instance');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不存在');
      }
    });

    it('should reject reserved name "default"', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'research', 'default');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('保留名');
      }
    });

    it('should reject duplicate instance name', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');
      const result = pm.create('chat-2', 'research', 'my-research');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('已存在');
      }
    });

    it('should reject invalid instance name with special chars', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'research', 'my research');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('字母、数字');
      }
    });

    it('should reject empty instance name', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'research', '');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('不能为空');
      }
    });

    it('should reject too long instance name', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const longName = 'a'.repeat(65);
      const result = pm.create('chat-1', 'research', longName);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('过长');
      }
    });

    it('should reject empty chatId', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('', 'research', 'my-research');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('chatId');
      }
    });

    it('should fail gracefully when packageDir not configured', () => {
      const opts = createOptions({
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'research', 'my-research');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('packageDir');
      }
    });

    it('should rollback on CLAUDE.md copy failure', () => {
      const packageDir = createTempDir(); // no templates dir
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'research', 'my-research');
      expect(result.ok).toBe(false);

      // Instance should not be registered
      expect(pm.listInstances()).toHaveLength(0);
    });

    it('should accept valid names with hyphens and underscores', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      const result = pm.create('chat-1', 'research', 'my_research-v2');
      expect(result.ok).toBe(true);
    });
  });

  describe('listTemplates()', () => {
    it('should return empty array when no templates configured', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      expect(pm.listTemplates()).toEqual([]);
    });

    it('should return all configured templates', () => {
      const opts = createOptions({
        projectTemplates: {
          research: { displayName: 'Research' },
          'book-reader': { description: 'Book reading assistant' },
        },
      });
      const pm = new ProjectManager(opts);

      const templates = pm.listTemplates();
      expect(templates).toHaveLength(2);
      expect(templates.find(t => t.name === 'research')?.displayName).toBe('Research');
      expect(templates.find(t => t.name === 'book-reader')?.description).toBe('Book reading assistant');
    });
  });

  describe('listInstances()', () => {
    it('should return empty array when no instances', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      expect(pm.listInstances()).toEqual([]);
    });

    it('should return all instances with binding info', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');
      pm.create('chat-2', 'research', 'deep-dive');

      const instances = pm.listInstances();
      expect(instances).toHaveLength(2);

      const myResearch = instances.find(i => i.name === 'my-research');
      expect(myResearch).toBeDefined();
      expect(myResearch!.templateName).toBe('research');
      expect(myResearch!.chatIds).toEqual(['chat-1']);
      expect(myResearch!.workingDir).toContain('projects/my-research');
      expect(myResearch!.createdAt).toBeTruthy();
    });

    it('should show multiple chatIds for shared instance', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'shared-research');
      pm.use('chat-2', 'shared-research');

      const instances = pm.listInstances();
      const shared = instances.find(i => i.name === 'shared-research');
      expect(shared!.chatIds).toEqual(expect.arrayContaining(['chat-1', 'chat-2']));
    });
  });

  describe('use() with instance name', () => {
    it('should prefer instance lookup over path when name matches', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'my-research');
      const result = pm.use('chat-2', 'my-research');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.templateName).toBe('research');
      }
    });

    it('should allow multiple chatIds to share an instance', () => {
      const packageDir = createPackageDir();
      const opts = createOptions({
        packageDir,
        projectTemplates: { research: {} },
      });
      const pm = new ProjectManager(opts);

      pm.create('chat-1', 'research', 'shared');
      pm.use('chat-2', 'shared');
      pm.use('chat-3', 'shared');

      expect(pm.getActive('chat-1').name).toBe('shared');
      expect(pm.getActive('chat-2').name).toBe('shared');
      expect(pm.getActive('chat-3').name).toBe('shared');
      expect(pm.getActive('chat-1').workingDir).toBe(pm.getActive('chat-2').workingDir);
    });
  });

  describe('zero-config compatibility', () => {
    it('should work identically to simplified mode when no templates configured', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);

      // All the simplified mode operations should still work
      expect(pm.getActive('chat-1').name).toBe('default');
      expect(pm.listTemplates()).toEqual([]);
      expect(pm.listInstances()).toEqual([]);

      const useResult = pm.use('chat-1', '/some/path');
      expect(useResult.ok).toBe(true);
      expect(pm.getActive('chat-1').workingDir).toBe('/some/path');

      const resetResult = pm.reset('chat-1');
      expect(resetResult.ok).toBe(true);
      expect(pm.getActive('chat-1').name).toBe('default');
    });
  });
});
