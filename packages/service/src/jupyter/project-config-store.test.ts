import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from '@disclaude/core';
import {
  JupyterProjectConfigStore,
  type JupyterNotebookReference,
} from './project-config-store.js';

let root: string;

function reference(overrides?: Partial<JupyterNotebookReference>): JupyterNotebookReference {
  return {
    connectionId: 'jupyter-local',
    serverNamespace: 'server-1',
    documentId: 'doc-1',
    contentPath: 'research/analysis.ipynb',
    lastKnownVersion: 'revision-7',
    ...overrides,
  };
}

function writeConfig(store: JupyterProjectConfigStore, value: unknown): string {
  const raw = JSON.stringify(value);
  fs.mkdirSync(join(root, '.jupyter'), { recursive: true });
  fs.writeFileSync(store.configPath, raw, 'utf8');
  return raw;
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'jupyter-config-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('JupyterProjectConfigStore', () => {
  it('reads an absent config without creating files or directories', () => {
    const store = new JupyterProjectConfigStore(root);
    expect(store.listNotebookReferences()).toEqual({ ok: true, data: [] });
    expect(store.unlinkNotebook(reference())).toEqual({ ok: true, data: false });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('loads a manually authored Project-local config without ProjectManager', () => {
    const store = new JupyterProjectConfigStore(root);
    writeConfig(store, { version: 1, notebooks: [reference()] });
    expect(store.listNotebookReferences()).toEqual({ ok: true, data: [reference()] });
    expect(fs.existsSync(join(root, '.disclaude'))).toBe(false);
    expect(fs.existsSync(join(root, 'research/analysis.ipynb'))).toBe(false);
  });

  it('uses the active directory across chats and isolates a different Project', () => {
    const pm = new ProjectManager({ workspaceDir: root });
    const firstDir = join(root, 'first');
    const secondDir = join(root, 'second');
    pm.use('chat-1', firstDir);
    pm.use('chat-2', firstDir);
    const bindingsPath = join(root, '.disclaude', 'project-bindings.json');
    const bindings = fs.readFileSync(bindingsPath, 'utf8');

    const first = new JupyterProjectConfigStore(pm.getActive('chat-1').workingDir);
    expect(first.linkNotebook(reference())).toEqual({ ok: true, data: reference() });
    expect(first.configPath).toBe(join(firstDir, '.jupyter', 'config.json'));
    expect(JSON.parse(fs.readFileSync(first.configPath, 'utf8'))).toEqual({
      version: 1,
      notebooks: [reference()],
    });
    const restarted = new ProjectManager({ workspaceDir: root });
    const sameProject = new JupyterProjectConfigStore(restarted.getActive('chat-2').workingDir);
    expect(sameProject.listNotebookReferences()).toEqual({ ok: true, data: [reference()] });
    expect(fs.readFileSync(bindingsPath, 'utf8')).toBe(bindings);
    expect(fs.existsSync(join(root, '.disclaude', 'project-jupyter-references.json'))).toBe(false);

    restarted.use('chat-1', secondDir);
    const second = new JupyterProjectConfigStore(restarted.getActive('chat-1').workingDir);
    expect(second.listNotebookReferences()).toEqual({ ok: true, data: [] });
    expect(second.linkNotebook(reference({ documentId: 'second-doc' })).ok).toBe(true);
    expect(sameProject.listNotebookReferences()).toEqual({ ok: true, data: [reference()] });
  });

  it('reloads manual edits and sequential writes from another instance', () => {
    const first = new JupyterProjectConfigStore(root);
    const second = new JupyterProjectConfigStore(root);
    expect(first.linkNotebook(reference()).ok).toBe(true);
    const next = reference({ documentId: 'doc-2', contentPath: 'other.ipynb' });
    expect(second.linkNotebook(next).ok).toBe(true);
    expect(first.listNotebookReferences()).toEqual({ ok: true, data: [reference(), next] });

    writeConfig(first, { version: 1, notebooks: [next] });
    expect(first.listNotebookReferences()).toEqual({ ok: true, data: [next] });
    expect(first.linkNotebook(reference()).ok).toBe(true);
    expect(second.listNotebookReferences()).toEqual({ ok: true, data: [next, reference()] });
  });

  it('carries the references with a moved Project directory', () => {
    const original = join(root, 'original');
    const moved = join(root, 'moved');
    const store = new JupyterProjectConfigStore(original);
    expect(store.linkNotebook(reference()).ok).toBe(true);
    fs.renameSync(original, moved);
    const reopened = new JupyterProjectConfigStore(moved);
    expect(reopened.listNotebookReferences()).toEqual({ ok: true, data: [reference()] });
    expect(fs.readFileSync(reopened.configPath, 'utf8')).not.toContain(original);
  });

  it('keeps equal paths isolated by connection, namespace and stable document ID', () => {
    const store = new JupyterProjectConfigStore(root);
    const entries = [
      reference(),
      reference({ connectionId: 'jupyter-remote' }),
      reference({ serverNamespace: 'server-2' }),
      reference({ documentId: 'doc-copy' }),
    ];
    for (const entry of entries) {
      expect(store.linkNotebook(entry).ok).toBe(true);
    }
    expect(store.listNotebookReferences()).toEqual({ ok: true, data: entries });
  });

  it('refreshes a renamed stable document in place', () => {
    const store = new JupyterProjectConfigStore(root);
    expect(store.linkNotebook(reference()).ok).toBe(true);
    const renamed = reference({
      contentPath: 'archive/renamed.ipynb',
      lastKnownVersion: 'revision-8',
    });
    expect(store.linkNotebook(renamed)).toEqual({ ok: true, data: renamed });
    expect(store.listNotebookReferences()).toEqual({ ok: true, data: [renamed] });
  });

  it('uses the service-scoped Contents path when no document ID is available', () => {
    const store = new JupyterProjectConfigStore(root);
    expect(store.linkNotebook(reference({ documentId: undefined })).ok).toBe(true);
    const refreshed = reference({ documentId: undefined, lastKnownVersion: 'revision-8' });
    expect(store.linkNotebook(refreshed).ok).toBe(true);
    expect(store.listNotebookReferences()).toEqual({ ok: true, data: [refreshed] });
  });

  it('resolves stable identity while preserving current version metadata and rejecting stale paths', () => {
    const store = new JupyterProjectConfigStore(root);
    const unresolved = reference({ documentId: undefined });
    store.linkNotebook(unresolved);
    store.linkNotebook({ ...unresolved, lastKnownVersion: 'fresh-revision' });
    expect(store.resolveNotebook(unresolved, 'resolved-doc')).toMatchObject({ ok: true, data: { documentId: 'resolved-doc', lastKnownVersion: 'fresh-revision' } });
    expect(store.listNotebookReferences()).toMatchObject({ ok: true, data: [{ documentId: 'resolved-doc' }] });
    expect(store.resolveNotebook(unresolved, 'wrong-doc')).toMatchObject({ ok: false });
    expect(store.resolveNotebook(reference({ documentId: 'resolved-doc', contentPath: 'old.ipynb' }), 'resolved-doc')).toMatchObject({ ok: false });
  });

  it('allowlists reference fields on both read and write', () => {
    const store = new JupyterProjectConfigStore(root);
    const extra = {
      ...reference(),
      token: 'secret-token',
      password: 'secret-password',
      notebook: { cells: [{ source: 'private research content' }] },
    };
    writeConfig(store, { version: 1, notebooks: [extra] });
    expect(store.listNotebookReferences()).toEqual({ ok: true, data: [reference()] });
    expect(store.linkNotebook(extra)).toEqual({ ok: true, data: reference() });
    expect(JSON.parse(fs.readFileSync(store.configPath, 'utf8'))).toEqual({
      version: 1,
      notebooks: [reference()],
    });
  });

  it.each([
    '../escape.ipynb',
    '/absolute.ipynb',
    'a//b.ipynb',
    'a/./b.ipynb',
    'a\\b.ipynb',
    'a.txt',
  ])('rejects invalid Contents path %s without writing a config', (contentPath) => {
    const store = new JupyterProjectConfigStore(root);
    expect(store.linkNotebook(reference({ contentPath }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('relative .ipynb path'),
    });
    expect(store.unlinkNotebook(reference({ contentPath })).ok).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([
    { connectionId: 'https://host/?token=secret' },
    { serverNamespace: ' ' },
    { documentId: 'doc\0bad' },
    { lastKnownVersion: '' },
  ])('rejects invalid identifiers %j', (overrides) => {
    const store = new JupyterProjectConfigStore(root);
    expect(store.linkNotebook(reference(overrides)).ok).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('unlinks only reference metadata and leaves existing local files untouched', () => {
    const store = new JupyterProjectConfigStore(root);
    const notebookPath = join(root, 'research', 'analysis.ipynb');
    fs.mkdirSync(join(root, 'research'));
    fs.writeFileSync(notebookPath, 'existing user data', 'utf8');
    expect(store.linkNotebook(reference()).ok).toBe(true);
    expect(store.unlinkNotebook(reference())).toEqual({ ok: true, data: true });
    expect(new JupyterProjectConfigStore(root).listNotebookReferences()).toEqual({
      ok: true,
      data: [],
    });
    expect(store.unlinkNotebook(reference())).toEqual({ ok: true, data: false });
    expect(fs.readFileSync(notebookPath, 'utf8')).toBe('existing user data');
  });

  it.each([
    null,
    { version: 2, notebooks: [] },
    { version: 1, notebooks: {} },
    { version: 1, notebooks: [reference(), reference({ contentPath: '../bad.ipynb' })] },
  ])('reports invalid persisted config and refuses to overwrite it: %j', (config) => {
    const store = new JupyterProjectConfigStore(root);
    const raw = writeConfig(store, config);
    expect(store.listNotebookReferences().ok).toBe(false);
    expect(store.linkNotebook(reference()).ok).toBe(false);
    expect(store.unlinkNotebook(reference()).ok).toBe(false);
    expect(fs.readFileSync(store.configPath, 'utf8')).toBe(raw);
  });

  it('preserves malformed JSON rather than silently starting from an empty config', () => {
    const store = new JupyterProjectConfigStore(root);
    writeConfig(store, {});
    fs.writeFileSync(store.configPath, '{broken', 'utf8');
    expect(store.linkNotebook(reference()).ok).toBe(false);
    expect(fs.readFileSync(store.configPath, 'utf8')).toBe('{broken');
  });

  it.each(['link', 'unlink'] as const)(
    'preserves prior config and cleans up after failed %s',
    (operation) => {
      const store = new JupyterProjectConfigStore(root);
      expect(store.linkNotebook(reference()).ok).toBe(true);
      const raw = fs.readFileSync(store.configPath, 'utf8');
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('simulated replacement failure');
      });
      const result =
        operation === 'link'
          ? store.linkNotebook(reference({ documentId: 'doc-2' }))
          : store.unlinkNotebook(reference());
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining('replacement failure'),
      });
      expect(fs.readFileSync(store.configPath, 'utf8')).toBe(raw);
      expect(store.listNotebookReferences()).toEqual({ ok: true, data: [reference()] });
      expect(fs.readdirSync(join(root, '.jupyter'))).toEqual(['config.json']);
    }
  );

  it('reports filesystem errors without treating them as an absent config', () => {
    const store = new JupyterProjectConfigStore(root);
    fs.mkdirSync(store.configPath, { recursive: true });
    expect(store.listNotebookReferences()).toMatchObject({ ok: false });
    expect(store.linkNotebook(reference()).ok).toBe(false);
    expect(fs.statSync(store.configPath).isDirectory()).toBe(true);
  });
});
