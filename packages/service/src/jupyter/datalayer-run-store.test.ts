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
    new DatalayerRunStore(root, 'conversation').reserve('lost-response', target);
    const recovered = new DatalayerRunStore(root, 'conversation').get('lost-response');
    expect(recovered).toMatchObject({ state: 'submitting', target });
    expect(recovered?.handle).toBeUndefined();
  });

  it('persists a consumed terminal result and refuses to replace it with a later 404', () => {
    const root = directory();
    const store = new DatalayerRunStore(root, 'conversation');
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
    new DatalayerRunStore(root, 'conversation').update('original', { state: 'unknown' });
    expect(store.get('original')).toMatchObject({
      state: 'completed',
      handle: { requestId: 'original-request' },
      observation: { result: { outputs: [{ text: '42' }] } },
    });
    expect(fs.statSync(store.path).mode & 0o077).toBe(0);
  });

  it('does not let a run ID designate different source or a different notebook', () => {
    const store = new DatalayerRunStore(directory(), 'conversation');
    store.reserve('run', target);
    expect(() => store.reserve('run', { ...target, documentId: 'another' })).toThrow(
      'another execution target'
    );
    expect(() => store.reserve('run', { ...target, sourceHash: 'b'.repeat(64) })).toThrow(
      'another execution target'
    );
  });

  it('does not read or write journals through a Project symlink', () => {
    const root = directory();
    const outside = directory();
    fs.symlinkSync(outside, path.join(root, '.jupyter'));
    const store = new DatalayerRunStore(root, 'conversation');
    expect(() => store.reserve('run', target)).toThrow('Unsafe Notebook journal directory');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
