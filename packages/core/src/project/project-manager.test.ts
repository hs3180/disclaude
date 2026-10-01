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
import type { ProjectJupyterNotebookReference, ProjectManagerOptions } from './types.js';

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

function jupyterReference(
  overrides?: Partial<ProjectJupyterNotebookReference>
): ProjectJupyterNotebookReference {
  return {
    connectionId: 'jupyter-local',
    serverNamespace: 'server-1',
    documentId: 'doc-1',
    contentPath: 'research/analysis.ipynb',
    lastKnownVersion: 'revision-7',
    ...overrides,
  };
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
      expect(bindings.find((b) => b.chatId === 'chat-1')?.workingDir).toBe('/project-a');
      expect(bindings.find((b) => b.chatId === 'chat-2')?.workingDir).toBe('/project-b');
    });
  });

  describe('Jupyter notebook references (#5217)', () => {
    it('persists references by Project directory and shares them across chats on that Project', () => {
      const opts = createOptions();
      const pm1 = new ProjectManager(opts);
      pm1.use('chat-1', '/projects/research');
      pm1.use('chat-2', '/projects/research');

      expect(pm1.linkJupyterNotebook('chat-1', jupyterReference())).toMatchObject({ ok: true });
      expect(pm1.getJupyterNotebookReferences('chat-2')).toEqual({
        ok: true,
        data: [jupyterReference()],
      });

      const saved = JSON.parse(readFileSync(pm1.getJupyterReferencesPersistPath(), 'utf8'));
      expect(saved.version).toBe(1);
      expect(saved.projects['/projects/research']).toEqual([jupyterReference()]);

      const pm2 = new ProjectManager(opts);
      expect(pm2.getJupyterNotebookReferences('chat-2')).toEqual({
        ok: true,
        data: [jupyterReference()],
      });
    });

    it('keeps the same content path isolated by connection and server namespace', () => {
      const pm = new ProjectManager(createOptions());
      pm.linkJupyterNotebook('chat-1', jupyterReference({ serverNamespace: 'server-a' }));
      pm.linkJupyterNotebook(
        'chat-1',
        jupyterReference({ connectionId: 'jupyter-remote', serverNamespace: 'server-b' })
      );

      expect(pm.getJupyterNotebookReferences('chat-1')).toMatchObject({
        ok: true,
        data: [
          { connectionId: 'jupyter-local', serverNamespace: 'server-a' },
          { connectionId: 'jupyter-remote', serverNamespace: 'server-b' },
        ],
      });
    });

    it('updates a renamed stable document reference in place', () => {
      const pm = new ProjectManager(createOptions());
      pm.linkJupyterNotebook('chat-1', jupyterReference());
      pm.linkJupyterNotebook(
        'chat-1',
        jupyterReference({ contentPath: 'archive/analysis-renamed.ipynb', lastKnownVersion: 'revision-8' })
      );

      expect(pm.getJupyterNotebookReferences('chat-1')).toEqual({
        ok: true,
        data: [
          jupyterReference({
            contentPath: 'archive/analysis-renamed.ipynb',
            lastKnownVersion: 'revision-8',
          }),
        ],
      });
    });

    it('keeps distinct stable document IDs separate even when paths match', () => {
      const pm = new ProjectManager(createOptions());
      pm.linkJupyterNotebook('chat-1', jupyterReference({ documentId: 'doc-original' }));
      pm.linkJupyterNotebook('chat-1', jupyterReference({ documentId: 'doc-replaced' }));

      expect(pm.getJupyterNotebookReferences('chat-1')).toMatchObject({
        ok: true,
        data: [{ documentId: 'doc-original' }, { documentId: 'doc-replaced' }],
      });
    });

    it('stores only allowlisted identity fields and does not persist credentials or notebook content', () => {
      const pm = new ProjectManager(createOptions());
      const reference = {
        ...jupyterReference(),
        token: 'secret-token',
        password: 'secret-password',
        notebook: { cells: [{ source: 'private research content' }] },
      } as unknown as ProjectJupyterNotebookReference;

      const linked = pm.linkJupyterNotebook('chat-1', reference);
      expect(linked).toEqual({ ok: true, data: jupyterReference() });
      const saved = readFileSync(pm.getJupyterReferencesPersistPath(), 'utf8');
      expect(saved).not.toContain('secret-token');
      expect(saved).not.toContain('secret-password');
      expect(saved).not.toContain('private research content');
    });

    it('rejects invalid paths and invalid identifiers', () => {
      const pm = new ProjectManager(createOptions());
      expect(pm.linkJupyterNotebook('chat-1', jupyterReference({ contentPath: '../escape.ipynb' }))).toMatchObject({
        ok: false,
        error: expect.stringContaining('relative .ipynb path'),
      });
      expect(pm.linkJupyterNotebook('chat-1', jupyterReference({ contentPath: '/absolute.ipynb' }))).toMatchObject({
        ok: false,
      });
      expect(pm.linkJupyterNotebook('chat-1', jupyterReference({ serverNamespace: ' ' }))).toMatchObject({
        ok: false,
        error: expect.stringContaining('serverNamespace'),
      });
      expect(
        pm.linkJupyterNotebook('chat-1', jupyterReference({ connectionId: 'https://host/?token=secret' }))
      ).toMatchObject({ ok: false });
    });

    it('unlinks only the Project association and leaves remote identity untouched', () => {
      const pm = new ProjectManager(createOptions());
      pm.linkJupyterNotebook('chat-1', jupyterReference());

      expect(pm.unlinkJupyterNotebook('chat-1', jupyterReference())).toEqual({ ok: true, data: true });
      expect(pm.getJupyterNotebookReferences('chat-1')).toEqual({ ok: true, data: [] });
      expect(pm.unlinkJupyterNotebook('chat-1', jupyterReference())).toEqual({ ok: true, data: false });
    });

    it('does not carry a notebook reference when the chat changes Project', () => {
      const pm = new ProjectManager(createOptions());
      pm.use('chat-1', '/projects/first');
      pm.linkJupyterNotebook('chat-1', jupyterReference());
      pm.use('chat-1', '/projects/second');

      expect(pm.getJupyterNotebookReferences('chat-1')).toEqual({ ok: true, data: [] });
    });

    it('rolls back in-memory updates when reference persistence fails', () => {
      const opts = createOptions();
      const pm = new ProjectManager(opts);
      pm.linkJupyterNotebook('chat-1', jupyterReference());
      mkdirSync(`${pm.getJupyterReferencesPersistPath()}.tmp`);

      const result = pm.linkJupyterNotebook(
        'chat-1',
        jupyterReference({ documentId: 'doc-2', contentPath: 'research/other.ipynb' })
      );

      expect(result).toMatchObject({ ok: false });
      expect(pm.getJupyterNotebookReferences('chat-1')).toEqual({
        ok: true,
        data: [jupyterReference()],
      });
    });

    it('skips invalid persisted references without creating a local notebook copy', () => {
      const opts = createOptions();
      const dataDir = join(opts.workspaceDir, '.disclaude');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'project-jupyter-references.json'),
        JSON.stringify({
          version: 1,
          projects: {
            '/projects/research': [jupyterReference(), jupyterReference({ contentPath: '../bad.ipynb' })],
          },
        })
      );
      const pm = new ProjectManager(opts);
      pm.use('chat-1', '/projects/research');

      expect(pm.getJupyterNotebookReferences('chat-1')).toEqual({
        ok: true,
        data: [jupyterReference()],
      });
      expect(existsSync(join(opts.workspaceDir, 'research/analysis.ipynb'))).toBe(false);
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
      pm.use('chat-1', '/nonexistent/project-dir');

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
      // A path that is almost certainly absent on disk
      pm.use('chat-1', '/nonexistent/project-dir-4448');

      const resolution = pm.resolveCwd('chat-1');
      // Distinguishable from unbound — this is the core of #4448
      expect(resolution.reason).toBe('bound-missing');
      expect(resolution.effectiveCwd).toBeUndefined();
      expect(resolution.boundWorkingDir).toBe('/nonexistent/project-dir-4448');
    });

    it('createCwdProvider should stay consistent with resolveCwd', () => {
      const opts = createOptions();
      const projectDir = join(opts.workspaceDir, 'existing');
      mkdirSync(projectDir, { recursive: true });
      const pm = new ProjectManager(opts);
      const cwdProvider = pm.createCwdProvider();

      pm.use('chat-missing', '/nonexistent/project-dir-4448');
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
      pm.use('chat-1', '/project');

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
