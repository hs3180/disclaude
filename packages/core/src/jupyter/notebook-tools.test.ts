import { describe, expect, it, vi } from 'vitest';
import { createNotebookTools, type NotebookToolBinding } from './notebook-tools.js';
import type { JupyterExecutionHandle } from './contracts.js';

function fixture() {
  const notebook = {
    identity: { connectionId: 'remote', serverNamespace: 'research', documentId: 'doc-1' },
    contentPath: 'research/report.ipynb',
  };
  const controller = { ownerId: 'owner-1', generation: 1 };
  const handle: JupyterExecutionHandle = {
    notebook,
    cellId: 'cell-1',
    expectedRevision: 'rev-1',
    sourceHash: 'source-1',
    kernelId: 'kernel-1',
    kernelIncarnation: 'incarnation-1',
    runId: 'run-1',
    controller,
    requestId: 'request-1',
  };
  const binding: NotebookToolBinding = {
    notebook,
    documents: {
      readCell: vi.fn().mockResolvedValue({
        notebook,
        cellId: 'cell-1',
        revision: 'rev-1',
        sourceHash: 'source-1',
        source: 'print(1)',
      }),
      editCellSource: vi.fn().mockResolvedValue({
        state: 'conflict',
        current: {
          notebook,
          cellId: 'cell-1',
          revision: 'rev-human',
          sourceHash: 'human',
          source: 'print(2)',
        },
      }),
    },
    executions: {
      submit: vi
        .fn()
        .mockResolvedValue({ state: 'unknown', runId: 'ambiguous', reason: 'connection lost' }),
      getStatus: vi.fn().mockResolvedValue({ runId: 'run-1', state: 'running', handle }),
      stop: vi.fn().mockResolvedValue({ state: 'requested' }),
    },
    controller: vi.fn().mockResolvedValue(controller),
    kernel: vi.fn().mockResolvedValue({ kernelId: 'kernel-1', kernelIncarnation: 'incarnation-1' }),
  };
  const tools = new Map(createNotebookTools(binding).map((tool) => [tool.name, tool]));
  const { signal } = new AbortController();
  const execute = (name: string, args: Record<string, unknown>) =>
    tools.get(name)!.execute(args, { signal });
  return { binding, controller, handle, tools, execute };
}

describe('Harness-independent Notebook tools', () => {
  it('reads the authorized live cell with stable service and document identity', async () => {
    const f = fixture();
    await f.execute('notebook_read_cell', { cellId: 'cell-1' });
    expect(f.binding.documents.readCell).toHaveBeenCalledWith(f.binding.notebook, 'cell-1');
  });

  it('preserves a conflict snapshot and binds host authority to the edit', async () => {
    const f = fixture();
    const result = await f.execute('notebook_edit_cell', {
      cellId: 'cell-1',
      expectedRevision: 'rev-1',
      expectedSourceHash: 'source-1',
      source: '',
      controller: { ownerId: 'model-chosen', generation: 999 },
    });
    expect(result).toMatchObject({ state: 'conflict', current: { source: 'print(2)' } });
    expect(f.binding.documents.editCellSource).toHaveBeenCalledWith({
      notebook: f.binding.notebook,
      cellId: 'cell-1',
      expectedRevision: 'rev-1',
      expectedSourceHash: 'source-1',
      source: '',
      controller: f.controller,
    });
  });

  it('creates a business run ID and preserves ambiguous submission without retry', async () => {
    const f = fixture();
    const result = await f.execute('notebook_run_cell', {
      cellId: 'cell-1',
      expectedRevision: 'rev-1',
      sourceHash: 'source-1',
      source: 'print(1)',
    });
    expect(result).toEqual({ state: 'unknown', runId: 'ambiguous', reason: 'connection lost' });
    expect(f.binding.executions.submit).toHaveBeenCalledTimes(1);
    expect(f.binding.executions.submit).toHaveBeenCalledWith({
      target: {
        ...f.handle,
        requestId: undefined,
        runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
      source: 'print(1)',
    });
  });

  it('uses current authority to stop a stored run and leaves acknowledgment nonterminal', async () => {
    const f = fixture();
    vi.mocked(f.binding.controller).mockResolvedValue({ ownerId: 'owner-2', generation: 2 });
    expect(await f.execute('notebook_stop_execution', { runId: 'run-1' })).toEqual({
      state: 'requested',
    });
    expect(f.binding.executions.stop).toHaveBeenCalledWith(f.handle, {
      ownerId: 'owner-2',
      generation: 2,
    });
  });

  it('does not invent a stop target when the original submission is unknown', async () => {
    const f = fixture();
    vi.mocked(f.binding.executions.getStatus).mockResolvedValue({
      runId: 'run-1',
      state: 'unknown',
      reason: 'request identity missing',
    });
    expect(await f.execute('notebook_stop_execution', { runId: 'run-1' })).toEqual({
      state: 'unknown',
      reason: 'request identity missing',
    });
    expect(f.binding.executions.stop).not.toHaveBeenCalled();
  });

  it('rejects a status handle belonging to a different Notebook', async () => {
    const f = fixture();
    vi.mocked(f.binding.executions.getStatus).mockResolvedValue({
      runId: 'run-1',
      state: 'running',
      handle: {
        ...f.handle,
        notebook: {
          ...f.binding.notebook,
          identity: {
            ...f.binding.notebook.identity,
            documentId: 'other-document',
          },
        },
      },
    });
    expect(await f.execute('notebook_stop_execution', { runId: 'run-1' })).toMatchObject({
      state: 'unknown',
      reason: 'Execution identity does not match the bound Notebook',
    });
    expect(f.binding.executions.stop).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after asynchronous authority lookup before a write', async () => {
    const f = fixture();
    const abort = new AbortController();
    vi.mocked(f.binding.controller).mockImplementation(() => {
      abort.abort(new Error('ownership handoff'));
      return Promise.resolve(f.controller);
    });
    await expect(
      f.tools.get('notebook_edit_cell')!.execute(
        {
          cellId: 'cell-1',
          expectedRevision: 'rev-1',
          expectedSourceHash: 'source-1',
          source: 'print(3)',
        },
        { signal: abort.signal }
      )
    ).rejects.toThrow('ownership handoff');
    expect(f.binding.documents.editCellSource).not.toHaveBeenCalled();
  });
});
