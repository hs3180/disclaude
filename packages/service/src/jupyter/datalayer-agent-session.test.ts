import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { YNotebook } from '@jupyter/ydoc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notebookSnapshotHash,
  type DatalayerJupyterClient,
  type ToolContext,
} from '@disclaude/core';
import type { NotebookAgentContext } from './agent-session.js';
import { DatalayerNotebookAgentSession } from './datalayer-agent-session.js';
import { DatalayerRunStore } from './datalayer-run-store.js';
import { JupyterProjectConfigStore } from './project-config-store.js';
import type { JupyterConnections } from './connections.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
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
    flush: vi.fn(() => Promise.resolve()),
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
    inspectConnection: vi.fn(() =>
      Promise.resolve({
        mcp: { state: 'available' },
        nbmodel: { state: 'available' },
        rtc: { state: 'configured' },
        nbconvert: { state: 'available' },
      })
    ),
    documentPath: vi.fn(() => Promise.resolve('analysis.ipynb')),
    openDocument: vi.fn(() => Promise.resolve(doc)),
    notebookEntry: () => 'https://configured.invalid/lab/tree/analysis.ipynb',
    json: vi.fn(
      (route: string, _method?: string, _body?: Record<string, unknown>): Promise<unknown> => {
        if (route === 'api/sessions') {
          return Promise.resolve([{ path: 'analysis.ipynb', kernel: { id: 'kernel' } }]);
        }
        if (route === 'api/kernels/kernel') {
          return Promise.resolve({ execution_state: 'idle' });
        }
        throw new Error('Unexpected remote API operation');
      }
    ),
    submitCell: vi.fn(() => Promise.resolve({ state: 'unknown' })),
    executionPolicy: vi.fn(() =>
      Promise.resolve({
        serverInstanceId: 'server-instance',
        resultRetentionSeconds: 3600,
        requestQuota: 512,
        inlineResultBytes: 65536,
      })
    ),
    kernelInfo: vi.fn(() =>
      Promise.resolve({ kernelId: 'kernel', incarnation: 'native-instance' })
    ),
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
  const create = (delivery?: NotebookAgentContext['delivery']) =>
    new DatalayerNotebookAgentSession(
      {
        workingDir: root,
        conversationKey: 'conversation',
        currentWorkingDir: () => root,
        delivery,
      },
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
    connections,
    doc,
    notebook,
    session,
    create,
    call,
    args,
    journal: new DatalayerRunStore(root, 'conversation'),
  };
}

describe('Datalayer MVP service boundaries', () => {
  function deliveryFixture(
    f: Awaited<ReturnType<typeof fixture>>,
    serializeNotebook = (content: unknown) => JSON.stringify(content, null, 2)
  ): Map<string, Record<string, unknown>> {
    const saved = new Map<string, Record<string, unknown>>();
    const original = f.client.json.getMockImplementation()!;
    f.client.json.mockImplementation(
      (route: string, method?: string, body?: Record<string, unknown>) => {
        if (!route.startsWith('api/contents/')) {
          return original(route);
        }
        if (method === 'PUT') {
          saved.set(route, structuredClone(body!));
          return Promise.resolve({});
        }
        return Promise.resolve(saved.get(route));
      }
    );
    Object.assign(f.client, {
      response: vi.fn((route: string) =>
        Promise.resolve(
          new Response(
            route === 'nbconvert/html'
              ? '<html><head></head><body>Rendered report</body></html>'
              : route.endsWith('.ipynb')
                ? serializeNotebook(saved.get(route.replace(/^files\//, 'api/contents/'))?.content)
                : String(saved.get(route.replace(/^files\//, 'api/contents/'))?.content),
            { headers: { 'content-type': 'text/html' } }
          )
        )
      ),
      responseText: (response: Response) => response.text(),
      fileEntry: (contentPath: string) => `https://configured.invalid/files/${contentPath}`,
    });
    return saved;
  }

  it('delivers one verified snapshot and image in temporary copies, retaining a concurrent human edit', async () => {
    const f = await fixture();
    deliveryFixture(f);
    const image = Buffer.from('verified image bytes');
    (f.notebook.cells[0] as (typeof f.notebook.cells)[0] & { outputs: unknown[] }).outputs = [
      {
        output_type: 'display_data',
        data: { 'image/png': image.toString('base64') },
        metadata: {},
      },
    ];
    const expected = notebookSnapshotHash(f.notebook.toJSON());
    const delivered: Array<{ file: string; bytes: Buffer }> = [];
    const sendFile = vi.fn((file: string) => {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      delivered.push({ file, bytes: fs.readFileSync(file) });
      f.notebook.cells[1].source = 'New human note while files upload.';
      return Promise.resolve(`message-${delivered.length}`);
    });
    const result = (await f.call(
      f.create(() => ({ sendFile })),
      'notebook_deliver_report',
      { notebookId: f.args.notebookId }
    )) as {
      state: string;
      revision: string;
      artifacts: Array<{ messageId: string; sha256: string }>;
      snapshotState: string;
      liveChangedDuringDelivery: boolean;
    };
    expect(result).toMatchObject({
      state: 'delivered',
      revision: expected,
      snapshotState: 'historical',
      liveChangedDuringDelivery: true,
    });
    expect(result.artifacts.map((a) => a.messageId)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
    expect(notebookSnapshotHash(JSON.parse(delivered[0].bytes.toString()))).toBe(expected);
    expect(delivered[1].bytes.toString()).toContain(`content="${expected}"`);
    expect(delivered[2].bytes).toEqual(image);
    expect(result.artifacts[2].sha256).toBe(createHash('sha256').update(image).digest('hex'));
    expect(
      delivered.every((d) => !fs.existsSync(d.file) && !fs.existsSync(path.dirname(d.file)))
    ).toBe(true);
    expect(fs.readdirSync(f.root).some((name) => name.endsWith('.ipynb'))).toBe(false);
    expect(f.notebook.cells[1].source).toContain('New human note');
    expect(f.client.submitCell).not.toHaveBeenCalled();
  });

  it('delivers the exact saved Notebook bytes after native serialization changes', async () => {
    const f = await fixture();
    f.notebook.cells[0].setMetadata('trusted', true);
    const image = Buffer.from('native image bytes');
    (f.notebook.cells[0] as (typeof f.notebook.cells)[0] & { outputs: unknown[] }).outputs = [
      { output_type: 'stream', name: 'stdout', text: '42\nDone\n' },
      {
        output_type: 'display_data',
        metadata: {},
        data: { 'image/png': image.toString('base64') },
      },
    ];
    let raw = '';
    deliveryFixture(f, (content: unknown) => {
      const saved = structuredClone(content) as { cells: Array<Record<string, unknown>> };
      const [code] = saved.cells;
      delete (code.metadata as Record<string, unknown>).trusted;
      code.source = ['print(', '42)'];
      const outputs = code.outputs as Array<Record<string, unknown>>;
      outputs[0].text = ['42\n', 'Done\n'];
      outputs[1].data = { 'image/png': [image.toString('base64')] };
      raw = `${JSON.stringify(saved, null, 1)}\n`;
      return raw;
    });
    const received: Buffer[] = [];
    const sendFile = vi.fn((file: string) => {
      received.push(fs.readFileSync(file));
      return Promise.resolve(`message-${received.length}`);
    });
    const result = await f.call(
      f.create(() => ({ sendFile })),
      'notebook_deliver_report',
      {
        notebookId: f.args.notebookId,
      }
    );
    expect(result).toMatchObject({
      state: 'delivered',
      revisionAlgorithm: 'nbformat-content-sha256-v2',
    });
    expect(received[0]).toEqual(Buffer.from(raw));
    expect(received[2]).toEqual(image);
    expect(f.notebook.cells[0].getMetadata('trusted')).toBe(true);
    expect(f.client.submitCell).not.toHaveBeenCalled();
  });

  it('retains confirmed delivery IDs, stops on an uncertain send, and never retries it', async () => {
    const f = await fixture();
    deliveryFixture(f);
    const files: string[] = [];
    const sendFile = vi.fn((file: string) => {
      files.push(file);
      return files.length === 1
        ? Promise.resolve('confirmed-ipynb')
        : Promise.reject(new Error('accepted reply lost'));
    });
    const result = await f.call(
      f.create(() => ({ sendFile })),
      'notebook_deliver_report',
      { notebookId: f.args.notebookId }
    );
    expect(result).toMatchObject({
      state: 'partial_or_unknown',
      artifacts: [{ kind: 'ipynb', messageId: 'confirmed-ipynb' }],
      unconfirmedArtifact: { kind: 'html' },
    });
    expect(sendFile).toHaveBeenCalledTimes(2);
    expect(files.every((file) => !fs.existsSync(path.dirname(file)))).toBe(true);
  });

  it('bounds raster previews while preserving complete outputs and does not invent delivery IDs', async () => {
    const f = await fixture();
    deliveryFixture(f);
    const outputs = [
      ...Array.from({ length: 6 }, () => ({
        output_type: 'display_data',
        data: { 'image/png': Buffer.from('small image').toString('base64') },
        metadata: {},
      })),
      {
        output_type: 'display_data',
        data: { 'image/png': Buffer.alloc(1_500_003).toString('base64') },
        metadata: {},
      },
    ];
    (f.notebook.cells[0] as (typeof f.notebook.cells)[0] & { outputs: unknown[] }).outputs =
      outputs;
    const sendFile = vi.fn((file: string) => {
      if (file.endsWith('.ipynb')) {
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).cells[0].outputs).toHaveLength(7);
      }
      return Promise.resolve();
    });
    const result = await f.call(
      f.create(() => ({ sendFile })),
      'notebook_deliver_report',
      { notebookId: f.args.notebookId }
    );
    expect(result).toMatchObject({ state: 'acknowledged_without_message_ids', omittedImages: 3 });
    expect(sendFile).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(result)).not.toContain('messageId');
  });

  it('reports unavailable channel delivery before exporting and rejects altered snapshots before sending', async () => {
    const f = await fixture();
    expect(
      await f.call(f.session, 'notebook_deliver_report', { notebookId: f.args.notebookId })
    ).toMatchObject({ state: 'unsupported' });
    deliveryFixture(f, () => JSON.stringify({ metadata: { changed: true }, cells: [] }));
    const sendFile = vi.fn();
    await expect(
      f.call(
        f.create(() => ({ sendFile })),
        'notebook_deliver_report',
        { notebookId: f.args.notebookId }
      )
    ).rejects.toThrow('snapshot cannot be verified');
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('does not send artifacts when the saved Notebook download fails', async () => {
    const f = await fixture();
    deliveryFixture(f);
    Object.assign(f.client, {
      response: vi.fn((route: string) =>
        Promise.resolve(
          route === 'nbconvert/html'
            ? new Response('<html><head></head><body>Report</body></html>', {
                headers: { 'content-type': 'text/html' },
              })
            : new Response('Unavailable', { status: 503 })
        )
      ),
    });
    const sendFile = vi.fn();
    await expect(
      f.call(f.create(() => ({ sendFile })), 'notebook_deliver_report', {
        notebookId: f.args.notebookId,
      })
    ).rejects.toThrow('Exported Notebook cannot be downloaded');
    expect(sendFile).not.toHaveBeenCalled();
    expect(f.client.submitCell).not.toHaveBeenCalled();
  });

  it('observes a native image with provenance and marks a later source edit historical', async () => {
    const f = await fixture();
    const [cell] = f.notebook.cells;
    const sourceHash = createHash('sha256').update(cell.source).digest('hex');
    cell.setMetadata('jupyter_server_nbmodel_provenance', {
      sourceHash,
      requestId: 'image-original',
    });
    (cell as typeof cell & { outputs: unknown[] }).outputs = [
      {
        output_type: 'display_data',
        data: { 'image/png': Buffer.from('png bytes').toString('base64') },
        metadata: {},
      },
    ];
    const input = { notebookId: f.args.notebookId, cellId: 'code', outputIndex: 0 };
    expect(await f.call(f.session, 'notebook_observe_image', input)).toMatchObject({
      format: 'disclaude.tool-result.v1',
      data: {
        outputState: 'current',
        outputRequestId: 'image-original',
        executedSourceHash: sourceHash,
      },
      images: [{ mimeType: 'image/png' }],
    });
    cell.source = 'print("changed after completion")';
    expect(
      await f.call(f.session, 'notebook_read_cell', {
        notebookId: input.notebookId,
        cellId: 'code',
      })
    ).toMatchObject({ outputState: 'historical', executedSourceHash: sourceHash });
    expect(await f.call(f.session, 'notebook_observe_image', input)).toMatchObject({
      data: { outputState: 'historical' },
    });
    await expect(
      f.call(f.session, 'notebook_observe_image', { ...input, outputIndex: 1 })
    ).rejects.toThrow('index');
  });

  it('imports only registered user attachments with a remote path and verified repeat lookup', async () => {
    const f = await fixture();
    const localPath = path.join(f.root, 'data.csv');
    const content = 'value\n3\n7\n';
    fs.writeFileSync(localPath, content);
    f.session.registerAttachments([
      { id: 'input-csv', fileName: '../../data.csv', localPath, source: 'user', createdAt: 1 },
    ]);
    const files = new Map<string, Record<string, unknown>>();
    const response = vi.fn((route: string) => {
      const value = files.get(route.split('?')[0]);
      return Promise.resolve(
        new Response(value ? JSON.stringify(value) : '{}', { status: value ? 200 : 404 })
      );
    });
    Object.assign(f.client, { response, responseText: (value: Response) => value.text() });
    Object.assign(f.client, {
      json: vi.fn((route: string, method?: string, body?: Record<string, unknown>) => {
        expect(method).toBe('PUT');
        files.set(route, { ...body });
        return Promise.resolve({ path: route });
      }),
    });
    const input = { notebookId: f.args.notebookId, attachmentId: 'input-csv' };
    const imported = (await f.call(f.session, 'notebook_import_file', input)) as {
      remotePath: string;
      kernelRelativePath: string;
      sha256: string;
    };
    expect(imported).toMatchObject({
      state: 'imported',
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    expect(imported.kernelRelativePath).toBe(imported.remotePath);
    expect(imported.remotePath).toMatch(/^disclaude-inputs-doc-id\/[a-f0-9]{64}-data.csv$/);
    expect(await f.call(f.session, 'notebook_import_file', input)).toMatchObject({
      state: 'existing',
      remotePath: imported.remotePath,
    });
    expect(f.client.json).toHaveBeenCalledTimes(2);
    const context = await f.session.messageContext();
    expect(context).toContain('input-csv');
    expect(context).not.toContain(localPath);
    await expect(
      f.call(f.session, 'notebook_import_file', { ...input, attachmentId: localPath })
    ).rejects.toThrow('not registered');
    files.set(`api/contents/${imported.remotePath}`, {
      type: 'file',
      format: 'base64',
      content: Buffer.from('modified remotely').toString('base64'),
    });
    await expect(f.call(f.session, 'notebook_import_file', input)).rejects.toThrow(
      'refusing to overwrite'
    );
    expect(f.client.json).toHaveBeenCalledTimes(2);
  });

  it('refuses changed files, symlinks, agent files and oversized input before remote writes', async () => {
    const f = await fixture();
    const localPath = path.join(f.root, 'data.csv');
    fs.writeFileSync(localPath, 'original');
    const file = {
      id: 'csv',
      fileName: 'data.csv',
      localPath,
      source: 'user' as const,
      createdAt: 1,
    };
    f.session.registerAttachments([file]);
    fs.writeFileSync(localPath, 'changed content');
    await expect(
      f.call(f.session, 'notebook_import_file', {
        notebookId: f.args.notebookId,
        attachmentId: 'csv',
      })
    ).rejects.toThrow('changed');
    const link = path.join(f.root, 'link');
    fs.symlinkSync(localPath, link);
    const large = path.join(f.root, 'large');
    fs.writeFileSync(large, Buffer.alloc(2_000_001));
    f.session.registerAttachments([
      { ...file, id: 'symlink', localPath: link },
      { ...file, id: 'agent', source: 'agent' },
      { ...file, id: 'large', localPath: large },
    ]);
    for (const attachmentId of ['symlink', 'agent', 'large']) {
      await expect(
        f.call(f.session, 'notebook_import_file', { notebookId: f.args.notebookId, attachmentId })
      ).rejects.toThrow('not registered');
    }
    expect(f.client.json).not.toHaveBeenCalled();
  });

  it('refuses an attachment import write when its Project reference is removed during the read', async () => {
    const f = await fixture();
    const localPath = path.join(f.root, 'data.csv');
    fs.writeFileSync(localPath, 'value\n1');
    f.session.registerAttachments([
      { id: 'csv', fileName: 'data.csv', localPath, source: 'user', createdAt: 1 },
    ]);
    Object.assign(f.client, {
      response: vi.fn(() => {
        new JupyterProjectConfigStore(f.root).unlinkNotebook({
          connectionId: 'configured',
          serverNamespace: 'host-bound',
          documentId: 'doc-id',
          contentPath: 'analysis.ipynb',
        });
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    });
    await expect(
      f.call(f.session, 'notebook_import_file', {
        notebookId: f.args.notebookId,
        attachmentId: 'csv',
      })
    ).rejects.toThrow('no longer authorized');
    expect(f.client.json).not.toHaveBeenCalled();
  });

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

  it('rechecks the live stable cell after a native move and edit during kernel discovery', async () => {
    const f = await fixture();
    f.client.kernelInfo.mockImplementation(() => {
      f.notebook.moveCell(0, 1);
      f.notebook.getCell(1).source = 'print(100)';
      return Promise.resolve({ kernelId: 'kernel', incarnation: 'native-instance' });
    });
    expect(await f.call(f.session, 'notebook_execute', f.args)).toMatchObject({
      state: 'conflict',
    });
    expect(f.client.submitCell).not.toHaveBeenCalled();
    expect(f.notebook.cells.find((cell) => cell.id === 'human')?.source).toBe(
      'Preserve my conclusion.'
    );
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

  it('requires execution policy before selecting or creating a kernel', async () => {
    const f = await fixture();
    f.client.executionPolicy.mockResolvedValue(undefined as never);
    await expect(f.call(f.session, 'notebook_execute', f.args)).rejects.toThrow('execution policy');
    expect(f.client.json).not.toHaveBeenCalled();
    expect(f.client.submitCell).not.toHaveBeenCalled();
    expect(f.journal.records()).toEqual([]);
  });

  it('retains the original handle as unknown when host connection preparation fails', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    vi.spyOn(f.connections, 'useDatalayer').mockRejectedValueOnce(
      new Error('private connection preparation error')
    );
    const result = await f.call(f.session, 'notebook_status', {
      notebookId: f.args.notebookId,
      runId: 'original',
    });
    expect(result).toMatchObject({ state: 'unknown', requestId: 'original-request' });
    expect(JSON.stringify(result)).not.toContain('private connection preparation error');
    expect(f.client.submitCell).toHaveBeenCalledOnce();
  });

  it('waits beyond cancellation acceptance for the original terminal result', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    } as never);
    f.client.stopRequest.mockResolvedValue('requested');
    f.client.observe.mockResolvedValueOnce({ state: 'running' } as never).mockResolvedValueOnce({
      state: 'cancelled',
      result: { error: { ename: 'KeyboardInterrupt' } },
    } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    expect(await f.call(f.session, 'notebook_stop', f.args)).toMatchObject({
      state: 'cancelled',
      runId: 'original',
      stopConfirmed: true,
    });
    expect(f.client.observe).toHaveBeenCalledTimes(2);
    expect(f.journal.get('original')).toMatchObject({ state: 'cancelled' });
  });

  it('reports a completion race from its result rather than claiming cancellation', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    } as never);
    f.client.stopRequest.mockResolvedValue('requested');
    await f.call(f.session, 'notebook_execute', f.args);
    expect(await f.call(f.session, 'notebook_stop', f.args)).toMatchObject({
      state: 'already_terminal',
      stopConfirmed: false,
    });
    expect(f.journal.get('original')).toMatchObject({ state: 'completed' });
  });

  it('keeps a failed original lookup unknown after an accepted cancellation', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    } as never);
    f.client.stopRequest.mockResolvedValue('requested');
    f.client.observe.mockResolvedValue({ state: 'unknown' } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    expect(await f.session.stop()).toEqual([{ runId: 'original', state: 'unknown' }]);
    expect(f.client.observe).toHaveBeenCalledOnce();
    expect(f.client.submitCell).toHaveBeenCalledOnce();
  });

  it('reconciles a settling POST handle after pausing before confirming its stop', async () => {
    const f = await fixture();
    let accept!: (value: unknown) => void;
    f.client.submitCell.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }) as never
    );
    f.client.stopRequest.mockResolvedValue('requested');
    f.client.observe.mockResolvedValue({ state: 'cancelled' } as never);
    const attempt = f.call(f.session, 'notebook_execute', f.args).catch((error) => error);
    await vi.waitFor(() => expect(f.client.submitCell).toHaveBeenCalledOnce());
    const stopping = f.session.stop();
    accept({ state: 'accepted', handle: { kernelId: 'kernel', requestId: 'original-request' } });
    expect(await attempt).toBeInstanceOf(Error);
    expect(await stopping).toEqual([{ runId: 'original', state: 'cancelled' }]);
    expect(f.client.stopRequest).toHaveBeenCalledWith({
      kernelId: 'kernel',
      requestId: 'original-request',
    });
    expect(f.client.submitCell).toHaveBeenCalledOnce();
  });

  it('bounds cancellation confirmation and does not replace a still-running result', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'original-request' },
    } as never);
    f.client.stopRequest.mockResolvedValue('requested');
    f.client.observe.mockResolvedValue({ state: 'running' } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    vi.useFakeTimers();
    const stopping = f.session.stop();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await stopping).toEqual([{ runId: 'original', state: 'unknown' }]);
    expect(f.journal.get('original')).toMatchObject({ state: 'running' });
    expect(f.client.stopRequest).toHaveBeenCalledOnce();
  });

  it('records native provenance and rejects silent memory replacement on later runs', async () => {
    const f = await fixture();
    await f.call(f.session, 'notebook_execute', f.args);
    expect(f.journal.get('original')?.target).toMatchObject({
      kernelId: 'kernel',
      kernelIncarnation: 'native-instance',
      serverInstanceId: 'server-instance',
    });
    expect(f.client.submitCell).toHaveBeenCalledWith('kernel', 'doc-id', 'code', 'print(42)', {
      documentPath: 'analysis.ipynb',
      runId: 'original',
      kernelIncarnation: 'native-instance',
      serverInstanceId: 'server-instance',
    });
    f.client.kernelInfo.mockResolvedValue({ kernelId: 'kernel', incarnation: 'replacement' });
    await expect(
      f.call(f.session, 'notebook_execute', { ...f.args, runId: 'after-restart' })
    ).rejects.toThrow('memory was lost');
    expect(f.client.submitCell).toHaveBeenCalledOnce();
    expect(f.journal.get('after-restart')).toBeUndefined();
  });

  it('refuses a kernel shared with another Notebook', async () => {
    const f = await fixture();
    f.client.json.mockResolvedValue([
      { path: 'analysis.ipynb', kernel: { id: 'kernel' } },
      { path: 'unowned.ipynb', kernel: { id: 'kernel' } },
    ] as never);
    await expect(f.call(f.session, 'notebook_execute', f.args)).rejects.toThrow(
      'shared by another document'
    );
    expect(f.client.submitCell).not.toHaveBeenCalled();
  });

  it('exposes historical provenance and complete artifact when inline output is bounded', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'request' },
    } as never);
    f.client.observe.mockResolvedValue({
      state: 'completed',
      result: {
        status: 'ok',
        outputs: [],
        source_hash: f.args.expectedSourceHash,
        source_matches: false,
        output_attachment: 'historical',
        outputs_truncated: true,
        result_artifact: 'nbmodel-results/kernel/request.json',
      },
    } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    expect(
      await f.call(f.session, 'notebook_status', {
        notebookId: f.args.notebookId,
        runId: 'original',
      })
    ).toMatchObject({
      kernelIncarnation: 'native-instance',
      result: {
        sourceMatches: false,
        outputAttachment: 'historical',
        outputsTruncated: true,
        resultArtifact: 'nbmodel-results/kernel/request.json',
      },
    });
  });

  it('moves and deletes stable cells while preserving human metadata and attachments', async () => {
    const f = await fixture();
    const human = f.notebook.getCell(1);
    human.setMetadata('custom', { retain: 'unknown metadata' });
    (human as import('@jupyter/ydoc').YMarkdownCell).attachments = {
      'keep.txt': { 'text/plain': 'human attachment' },
    };
    const before = human.toJSON();
    const read = (await f.call(f.session, 'notebook_read_cell', {
      notebookId: f.args.notebookId,
      cellId: 'human',
    })) as { sourceHash: string };
    await f.call(f.session, 'notebook_move_cell', {
      notebookId: f.args.notebookId,
      cellId: 'human',
      expectedSourceHash: read.sourceHash,
      beforeCellId: 'code',
    });
    expect(f.notebook.cells.map((c) => c.id)).toEqual(['human', 'code']);
    expect(f.notebook.getCell(0).toJSON()).toEqual(before);
    await f.call(f.session, 'notebook_move_cell', {
      notebookId: f.args.notebookId,
      cellId: 'human',
      expectedSourceHash: read.sourceHash,
      beforeCellId: '',
    });
    expect(f.notebook.cells.map((c) => c.id)).toEqual(['code', 'human']);
    f.notebook.getCell(0).source = 'new human code';
    expect(await f.call(f.session, 'notebook_delete_cell', f.args)).toMatchObject({
      state: 'conflict',
    });
    const next = (await f.call(f.session, 'notebook_read_cell', {
      notebookId: f.args.notebookId,
      cellId: 'code',
    })) as { sourceHash: string };
    const args = {
      notebookId: f.args.notebookId,
      cellId: 'code',
      expectedSourceHash: next.sourceHash,
    };
    expect(await f.call(f.session, 'notebook_delete_cell', args)).toMatchObject({
      state: 'deleted',
    });
    expect(await f.call(f.session, 'notebook_delete_cell', args)).toMatchObject({
      state: 'missing',
    });
    expect(f.notebook.cells.map((c) => c.id)).toEqual(['human']);
    expect(f.notebook.getCell(0).toJSON()).toEqual(before);
  });

  it('refuses ambiguous stable IDs before editing either cell', async () => {
    const f = await fixture();
    f.notebook.insertCell(2, {
      id: 'code',
      cell_type: 'code',
      source: 'unrelated',
      metadata: {},
      outputs: [],
      execution_count: null,
    });
    await expect(
      f.call(f.session, 'notebook_edit_cell', { ...f.args, source: 'overwrite' })
    ).rejects.toThrow('ambiguous');
    expect(f.notebook.cells.map((c) => c.source)).toEqual([
      'print(42)',
      'Preserve my conclusion.',
      'unrelated',
    ]);
  });

  it('checks Project authorization again after shared state synchronization', async () => {
    const f = await fixture();
    const ref = new JupyterProjectConfigStore(f.root).listNotebookReferences();
    if (!ref.ok) {
      throw new Error('Fixture reference unavailable');
    }
    f.doc.flush.mockImplementation(() => {
      new JupyterProjectConfigStore(f.root).unlinkNotebook(ref.data[0]);
      return Promise.resolve();
    });
    await expect(
      f.call(f.session, 'notebook_edit_cell', { ...f.args, source: 'unauthorized overwrite' })
    ).rejects.toThrow('no longer authorized');
    expect(f.notebook.getCell(0).source).toBe('print(42)');
  });

  it('follows a native rename on an already open Project document', async () => {
    const f = await fixture();
    f.client.documentPath.mockResolvedValue('renamed.ipynb');
    expect(
      await f.call(f.session, 'notebook_describe', { notebookId: f.args.notebookId })
    ).toMatchObject({ contentPath: 'renamed.ipynb' });
    const refs = new JupyterProjectConfigStore(f.root).listNotebookReferences();
    expect(refs).toMatchObject({
      ok: true,
      data: [{ documentId: 'doc-id', contentPath: 'renamed.ipynb' }],
    });
    expect(f.client.openDocument).toHaveBeenCalledOnce();
    expect(f.client.documentPath).toHaveBeenCalledWith('doc-id');
  });

  it('checks interface capabilities before creating a new shared document session', async () => {
    const f = await fixture();
    f.client.inspectConnection.mockResolvedValue({
      mcp: { state: 'available' },
      nbmodel: { state: 'available' },
      rtc: { state: 'disabled' },
      nbconvert: { state: 'available' },
    });
    await expect(
      f.call(f.create(), 'notebook_describe', { notebookId: f.args.notebookId })
    ).rejects.toThrow('interfaces could not be verified');
    expect(f.client.openDocument).toHaveBeenCalledOnce();
  });

  it('reads cached terminal history without network or an RTC document', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'request' },
    } as never);
    f.client.observe.mockResolvedValue({
      state: 'completed',
      result: {
        outputs: [{ output_type: 'stream', text: 'original result' }],
        original_result_entry: 'https://configured.invalid/api/kernels/kernel/requests/request',
      },
    } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    await f.call(f.session, 'notebook_status', {
      notebookId: f.args.notebookId,
      runId: 'original',
    });
    f.session.dispose();
    f.client.openDocument.mockRejectedValue(new Error('network down'));
    f.client.documentPath.mockRejectedValue(new Error('network down'));
    f.client.observe.mockRejectedValue(new Error('network down'));
    expect(
      await f.call(f.create(), 'notebook_status', {
        notebookId: f.args.notebookId,
        runId: 'original',
      })
    ).toMatchObject({
      state: 'completed',
      originalResultEntry: 'https://configured.invalid/api/kernels/kernel/requests/request',
      result: { outputs: [{ text: 'original result' }] },
    });
    expect(f.client.openDocument).toHaveBeenCalledOnce();
    expect(f.client.observe).toHaveBeenCalledOnce();
  });

  it('marks host preview clipping and retains the complete original request link', async () => {
    const f = await fixture();
    f.client.submitCell.mockResolvedValue({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'request' },
    } as never);
    f.client.observe.mockResolvedValue({
      state: 'completed',
      result: {
        outputs: Array.from({ length: 20 }, () => ({ output_type: 'stream', text: 'original' })),
        original_result_entry: 'https://configured.invalid/api/kernels/kernel/requests/request',
      },
    } as never);
    await f.call(f.session, 'notebook_execute', f.args);
    const value = (await f.call(f.session, 'notebook_status', {
      notebookId: f.args.notebookId,
      runId: 'original',
    })) as { result: { outputs: unknown[] } };
    expect(value).toMatchObject({
      originalResultEntry: 'https://configured.invalid/api/kernels/kernel/requests/request',
      result: { outputsTruncated: true, omittedOutputs: 4 },
    });
    expect(value.result.outputs).toHaveLength(16);
  });
});
