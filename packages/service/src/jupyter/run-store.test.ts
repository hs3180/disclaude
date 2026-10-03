import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JupyterExecutionTarget } from '@disclaude/core';
import { NotebookRunStore } from './run-store.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'notebook-records-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const store = new NotebookRunStore(root, 'chat:thread');
  const owner = store.ownerId();
  const target: JupyterExecutionTarget = {
    notebook: {
      identity: { connectionId: 'host', serverNamespace: 'server', documentId: 'doc' },
      contentPath: 'a.ipynb',
    },
    cellId: 'cell',
    expectedRevision: 'revision',
    sourceHash: 'hash',
    kernelId: 'kernel',
    kernelIncarnation: 'incarnation',
    runId: randomUUID(),
    controller: { ownerId: owner, generation: 1 },
  };
  return { store, target, owner };
}

describe('NotebookRunStore', () => {
  it('persists owner, exact metadata and stop intent through a new instance', () => {
    const { store, target, owner } = fixture();
    store.prepare(target);
    store.requestStop();
    store.observe(target.runId, 'queued', { ...target, requestId: 'request' });
    const reopened = new NotebookRunStore(root, 'chat:thread');
    expect(reopened.ownerId()).toBe(owner);
    expect(reopened.records()[0]).toMatchObject({ state: 'queued', stopRequested: true, target });
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
    expect(new NotebookRunStore(root, 'other-thread').records()).toEqual([]);
    expect(
      JSON.parse(fs.readFileSync(store.path, 'utf8')).runs[target.runId].source
    ).toBeUndefined();
  });

  it('rejects replacement targets and changed native request IDs', () => {
    const { store, target } = fixture();
    store.prepare(target);
    store.observe(target.runId, 'running', { ...target, requestId: 'original' });
    expect(() =>
      store.observe(target.runId, 'completed', { ...target, requestId: 'other' })
    ).toThrow('identity changed');
    expect(() =>
      store.observe(target.runId, 'completed', {
        ...target,
        kernelIncarnation: 'other',
        requestId: 'original',
      })
    ).toThrow('identity changed');
    const records = JSON.parse(fs.readFileSync(store.path, 'utf8'));
    records.runs[target.runId].handle.cellId = 'other';
    fs.writeFileSync(store.path, JSON.stringify(records));
    expect(() => store.records()).toThrow('another target');
  });

  it('preserves unknown attempts and rejects another owner or duplicate run', () => {
    const { store, target } = fixture();
    expect(() =>
      store.prepare({ ...target, controller: { ownerId: 'foreign', generation: 1 } })
    ).toThrow('owner');
    store.prepare(target);
    store.observe(target.runId, 'unknown');
    expect(() => store.prepare(target)).toThrow('run ID');
    expect(new NotebookRunStore(root, 'chat:thread').records()[0].state).toBe('unknown');
  });
});
