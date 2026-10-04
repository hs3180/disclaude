import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  JupyterCoordinatorClient,
  JupyterExecutionHandle,
  JupyterExecutionObservation,
  JupyterExecutionSubmitRequest,
} from '@disclaude/core';
import { NotebookAgentSession, notebookSessionFactory } from './agent-session.js';
import { JupyterConnections } from './connections.js';
import { JupyterProjectConfigStore } from './project-config-store.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'notebook-agent-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const notebook = {
    identity: { connectionId: 'host', serverNamespace: 'server', documentId: 'doc' },
    contentPath: 'research.ipynb',
  };
  new JupyterProjectConfigStore(root).linkNotebook({
    ...notebook.identity,
    contentPath: notebook.contentPath,
  });
  let current: { ownerId: string; generation: number } | null = null;
  let paused = false;
  let cwd = root;
  let source = 'value = 73';
  const runs = new Map<string, JupyterExecutionObservation>();
  const fake = {
    controlState: vi.fn(() => Promise.resolve({ controller: current, paused })),
    claimControl: vi.fn((_notebook, ownerId: string, expected: number) => {
      current = { ownerId, generation: expected + 1 };
      paused = false;
      return Promise.resolve(current);
    }),
    ensureKernel: vi.fn(() =>
      Promise.resolve({ kernelId: 'kernel', kernelIncarnation: 'incarnation' })
    ),
    describeNotebook: vi.fn(() =>
      Promise.resolve({
        notebook,
        cells: [{ cellId: 'cell', cellType: 'code', sourcePreview: source }],
      })
    ),
    readCell: vi.fn(() =>
      Promise.resolve({
        notebook,
        cellId: 'cell',
        revision: 'revision',
        sourceHash: 'hash',
        source,
      })
    ),
    editCellSource: vi.fn(async (request) => ({
      state: 'applied',
      snapshot: { ...(await fake.readCell()), source: request.source },
    })),
    submit: vi.fn((request: JupyterExecutionSubmitRequest) => {
      const handle: JupyterExecutionHandle = {
        ...request.target,
        requestId: `request:${request.target.runId}`,
      };
      runs.set(handle.runId, { runId: handle.runId, state: 'running', handle });
      return Promise.resolve({ state: 'accepted', handle });
    }),
    getStatus: vi.fn((_notebook, runId: string) =>
      Promise.resolve(runs.get(runId) ?? { runId, state: 'unknown' })
    ),
    stopOwner: vi.fn((_notebook, controller) => {
      if (
        !current ||
        current.ownerId !== controller.ownerId ||
        current.generation !== controller.generation
      ) {
        return Promise.resolve({
          state: 'ownership_lost',
          currentGeneration: current?.generation ?? 0,
        });
      }
      paused = true;
      for (const [runId, run] of runs) {
        if (run.handle && ['queued', 'running', 'stopping'].includes(run.state)) {
          runs.set(runId, { runId, handle: run.handle, state: 'cancelled' });
        }
      }
      return Promise.resolve({ state: 'requested', runIds: [...runs.keys()] });
    }),
    stop: vi.fn(() => Promise.resolve({ state: 'requested' })),
  };
  const connections = new JupyterConnections(join(root, 'not-present.json'), () => ({}));
  vi.spyOn(connections, 'use').mockImplementation(
    async (_id, _namespace, operation) =>
      await operation(fake as unknown as JupyterCoordinatorClient)
  );
  const context = {
    workingDir: root,
    conversationKey: 'chat:thread',
    currentWorkingDir: () => cwd,
  };
  const create = () => new NotebookAgentSession(context, connections, 500);
  const session = create();
  async function execute(name: string, input: Record<string, unknown> = {}) {
    return await session.tools
      .find((tool) => tool.name === name)!
      .execute(input, { signal: new AbortController().signal });
  }
  async function id() {
    const list = (await execute('notebook_list')) as { notebooks: Array<{ notebookId: string }> };
    return list.notebooks[0].notebookId;
  }
  async function submit() {
    return (await execute('notebook_run_cell', {
      notebookId: await id(),
      cellId: 'cell',
      expectedRevision: 'revision',
      sourceHash: 'hash',
      source,
    })) as { state: string; handle: JupyterExecutionHandle };
  }
  return {
    session,
    create,
    fake,
    runs,
    execute,
    id,
    submit,
    setSource: (value: string) => {
      source = value;
    },
    setCwd: (value: string) => {
      cwd = value;
    },
    setOwner: (ownerId: string) => {
      current = { ownerId, generation: 2 };
    },
  };
}

describe('NotebookAgentSession', () => {
  it('adds no native tools or files when the Project has no Notebook', () => {
    const connections = new JupyterConnections('unused', () => ({}));
    expect(
      notebookSessionFactory(connections)({
        workingDir: root,
        conversationKey: 'chat',
        currentWorkingDir: () => root,
      })
    ).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('binds tools only to live authorized references and refreshes human source per message', async () => {
    const f = fixture();
    expect(f.session.tools).toHaveLength(8);
    await expect(
      f.execute('notebook_read_cell', { notebookId: 'unbound', cellId: 'cell' })
    ).rejects.toThrow('not authorized');
    expect(f.fake.readCell).not.toHaveBeenCalled();
    expect(await f.session.messageContext()).toContain('value = 73');
    f.setSource('human_parameter = 91');
    expect(await f.session.messageContext()).toContain('human_parameter = 91');
  });

  it('preserves owner and run metadata across session recreation and stops idle background execution', async () => {
    const f = fixture();
    const submitted = await f.submit();
    const alias = await f.id();
    expect(submitted.state).toBe('accepted');
    f.session.dispose();
    const resumed = f.create();
    expect(await resumed.stop()).toEqual([{ runId: submitted.handle.runId, state: 'cancelled' }]);
    expect(f.fake.stopOwner).toHaveBeenCalledOnce();
    expect(f.fake.stop).not.toHaveBeenCalled();
    const fresh = f.create();
    const { tools } = fresh;
    await tools
      .find((tool) => tool.name === 'notebook_run_cell')!
      .execute(
        {
          notebookId: alias,
          cellId: 'cell',
          expectedRevision: 'revision',
          sourceHash: 'hash',
          source: 'value = 73',
        },
        { signal: new AbortController().signal }
      );
    expect(f.fake.claimControl.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    expect(f.fake.ensureKernel.mock.calls).toHaveLength(2);
    await expect(f.execute('notebook_list')).rejects.toThrow('stopped');
  });

  it('keeps unknown submission identity and prevents a second execution', async () => {
    const f = fixture();
    f.fake.submit.mockImplementationOnce((request) =>
      Promise.resolve({ state: 'unknown', runId: request.target.runId } as never)
    );
    expect((await f.submit()).state).toBe('unknown');
    expect((await f.submit()).state).toBe('not_started');
    expect(f.fake.submit).toHaveBeenCalledOnce();
    expect(await f.session.messageContext()).toContain('unknown');
  });

  it('never adopts another owner or interrupts after authority changed', async () => {
    const f = fixture();
    const submitted = await f.submit();
    const alias = await f.id();
    f.setOwner('human');
    const stopped = await f.session.stop();
    expect(stopped).toEqual([{ runId: submitted.handle.runId, state: 'ownership_lost' }]);
    expect(f.runs.get(submitted.handle.runId)?.state).toBe('running');
    await expect(
      f
        .create()
        .tools.find((tool) => tool.name === 'notebook_edit_cell')!
        .execute({ notebookId: alias, cellId: 'cell' }, { signal: new AbortController().signal })
    ).rejects.toThrow();
  });

  it('takes control only through an explicit exact owner/generation handoff', async () => {
    const f = fixture();
    const alias = await f.id();
    f.setOwner('human');
    const described = await f.execute('notebook_describe', { notebookId: alias });
    expect(described).toMatchObject({
      control: { controller: { ownerId: 'human', generation: 2 } },
    });
    await expect(f.submit()).rejects.toThrow('could not be verified');
    expect(f.fake.claimControl).not.toHaveBeenCalled();
    const taken = await f.execute('notebook_take_control', {
      notebookId: alias,
      expectedOwnerId: 'human',
      expectedGeneration: 2,
    });
    expect(taken).toMatchObject({ state: 'claimed', controller: { generation: 3 } });
    expect(f.fake.claimControl).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^disclaude:/),
      2
    );
    expect((await f.submit()).state).toBe('accepted');
    expect(f.fake.stopOwner).not.toHaveBeenCalled();
    expect(f.fake.stop).not.toHaveBeenCalled();
  });

  it('rejects stale handoff intent and leaves the human controller intact', async () => {
    const f = fixture();
    const alias = await f.id();
    f.setOwner('human');
    for (const [expectedOwnerId, expectedGeneration] of [
      ['other', 2],
      ['human', 1],
    ] as const) {
      await expect(
        f.execute('notebook_take_control', {
          notebookId: alias,
          expectedOwnerId,
          expectedGeneration,
        })
      ).rejects.toThrow('control changed');
    }
    expect(f.fake.claimControl).not.toHaveBeenCalled();
  });

  it('rejects invalid numeric generations before any control request', async () => {
    const f = fixture();
    const alias = await f.id();
    for (const expectedGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        f.execute('notebook_take_control', {
          notebookId: alias,
          expectedOwnerId: '',
          expectedGeneration,
        })
      ).rejects.toThrow('exact observed generation');
    }
    expect(f.fake.controlState).not.toHaveBeenCalled();
    expect(f.fake.claimControl).not.toHaveBeenCalled();
  });

  it('keeps unconfirmed runs and server-side active-run rejection as handoff barriers', async () => {
    const f = fixture();
    const alias = await f.id();
    const submitted = await f.submit();
    f.setOwner('human');
    await expect(
      f.execute('notebook_take_control', {
        notebookId: alias,
        expectedOwnerId: 'human',
        expectedGeneration: 2,
      })
    ).rejects.toThrow('require reconciliation');
    f.runs.set(submitted.handle.runId, {
      runId: submitted.handle.runId,
      state: 'completed',
      handle: submitted.handle,
    });
    await f.execute('notebook_execution_status', {
      notebookId: alias,
      runId: submitted.handle.runId,
    });
    f.fake.claimControl.mockRejectedValueOnce(new Error('active human experiment; secret=hidden'));
    await expect(
      f.execute('notebook_take_control', {
        notebookId: alias,
        expectedOwnerId: 'human',
        expectedGeneration: 2,
      })
    ).rejects.toThrow('could not be verified');
    expect(f.fake.stopOwner).not.toHaveBeenCalled();
    expect(f.fake.stop).not.toHaveBeenCalled();
  });

  it('fences explicit handoff after pause and checks cancellation before claim', async () => {
    const f = fixture();
    const alias = await f.id();
    f.setOwner('human');
    const abort = new AbortController();
    f.fake.controlState.mockImplementationOnce(() => {
      abort.abort();
      return Promise.resolve({ controller: { ownerId: 'human', generation: 2 }, paused: false });
    });
    await expect(
      f.session.tools
        .find((tool) => tool.name === 'notebook_take_control')!
        .execute(
          {
            notebookId: alias,
            expectedOwnerId: 'human',
            expectedGeneration: 2,
          },
          { signal: abort.signal }
        )
    ).rejects.toThrow();
    f.session.pause();
    await expect(
      f.execute('notebook_take_control', {
        notebookId: alias,
        expectedOwnerId: 'human',
        expectedGeneration: 2,
      })
    ).rejects.toThrow('stopped');
    expect(f.fake.claimControl).not.toHaveBeenCalled();
  });

  it('tracks a late verified handoff for stop without allowing the old callback to continue', async () => {
    const f = fixture();
    const alias = await f.id();
    f.setOwner('human');
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = f.fake.claimControl.getMockImplementation()!;
    f.fake.claimControl.mockImplementationOnce((notebook, owner, generation) =>
      barrier.then(() => claim(notebook, owner, generation))
    );
    const taking = f.execute('notebook_take_control', {
      notebookId: alias,
      expectedOwnerId: 'human',
      expectedGeneration: 2,
    });
    const rejected = expect(taking).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(f.fake.claimControl).toHaveBeenCalledOnce());
    const stopping = f.session.stop();
    release();
    await rejected;
    await stopping;
    expect(f.fake.stopOwner).toHaveBeenCalledWith(expect.anything(), {
      ownerId: expect.stringMatching(/^disclaude:/),
      generation: 3,
    });
    expect(f.fake.submit).not.toHaveBeenCalled();
    expect(f.fake.stop).not.toHaveBeenCalled();
  });

  it('fences tools after Project changes and redacts host failures', async () => {
    const f = fixture();
    const alias = await f.id();
    f.fake.describeNotebook.mockRejectedValueOnce(new Error('token=host-secret'));
    await expect(f.execute('notebook_describe', { notebookId: alias })).rejects.toThrow(
      'operation could not be verified'
    );
    f.setCwd(tmpdir());
    await expect(
      f.execute('notebook_read_cell', { notebookId: alias, cellId: 'cell' })
    ).rejects.toThrow('Project changed');
  });
});
