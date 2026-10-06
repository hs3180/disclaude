import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { DatalayerJupyterClient, ToolDefinition, ToolContext } from '@disclaude/core';
import type {
  NotebookAgentContext,
  NotebookSession,
  NotebookStopObservation,
} from './agent-session.js';
import { JupyterConnections } from './connections.js';
import {
  JupyterProjectConfigStore,
  type JupyterNotebookReference,
} from './project-config-store.js';
import { DatalayerRunStore, type DatalayerRunRecord } from './datalayer-run-store.js';

type Document = Awaited<ReturnType<DatalayerJupyterClient['openDocument']>>;
type Bound = { ref: JupyterNotebookReference; client: DatalayerJupyterClient; doc: Document };
const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const key = (ref: JupyterNotebookReference): string =>
  hash(JSON.stringify([ref.connectionId, ref.serverNamespace, ref.documentId ?? ref.contentPath]));
const text = { type: 'string' };
const notebookId = { notebookId: text };
const cellId = { ...notebookId, cellId: text };

/** MVP over existing RTC/nbmodel APIs. Reports unsupported guarantees explicitly. */
export class DatalayerNotebookAgentSession implements NotebookSession {
  readonly tools: ToolDefinition[];
  private readonly root: string;
  private readonly config: JupyterProjectConfigStore;
  private readonly journal: DatalayerRunStore;
  private readonly documents = new Map<string, Promise<Bound>>();
  private readonly executions = new Map<string, { target: string; pending: Promise<unknown> }>();
  private paused = false;

  constructor(
    private readonly context: NotebookAgentContext,
    private readonly connections: JupyterConnections
  ) {
    this.root = fs.realpathSync(context.workingDir);
    this.config = new JupyterProjectConfigStore(this.root);
    this.journal = new DatalayerRunStore(this.root, context.conversationKey);
    this.tools = [
      this.tool(
        'notebook_list',
        'List this Project’s authorized remote Notebooks and persisted run IDs.',
        {},
        async () => ({ notebooks: await this.overviews(0), recentRuns: this.recentRuns() })
      ),
      this.tool(
        'notebook_describe',
        'Read live RTC cells, including unsaved human edits. Use cellId for later operations.',
        notebookId,
        async (input) => this.describe(await this.bound(String(input.notebookId)), 64)
      ),
      this.tool(
        'notebook_read_cell',
        'Read a live shared cell and its outputs by stable cell ID.',
        cellId,
        async (input) => {
          const bound = await this.bound(String(input.notebookId));
          await bound.doc.flush();
          const cell = this.cell(bound, String(input.cellId));
          if (Buffer.byteLength(cell.source) > 64000) {
            throw new Error('Notebook cell exceeds the source read limit');
          }
          return {
            notebookId: key(bound.ref),
            revision: bound.doc.snapshot().revision,
            cellId: cell.id,
            cellType: cell.cell_type,
            source: cell.source,
            sourceHash: hash(cell.source),
            outputs: this.outputs(cell.toJSON() as unknown as Record<string, unknown>),
            ...this.previewState(cell.toJSON() as unknown as Record<string, unknown>),
            completeNotebookEntry: bound.client.notebookEntry(bound.ref.contentPath),
          };
        }
      ),
      this.tool(
        'notebook_insert_cell',
        'Insert a code or Markdown cell in the shared document. Reusing the same cellId/source is safe. Empty beforeCellId appends.',
        {
          ...cellId,
          beforeCellId: { type: 'string' },
          cellType: { type: 'string', enum: ['code', 'markdown'] },
          source: { type: 'string' },
        },
        async (input) => {
          const bound = await this.bound(String(input.notebookId));
          await bound.doc.flush();
          this.assertBound(bound);
          const existing = bound.doc.notebook.cells.find((c) => c.id === input.cellId);
          if (existing) {
            if (existing.source !== input.source || existing.cell_type !== input.cellType) {
              throw new Error('Cell ID already belongs to different content');
            }
            return { state: 'existing', cellId: existing.id, sourceHash: hash(existing.source) };
          }
          const index = input.beforeCellId
            ? bound.doc.notebook.cells.findIndex((c) => c.id === input.beforeCellId)
            : bound.doc.notebook.cells.length;
          if (index < 0) {
            throw new Error('Insertion target cell is missing');
          }
          bound.doc.notebook.insertCell(index, {
            id: String(input.cellId),
            cell_type: input.cellType as 'code' | 'markdown',
            source: String(input.source),
            metadata: {},
            ...(input.cellType === 'code' ? { outputs: [], execution_count: null } : {}),
          });
          await bound.doc.flush();
          return {
            state: 'inserted',
            cellId: input.cellId,
            sourceHash: hash(String(input.source)),
          };
        }
      ),
      this.tool(
        'notebook_edit_cell',
        'Edit a live shared cell only after checking its last read sourceHash. This client-side check is not an atomic server CAS.',
        {
          ...cellId,
          expectedSourceHash: {
            type: 'string',
            description: 'SHA-256 from the latest live cell read',
          },
          source: { type: 'string' },
        },
        async (input) => {
          const bound = await this.bound(String(input.notebookId));
          await bound.doc.flush();
          this.assertBound(bound);
          const cell = this.cell(bound, String(input.cellId));
          if (hash(cell.source) !== input.expectedSourceHash) {
            return { state: 'conflict', sourceHash: hash(cell.source) };
          }
          cell.source = String(input.source);
          await bound.doc.flush();
          return {
            state: 'edited',
            cellId: cell.id,
            sourceHash: hash(cell.source),
            revision: bound.doc.snapshot().revision,
          };
        }
      ),
      this.tool(
        'notebook_move_cell',
        'Move one stable cell before beforeCellId; an empty target appends. Check the latest sourceHash and preserve cell metadata/attachments.',
        { ...cellId, expectedSourceHash: text, beforeCellId: text },
        async (input) => {
          const bound = await this.bound(String(input.notebookId));
          await bound.doc.flush();
          this.assertBound(bound);
          const cell = this.cell(bound, String(input.cellId));
          if (hash(cell.source) !== input.expectedSourceHash) {
            return { state: 'conflict', sourceHash: hash(cell.source) };
          }
          if (input.beforeCellId === cell.id) {
            return { state: 'unchanged', cellId: cell.id };
          }
          const { cells } = bound.doc.notebook;
          const from = cells.indexOf(cell);
          const before = input.beforeCellId
            ? cells.indexOf(this.cell(bound, String(input.beforeCellId)))
            : cells.length;
          const to = from < before ? before - 1 : before;
          const stableId = cell.id;
          if (from !== to) {
            bound.doc.notebook.moveCell(from, to);
          }
          await bound.doc.flush();
          return { state: 'moved', cellId: stableId, revision: bound.doc.snapshot().revision };
        }
      ),
      this.tool(
        'notebook_delete_cell',
        'Delete the explicitly identified stable cell only if its last read sourceHash still matches. Preserve unrelated human cells.',
        { ...cellId, expectedSourceHash: text },
        async (input) => {
          const bound = await this.bound(String(input.notebookId));
          await bound.doc.flush();
          this.assertBound(bound);
          const matches = bound.doc.notebook.cells.filter((c) => c.id === input.cellId);
          if (!matches.length) {
            return { state: 'missing', cellId: input.cellId };
          }
          const cell = this.cell(bound, String(input.cellId));
          if (hash(cell.source) !== input.expectedSourceHash) {
            return { state: 'conflict', sourceHash: hash(cell.source) };
          }
          const stableId = cell.id;
          bound.doc.notebook.deleteCell(bound.doc.notebook.cells.indexOf(cell));
          await bound.doc.flush();
          return { state: 'deleted', cellId: stableId, revision: bound.doc.snapshot().revision };
        }
      ),
      this.tool(
        'notebook_execute',
        'Submit the exact live code cell once to the remote nbmodel queue. Persist and reuse runId; unknown submissions must not be replayed. Poll notebook_status for completion.',
        {
          ...cellId,
          expectedSourceHash: {
            type: 'string',
            description: 'SHA-256 from the latest live cell read',
          },
          runId: text,
        },
        (input, invocation) => this.execute(input, invocation)
      ),
      this.tool(
        'notebook_status',
        'Query the original runId without replay. Retained remote results and host snapshots preserve original execution provenance.',
        { ...notebookId, runId: text },
        (input) => this.observe(this.record(String(input.notebookId), String(input.runId)))
      ),
      this.tool(
        'notebook_stop',
        'Cancel this exact original nbmodel request and wait for its terminal result. Report unknown when completion cannot be verified.',
        { ...notebookId, runId: text },
        async (input) => {
          const record = this.record(String(input.notebookId), String(input.runId));
          const result = await this.requestStop(record);
          return { ...result, stopConfirmed: result.state === 'cancelled' };
        }
      ),
      this.tool(
        'notebook_export',
        'Export HTML and an ipynb snapshot from the same live revision on the remote server. Images stay in the report; return links and revision metadata.',
        notebookId,
        async (input) => this.export(await this.bound(String(input.notebookId)))
      ),
    ];
  }

  private tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    execute: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>
  ): ToolDefinition {
    return {
      name,
      description,
      inputSchema: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      execute: async (input, invocation) => {
        invocation.signal.throwIfAborted();
        this.assertActive();
        // DSH supports a small schema subset; keep limits in the host boundary too.
        if (
          Buffer.byteLength(JSON.stringify(input)) > 300000 ||
          (input.source !== undefined &&
            (typeof input.source !== 'string' || input.source.length > 64000)) ||
          (input.expectedSourceHash !== undefined &&
            (typeof input.expectedSourceHash !== 'string' ||
              !/^[a-f0-9]{64}$/.test(input.expectedSourceHash))) ||
          ['cellId', 'runId', 'beforeCellId'].some(
            (field) =>
              input[field] !== undefined &&
              (typeof input[field] !== 'string' ||
                !(
                  (field === 'beforeCellId' && input[field] === '') ||
                  /^[A-Za-z0-9_-]{1,200}$/.test(input[field] as string)
                ))
          )
        ) {
          throw new Error('Invalid or oversized Notebook tool argument');
        }
        const result = await execute(input, invocation);
        invocation.signal.throwIfAborted();
        this.assertActive();
        return result;
      },
    };
  }

  private assertActive(): void {
    if (this.paused || fs.realpathSync(this.context.currentWorkingDir()) !== this.root) {
      throw new Error('Notebook operation stopped or Project changed');
    }
  }
  get inactive(): boolean {
    return this.paused;
  }
  pause(): void {
    this.paused = true;
  }
  dispose(): void {
    this.pause();
    for (const document of this.documents.values()) {
      void document.then((bound) => bound.doc.close()).catch(() => {});
    }
    this.documents.clear();
  }
  redactEnvironment(environment: Record<string, string | undefined>): void {
    this.connections.redactEnvironment(environment);
  }

  private refs(): JupyterNotebookReference[] {
    const loaded = this.config.listNotebookReferences();
    if (!loaded.ok) {
      throw new Error('Project Notebook references cannot be verified');
    }
    return loaded.data;
  }

  private async bind(ref: JupyterNotebookReference): Promise<Bound> {
    if (ref.documentId) {
      const { documentId } = ref;
      const contentPath = await this.connections.useDatalayer(
        ref.connectionId,
        ref.serverNamespace,
        (client) => client.documentPath(documentId)
      );
      this.assertActive();
      if (contentPath !== ref.contentPath) {
        const updated = this.config.updateNotebookPath(ref, contentPath);
        if (!updated.ok) {
          throw new Error(updated.error);
        }
        ref = updated.data;
      }
    }
    const identifier = key(ref);
    let pending = this.documents.get(identifier);
    if (!pending) {
      pending = this.connections.useDatalayer(
        ref.connectionId,
        ref.serverNamespace,
        async (client) => {
          const capabilities = await client.inspectConnection();
          if (
            capabilities.mcp.state !== 'available' ||
            capabilities.nbmodel.state !== 'available' ||
            capabilities.rtc.state !== 'configured' ||
            capabilities.nbconvert.state !== 'available'
          ) {
            throw new Error(
              'Required remote Notebook interfaces could not be verified; inspect the host connection'
            );
          }
          this.assertActive();
          const doc = await client.openDocument(ref.contentPath, ref.documentId);
          const resolved = this.config.resolveNotebook(ref, doc.documentId);
          if (!resolved.ok) {
            doc.close();
            throw new Error('Notebook reference changed while resolving');
          }
          return { client, doc, ref: resolved.data };
        }
      );
      this.documents.set(identifier, pending);
    }
    try {
      const bound = await pending;
      bound.ref = ref.documentId ? ref : bound.ref;
      this.documents.set(key(bound.ref), pending);
      return bound;
    } catch (error) {
      this.documents.delete(identifier);
      throw error;
    }
  }

  private async bound(identifier: string): Promise<Bound> {
    this.assertActive();
    const ref = this.refs().find((r) => key(r) === identifier);
    if (!ref) {
      throw new Error('Notebook is not in this Project');
    }
    const bound = await this.bind(ref);
    this.assertActive();
    return bound;
  }

  private cell(bound: Bound, id: string): Document['notebook']['cells'][number] {
    const matches = bound.doc.notebook.cells.filter((c) => c.id === id);
    if (matches.length !== 1) {
      throw new Error('Notebook cell ID is missing or ambiguous');
    }
    return matches[0];
  }

  private assertBound(bound: Bound): void {
    this.assertActive();
    if (!this.refs().some((ref) => key(ref) === key(bound.ref))) {
      throw new Error('Notebook reference is no longer authorized by this Project');
    }
  }

  private previewState(cell: Record<string, unknown>): {
    outputsTruncated?: true;
    omittedOutputs?: number;
  } {
    const outputs = Array.isArray(cell.outputs)
      ? (cell.outputs as Array<Record<string, unknown>>)
      : [];
    const clipped =
      outputs.length > 16 ||
      outputs.some((o) => {
        const value = Array.isArray(o.text) ? o.text.join('') : String(o.text ?? '');
        const data = o.data as Record<string, unknown> | undefined;
        return (
          value.length > 8000 ||
          String(o.evalue ?? '').length > 1000 ||
          String(data?.['text/plain'] ?? '').length > 2000
        );
      });
    return clipped
      ? { outputsTruncated: true, omittedOutputs: Math.max(0, outputs.length - 16) }
      : {};
  }

  private outputs(cell: Record<string, unknown>): unknown[] {
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    return outputs.slice(0, 16).map((output: Record<string, unknown>) => {
      const data = output.data as Record<string, unknown> | undefined;
      return {
        outputType: output.output_type,
        ...(output.text
          ? {
              text: String(Array.isArray(output.text) ? output.text.join('') : output.text).slice(
                0,
                8000
              ),
            }
          : {}),
        ...(output.ename
          ? { errorName: output.ename, errorValue: String(output.evalue).slice(0, 1000) }
          : {}),
        ...(data
          ? {
              mimeTypes: Object.keys(data),
              ...(data['text/plain'] ? { text: String(data['text/plain']).slice(0, 2000) } : {}),
            }
          : {}),
      };
    });
  }

  private async describe(bound: Bound, limit: number): Promise<Record<string, unknown>> {
    await bound.doc.flush();
    const snapshot = bound.doc.snapshot();
    return {
      notebookId: key(bound.ref),
      contentPath: bound.ref.contentPath,
      documentId: bound.doc.documentId,
      entry: bound.client.notebookEntry(bound.ref.contentPath),
      revision: snapshot.revision,
      cells: snapshot.cells.slice(0, limit).map((c) => ({
        cellId: c.id,
        cellType: c.cell_type,
        sourceHash: c.sourceHash,
        sourcePreview: String(c.source).slice(0, 500),
        outputs: this.outputs(c),
        ...this.previewState(c),
      })),
      omittedCells: Math.max(0, snapshot.cells.length - limit),
    };
  }

  private async overviews(limit: number): Promise<Record<string, unknown>[]> {
    this.assertActive();
    const results = [];
    for (const ref of this.refs().slice(0, 8)) {
      results.push(await this.describe(await this.bind(ref), limit));
    }
    return results;
  }
  private recentRuns(): Array<Record<string, unknown>> {
    return this.journal
      .records()
      .slice(-10)
      .map((r) => ({
        runId: r.runId,
        state: r.state,
        cellId: r.target.cellId,
        contentPath: r.target.contentPath,
      }));
  }
  async messageContext(): Promise<string> {
    return `\n\n[Notebook resources — Datalayer MVP]\nThe host uses existing remote RTC and nbmodel APIs. Read current live cells by ID, preserve human edits, and keep analysis/conclusions in the Notebook. Kernel/data paths belong to Jupyter, not this host. Reuse runId to query an original attempt; never replay unknown work. Source checks are client-side. Request cancellation may be unsupported on this server. Report links from notebook_export refer to one snapshot.\n${JSON.stringify({ notebooks: await this.overviews(8), recentRuns: this.recentRuns() })}`;
  }

  private async kernel(bound: Bound): Promise<string> {
    const sessions = (await bound.client.json('api/sessions')) as Array<{
      path: string;
      kernel: { id: string };
    }>;
    const ids = [
      ...new Set(sessions.filter((s) => s.path === bound.ref.contentPath).map((s) => s.kernel.id)),
    ];
    if (ids.length > 1) {
      throw new Error('Notebook has multiple kernel bindings');
    }
    let [id] = ids;
    if (id && sessions.some((s) => s.kernel.id === id && s.path !== bound.ref.contentPath)) {
      throw new Error(
        'Notebook kernel is shared by another document; an exclusive binding is required'
      );
    }
    if (!id) {
      if (this.journal.records().some((r) => r.target.documentId === bound.ref.documentId)) {
        throw new Error('Original Notebook kernel is missing; do not silently start a replacement');
      }
      const specs = (await bound.client.json('api/kernelspecs')) as {
        default: string;
        kernelspecs: Record<string, unknown>;
      };
      const names = Object.keys(specs.kernelspecs);
      const name = names.includes(specs.default)
        ? specs.default
        : names.length === 1
          ? names[0]
          : undefined;
      if (!name) {
        throw new Error('Notebook needs an explicitly configured remote kernel');
      }
      this.assertBound(bound);
      const session = (await bound.client.json('api/sessions', 'POST', {
        path: bound.ref.contentPath,
        name: bound.ref.contentPath,
        type: 'notebook',
        kernel: { name },
      })) as { kernel: { id: string } };
      ({ id } = session.kernel);
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = (await bound.client.json(`api/kernels/${encodeURIComponent(id)}`)) as {
        execution_state: string;
      };
      if (state.execution_state === 'idle') {
        return id;
      }
      if (state.execution_state !== 'starting') {
        throw new Error(
          'Notebook kernel is busy; query the existing run before submitting another'
        );
      }
      await bound.client.kernelInfo(id);
      await wait(100);
    }
    throw new Error('Notebook kernel did not become ready');
  }

  private execute(input: Record<string, unknown>, invocation: ToolContext): Promise<unknown> {
    const runId = String(input.runId);
    const target = JSON.stringify([input.notebookId, input.cellId, input.expectedSourceHash]);
    const existing = this.executions.get(runId);
    if (existing) {
      if (existing.target !== target) {
        throw new Error('Notebook runId conflicts with a pending attempt');
      }
      return existing.pending;
    }
    const pending = this.submit(input, invocation).finally(() => this.executions.delete(runId));
    this.executions.set(runId, { target, pending });
    return pending;
  }
  private async submit(input: Record<string, unknown>, invocation: ToolContext): Promise<unknown> {
    const bound = await this.bound(String(input.notebookId));
    const runId = String(input.runId);
    const previous = this.journal.get(runId);
    if (previous) {
      if (
        previous.target.documentId !== bound.ref.documentId ||
        previous.target.cellId !== input.cellId ||
        previous.target.sourceHash !== input.expectedSourceHash
      ) {
        throw new Error('Notebook runId conflicts with the original attempt');
      }
      return this.observe(previous);
    }
    await bound.doc.flush();
    const cell = this.cell(bound, String(input.cellId));
    if (cell.cell_type !== 'code' || hash(cell.source) !== input.expectedSourceHash) {
      return { state: 'conflict', sourceHash: hash(cell.source) };
    }
    const policy = await bound.client.executionPolicy();
    if (!policy) {
      throw new Error(
        'Notebook execution policy is unavailable; verify the remote Datalayer repair'
      );
    }
    this.assertBound(bound);
    const kernelId = await this.kernel(bound);
    const { incarnation } = await bound.client.kernelInfo(kernelId);
    if (
      this.journal
        .records()
        .some(
          (r) =>
            r.target.kernelId === kernelId &&
            r.target.kernelIncarnation !== undefined &&
            r.target.kernelIncarnation !== incarnation
        )
    ) {
      throw new Error(
        'Original kernel memory was lost; explicitly choose a new kernel before continuing'
      );
    }
    await bound.doc.flush();
    invocation.signal.throwIfAborted();
    this.assertBound(bound);
    const currentCell = this.cell(bound, String(input.cellId));
    const { source } = currentCell;
    if (currentCell.cell_type !== 'code' || hash(source) !== input.expectedSourceHash) {
      return { state: 'conflict', sourceHash: hash(source) };
    }
    const record = this.journal.reserve(runId, {
      connectionId: bound.ref.connectionId,
      serverNamespace: bound.ref.serverNamespace,
      contentPath: bound.ref.contentPath,
      documentId: bound.doc.documentId,
      cellId: currentCell.id,
      sourceHash: hash(source),
      kernelId,
      kernelIncarnation: incarnation,
      serverInstanceId: policy.serverInstanceId,
    });
    const result = await bound.client.submitCell(
      kernelId,
      bound.doc.documentId,
      currentCell.id,
      source,
      {
        documentPath: bound.ref.contentPath,
        runId,
        kernelIncarnation: incarnation,
        serverInstanceId: policy.serverInstanceId,
      }
    );
    const saved = this.journal.update(
      runId,
      result.state === 'accepted'
        ? { state: 'accepted', handle: result.handle }
        : { state: result.state }
    );
    return {
      runId: record.runId,
      state: saved.state,
      ...(saved.handle ? { requestId: saved.handle.requestId } : {}),
    };
  }

  private record(notebookId: string, runId: string): DatalayerRunRecord {
    const ref = this.refs().find((item) => key(item) === notebookId);
    const record = this.journal.get(runId);
    if (
      !ref ||
      !record ||
      record.target.documentId !== ref.documentId ||
      record.target.connectionId !== ref.connectionId ||
      record.target.serverNamespace !== ref.serverNamespace
    ) {
      throw new Error('Notebook run does not belong to this conversation/resource');
    }
    return record;
  }
  private useRecord<T>(
    record: DatalayerRunRecord,
    operation: (client: DatalayerJupyterClient) => Promise<T>
  ): Promise<T> {
    const ref = this.refs().find(
      (r) =>
        r.documentId === record.target.documentId &&
        r.connectionId === record.target.connectionId &&
        r.serverNamespace === record.target.serverNamespace
    );
    if (!ref) {
      throw new Error('Notebook run reference is no longer authorized');
    }
    return this.connections.useDatalayer(ref.connectionId, ref.serverNamespace, operation);
  }
  private async observe(record: DatalayerRunRecord): Promise<unknown> {
    let current = record;
    if (!terminal.has(record.state) && record.handle) {
      const { handle } = record;
      const observation = await this.useRecord(record, (client) => client.observe(handle));
      current = this.journal.update(record.runId, { state: observation.state, observation });
    }
    return {
      runId: current.runId,
      state: current.state === 'submitting' ? 'unknown' : current.state,
      sourceHash: current.target.sourceHash,
      cellId: current.target.cellId,
      ...(current.handle ? { requestId: current.handle.requestId } : {}),
      ...(typeof current.observation?.result?.original_result_entry === 'string'
        ? { originalResultEntry: current.observation.result.original_result_entry }
        : {}),
      ...(typeof current.observation?.result?.result_artifact_entry === 'string'
        ? { resultArtifactEntry: current.observation.result.result_artifact_entry }
        : {}),
      kernelId: current.target.kernelId,
      ...(current.target.kernelIncarnation
        ? { kernelIncarnation: current.target.kernelIncarnation }
        : {}),
      ...(current.observation?.result ? { result: this.summary(current.observation.result) } : {}),
    };
  }
  private summary(result: Record<string, unknown>): Record<string, unknown> {
    return {
      ...('execution_count' in result ? { executionCount: result.execution_count } : {}),
      outputs: this.outputs({ outputs: result.outputs }),
      ...this.previewState({ outputs: result.outputs }),
      ...(result.error ? { error: result.error } : {}),
      ...(result.source_hash ? { sourceHash: result.source_hash } : {}),
      ...(typeof result.source_matches === 'boolean'
        ? { sourceMatches: result.source_matches }
        : {}),
      ...(result.output_attachment ? { outputAttachment: result.output_attachment } : {}),
      ...(result.outputs_truncated === true ? { outputsTruncated: true } : {}),
      ...(result.result_artifact ? { resultArtifact: result.result_artifact } : {}),
      ...(result.result_artifact_pending === true ? { resultArtifactPending: true } : {}),
      ...(typeof result.kernel_ready === 'boolean' ? { kernelReady: result.kernel_ready } : {}),
      ...(result.continuation_error ? { continuationError: result.continuation_error } : {}),
    };
  }

  private async export(bound: Bound): Promise<Record<string, unknown>> {
    await bound.doc.flush();
    this.assertBound(bound);
    const notebook = bound.doc.notebook.toJSON();
    const serialized = JSON.stringify(notebook);
    const revision = hash(serialized);
    const stem = `${bound.ref.contentPath.slice(0, -6)}.report-${revision.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    const notebookPath = `${stem}.ipynb`;
    const htmlPath = `${stem}.html`;
    await bound.client.json(
      `api/contents/${notebookPath.split('/').map(encodeURIComponent).join('/')}`,
      'PUT',
      { type: 'notebook', format: 'json', content: notebook }
    );
    this.assertBound(bound);
    const converted = await bound.client.response('nbconvert/html', 'POST', {
      name: notebookPath,
      content: notebook,
    });
    if (!converted.ok || !converted.headers.get('content-type')?.includes('text/html')) {
      await converted.body?.cancel();
      throw new Error('Remote Jupyter HTML export is unavailable');
    }
    const html = (await bound.client.responseText(converted)).replace(
      /<\/head>/i,
      `<meta name="disclaude-snapshot-sha256" content="${revision}">$&`
    );
    this.assertBound(bound);
    await bound.client.json(
      `api/contents/${htmlPath.split('/').map(encodeURIComponent).join('/')}`,
      'PUT',
      { type: 'file', format: 'text', content: html }
    );
    await bound.doc.flush();
    this.assertBound(bound);
    const liveRevision = hash(JSON.stringify(bound.doc.notebook.toJSON()));
    return {
      revision,
      liveRevision,
      liveChangedDuringExport: revision !== liveRevision,
      snapshotState: revision === liveRevision ? 'current' : 'historical',
      renderer: 'jupyter-nbconvert',
      notebookEntry: bound.client.notebookEntry(bound.ref.contentPath),
      snapshotEntry: bound.client.notebookEntry(notebookPath),
      htmlEntry: bound.client.fileEntry(htmlPath),
      notebookPath,
      htmlPath,
    };
  }

  async stop(): Promise<NotebookStopObservation[]> {
    this.pause();
    // A POST already sent may settle after pause. Reconcile its original
    // handle before stopping; a timed-out/unknown submission is never replayed.
    const deadline = Date.now() + 15000;
    while (this.executions.size > 0 && Date.now() < deadline) {
      await wait(100);
    }
    const results: NotebookStopObservation[] = [];
    for (const record of this.journal.records().filter((r) => !terminal.has(r.state))) {
      results.push(await this.requestStop(record));
    }
    return results;
  }

  private async requestStop(record: DatalayerRunRecord): Promise<NotebookStopObservation> {
    const result: NotebookStopObservation = { runId: record.runId, state: 'unknown' };
    if (terminal.has(record.state)) {
      return { ...result, state: 'already_terminal' };
    }
    if (!record.handle) {
      return result;
    }
    const { handle } = record;
    try {
      if ((await this.useRecord(record, (client) => client.stopRequest(handle))) !== 'requested') {
        return result;
      }
      const deadline = Date.now() + 15000;
      do {
        const observation = await this.useRecord(record, (client) => client.observe(handle));
        this.journal.update(record.runId, { state: observation.state, observation });
        if (terminal.has(observation.state)) {
          return {
            ...result,
            state: observation.state === 'cancelled' ? 'cancelled' : 'already_terminal',
          };
        }
        if (observation.state !== 'running') {
          return result;
        }
        await wait(100);
      } while (Date.now() < deadline);
    } catch {
      // Authentication, transport and authorization failures do not confirm a stop.
    }
    return result;
  }
}
