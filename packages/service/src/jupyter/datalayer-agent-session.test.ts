import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { YNotebook } from '@jupyter/ydoc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatalayerJupyterClient, ToolContext } from '@disclaude/core';
import { DatalayerNotebookAgentSession } from './datalayer-agent-session.js';
import { DatalayerRunStore } from './datalayer-run-store.js';
import { JupyterProjectConfigStore } from './project-config-store.js';
import type { JupyterConnections } from './connections.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true });
  }
});
const invocation: ToolContext = { signal: new AbortController().signal };

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-datalayer-session-'));
  roots.push(root);
  new JupyterProjectConfigStore(root).linkNotebook({
    connectionId: 'configured',
    serverNamespace: 'host-bound',
    contentPath: 'analysis.ipynb',
  });
  const notebook = new YNotebook();
  notebook.fromJSON({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'code',
        cell_type: 'code',
        metadata: {},
        source: 'print(42)',
        outputs: [],
        execution_count: null,
      },
      { id: 'human', cell_type: 'markdown', metadata: {}, source: 'Preserve my conclusion.' },
    ],
  });
  const doc = {
    notebook,
    documentId: 'doc-id',
    contentPath: 'analysis.ipynb',
    flush: () => Promise.resolve(),
    close: vi.fn(),
    snapshot: () => ({
      documentId: 'doc-id',
      contentPath: 'analysis.ipynb',
      revision: 'revision',
      cells: notebook.cells.map((c) => ({
        ...c.toJSON(),
        source: c.source,
        sourceHash: createHash('sha256').update(c.source).digest('hex'),
      })),
    }),
  };
  const client = {
    openDocument: vi.fn(() => Promise.resolve(doc)),
    notebookEntry: () => 'https://configured.invalid/lab/tree/analysis.ipynb',
    json: vi.fn((route: string) => {
      if (route === 'api/sessions') {
        return Promise.resolve([{ path: 'analysis.ipynb', kernel: { id: 'kernel' } }]);
      }
      if (route === 'api/kernels/kernel') {
        return Promise.resolve({ execution_state: 'idle' });
      }
      throw new Error('Unexpected remote API operation');
    }),
    submitCell: vi.fn(() => Promise.resolve({ state: 'unknown' })),
    observe: vi.fn(() =>
      Promise.resolve({
        state: 'completed',
        result: {
          execution_count: 1,
          outputs: [{ output_type: 'stream', name: 'stdout', text: '42' }],
        },
      })
    ),
    stopRequest: vi.fn(() => Promise.resolve('unsupported')),
  };
  const connections = {
    useDatalayer: <T>(
      _id: string,
      _namespace: string,
      operation: (value: DatalayerJupyterClient) => Promise<T>
    ) => operation(client as unknown as DatalayerJupyterClient),
    redactEnvironment: vi.fn(),
  } as unknown as JupyterConnections;
  const create = () =>
    new DatalayerNotebookAgentSession(
      { workingDir: root, conversationKey: 'conversation', currentWorkingDir: () => root },
      connections
    );
  const session = create();
  const call = (
    owner: DatalayerNotebookAgentSession,
    name: string,
    input: Record<string, unknown>
  ) => owner.tools.find((t) => t.name === name)!.execute(input, invocation);
  const list = (await call(session, 'notebook_list', {})) as {
    notebooks: Array<{ notebookId: string }>;
  };
  const [{ notebookId }] = list.notebooks;
  const cell = (await call(session, 'notebook_read_cell', { notebookId, cellId: 'code' })) as {
    sourceHash: string;
  };
  const args = {
    notebookId,
    cellId: 'code',
    expectedSourceHash: cell.sourceHash,
    runId: 'original',
  };
  return {
    root,
    client,
    notebook,
    session,
    create,
    call,
    args,
    journal: new DatalayerRunStore(root, 'conversation'),
  };
}

describe('Datalayer MVP service boundaries', () => {
  it('persists before POST and never replays an unknown attempt after session recreation', async () => {
    const f = await fixture();
    f.client.submitCell.mockImplementation(() => {
      expect(f.journal.get('original')?.state).toBe('submitting');
      return Promise.resolve({ state: 'unknown' });
    });
    expect(await f.call(f.session, 'notebook_execute', f.args)).toMatchObject({ state: 'unknown' });
    f.session.dispose();
    expect(await f.call(f.create(), 'notebook_execute', f.args)).toMatchObject({
      state: 'unknown',
    });
    expect(f.client.submitCell).toHaveBeenCalledTimes(1);
  });

  it('keeps the accepted original handle when the turn is paused while POST settles', async () => {
    const f = await fixture();
    let accept!: (value: {
      state: string;
      handle: { kernelId: string; requestId: string };
    }) => void;
    f.client.submitCell.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    const pending = f.call(f.session, 'notebook_execute', f.args);
    await vi.waitFor(() => expect(f.client.submitCell).toHaveBeenCalledOnce());
    f.session.pause();
    accept({ state: 'accepted', handle: { kernelId: 'kernel', requestId: 'original-request' } });
    await expect(pending).rejects.toThrow('stopped');
    expect(f.journal.get('original')).toMatchObject({
      state: 'accepted',
      handle: { requestId: 'original-request' },
    });
  });

  it('preserves a confirmed terminal result after another consumer makes upstream GET unavailable', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    const input = { notebookId: f.args.notebookId, runId: 'original' };
    expect(await f.call(f.session, 'notebook_status', input)).toMatchObject({
      state: 'completed',
      result: { outputs: [{ text: '42' }] },
    });
    f.session.dispose();
    expect(await f.call(f.create(), 'notebook_status', input)).toMatchObject({
      state: 'completed',
      result: { outputs: [{ text: '42' }] },
    });
    expect(f.client.observe).toHaveBeenCalledOnce();
  });

  it('refuses stale source and leaves human content intact', async () => {
    const f = await fixture();
    f.notebook.getCell(0).source = 'print(99)';
    expect(await f.call(f.session, 'notebook_execute', f.args)).toMatchObject({
      state: 'conflict',
    });
    expect(f.client.submitCell).not.toHaveBeenCalled();
    expect(f.notebook.getCell(1).source).toBe('Preserve my conclusion.');
  });

  it('reports unsupported stop without an unrelated kernel-wide API call', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    expect(await f.session.stop()).toEqual([{ runId: 'original', state: 'unknown' }]);
    expect(f.client.stopRequest).toHaveBeenCalledWith({
      kernelId: 'kernel',
      requestId: 'original-request',
    });
    expect(f.client.json.mock.calls.every(([route]) => !route.endsWith('/interrupt'))).toBe(true);
  });
});
