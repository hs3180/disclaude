import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatalayerRunStore } from './datalayer-run-store.js';

const directories: string[] = [];
const directory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-datalayer-journal-'));
  directories.push(root);
  return root;
};
afterEach(() => {
  for (const root of directories.splice(0)) {
    fs.rmSync(root, { recursive: true });
  }
});
const target = {
  connectionId: 'owned',
  serverNamespace: 'configured',
  contentPath: 'analysis.ipynb',
  documentId: 'doc',
  cellId: 'cell',
  sourceHash: 'a'.repeat(64),
  kernelId: 'kernel',
};

describe('Datalayer original-request journal', () => {
  it('retains a pre-submit reservation across a new host instance without claiming it never started', () => {
    const root = directory();
    new DatalayerRunStore(root).reserve('lost-response', target);
    const recovered = new DatalayerRunStore(root).get('lost-response');
    expect(recovered).toMatchObject({ state: 'submitting', target });
    expect(recovered?.handle).toBeUndefined();
  });

  it('persists a consumed terminal result and refuses to replace it with a later 404', () => {
    const root = directory();
    const store = new DatalayerRunStore(root);
    store.reserve('original', target);
    store.update('original', {
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    });
    store.update('original', {
      state: 'completed',
      observation: {
        state: 'completed',
        result: { outputs: [{ output_type: 'stream', text: '42' }] },
      },
    });
    new DatalayerRunStore(root).update('original', { state: 'unknown' });
    expect(store.get('original')).toMatchObject({
      state: 'completed',
      handle: { requestId: 'original-request' },
      observation: { result: { outputs: [{ text: '42' }] } },
    });
    expect(fs.statSync(store.path).mode & 0o077).toBe(0);
  });

  it('does not let a run ID designate different source or a different notebook', () => {
    const store = new DatalayerRunStore(directory());
    store.reserve('run', target);
    expect(() => store.reserve('run', { ...target, documentId: 'another' })).toThrow(
      'another execution target'
    );
    expect(() => store.reserve('run', { ...target, sourceHash: 'b'.repeat(64) })).toThrow(
      'another execution target'
    );
  });

  it('keeps the last successful running observation when a lookup loses connection', () => {
    const root = directory();
    const store = new DatalayerRunStore(root);
    store.reserve('run', target);
    const confirmed = store.update('run', {
      state: 'running',
      observation: { state: 'running', httpStatus: 202 },
    });
    store.update('run', {
      state: 'unknown',
      observation: {
        state: 'unknown',
        failure: { kind: 'client-error', reason: 'connection-unavailable' },
      },
    });
    const restored = new DatalayerRunStore(root).get('run');
    expect(restored).toMatchObject({
      state: 'running',
      observedAt: confirmed.observedAt,
      lastConfirmedRunningAt: confirmed.observedAt,
      lostAt: expect.any(Number),
      observation: { state: 'running', httpStatus: 202 },
      loss: { kind: 'client-error', reason: 'connection-unavailable' },
      lossEvents: [{ kind: 'client-error' }],
    });
    store.update('run', { state: 'completed', observation: { state: 'completed' } });
    expect(store.get('run')?.loss).toBeUndefined();
    expect(store.get('run')?.lastConfirmedRunningAt).toBe(confirmed.observedAt);
  });

  it('reads legacy unknown records without inventing lost running history', () => {
    const store = new DatalayerRunStore(directory());
    store.reserve('legacy', target);
    fs.writeFileSync(
      store.path,
      JSON.stringify({
        version: 1,
        records: [
          {
            runId: 'legacy',
            target,
            state: 'unknown',
            observedAt: 123,
            handle: { kernelId: 'kernel', requestId: 'request' },
            observation: { state: 'unknown', httpStatus: 404 },
          },
        ],
      }),
      { mode: 0o600 }
    );
    const legacy = store.get('legacy');
    expect(legacy).toMatchObject({
      state: 'accepted',
      lostAt: 123,
      loss: { kind: 'server-unknown', reason: 'request-not-found', checkedAt: 123 },
    });
    expect(legacy?.lastConfirmedRunningAt).toBeUndefined();
  });

  it('does not read or write journals through a Project symlink', () => {
    const root = directory();
    const outside = directory();
    fs.symlinkSync(outside, path.join(root, '.jupyter'));
    const store = new DatalayerRunStore(root);
    expect(() => store.reserve('run', target)).toThrow('Unsafe Notebook journal directory');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
