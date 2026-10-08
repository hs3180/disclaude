import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { notebookSnapshotHash, type DatalayerJupyterClient } from '@disclaude/core/jupyter';
import type { ToolDefinition, ToolContext } from '@disclaude/core';
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
export const notebookIdentifier = (ref: JupyterNotebookReference): string =>
  hash(JSON.stringify([ref.connectionId, ref.serverNamespace, ref.documentId ?? ref.contentPath]));
const key = notebookIdentifier;
const text = { type: 'string' };
const notebookId = { notebookId: text };
const cellId = { ...notebookId, cellId: text };
const inputLimit = 2_000_000;
export interface NotebookToolOptions {
  projectDir: string;
  useClient<T>(
    connectionId: string,
    namespace: string,
    operation: (client: DatalayerJupyterClient) => Promise<T>
  ): Promise<T>;
}
type StopObservation = { runId: string; state: 'cancelled' | 'already_terminal' | 'unknown' };

/** MVP over existing RTC/nbmodel APIs. Reports unsupported guarantees explicitly. */
export class NotebookTools {
  readonly tools: ToolDefinition[];
  private readonly root: string;
  private readonly config: JupyterProjectConfigStore;
  private readonly journal: DatalayerRunStore;
  private readonly documents = new Map<string, Promise<Bound>>();
  private closed = false;

  constructor(private readonly options: NotebookToolOptions) {
    this.root = fs.realpathSync(options.projectDir);
    try {
      const state = fs.lstatSync(path.join(this.root, '.jupyter'));
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new Error('Unsafe Project Jupyter directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    this.config = new JupyterProjectConfigStore(this.root);
    this.journal = new DatalayerRunStore(this.root);
    this.tools = [
      this.tool(
        'notebook_list',
        'List this Project’s authorized remote Notebooks and persisted run IDs.',
        {},
        () =>
          Promise.resolve({
            notebooks: this.refs().map((ref) => ({ ...ref, notebookId: key(ref) })),
            recentRuns: this.recentRuns(),
          })
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
            ...this.outputProvenance(
              cell.toJSON() as unknown as Record<string, unknown>,
              cell.source
            ),
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
        'notebook_observe_image',
        'Observe one PNG/JPEG image output by its zero-based outputIndex in the live cell. Returns native model image content with source provenance; do not infer a plot from MIME names. Large images remain in the complete Notebook.',
        { ...cellId, outputIndex: { type: 'integer' } },
        async (input) => {
          const bound = await this.bound(String(input.notebookId));
          await bound.doc.flush();
          const cell = this.cell(bound, String(input.cellId));
          const json = cell.toJSON() as unknown as Record<string, unknown>;
          const outputs = Array.isArray(json.outputs)
            ? (json.outputs as Array<Record<string, unknown>>)
            : [];
          const index = Number(input.outputIndex);
          if (!Number.isSafeInteger(index) || index < 0 || index >= outputs.length) {
            throw new Error('Notebook image output index is invalid');
          }
          const mime = outputs[index].data as Record<string, unknown> | undefined;
          const mimeType = mime?.['image/png']
            ? 'image/png'
            : mime?.['image/jpeg']
              ? 'image/jpeg'
              : undefined;
          if (!mimeType) {
            throw new Error(
              'This output has no supported raster image; inspect the complete Notebook'
            );
          }
          const image = mime?.[mimeType];
          const data = Array.isArray(image) ? image.join('') : image;
          if (
            typeof data !== 'string' ||
            !data ||
            data.length > 2_000_000 ||
            Buffer.from(data, 'base64').toString('base64') !== data
          ) {
            return {
              state: 'unavailable',
              reason: 'Image exceeds the preview limit or its bytes cannot be verified',
              completeNotebookEntry: bound.client.notebookEntry(bound.ref.contentPath),
            };
          }
          const result = {
            format: 'disclaude.tool-result.v1',
            data: {
              notebookId: key(bound.ref),
              cellId: cell.id,
              outputIndex: index,
              sourceHash: hash(cell.source),
              ...this.outputProvenance(json, cell.source),
              completeNotebookEntry: bound.client.notebookEntry(bound.ref.contentPath),
            },
            images: [{ mimeType, data }],
          };
          return result;
        }
      ),
      this.tool(
        'notebook_import_file',
        'Copy an explicitly selected Project-local file to the remote Notebook input directory. Return its kernel-relative path, SHA-256 and size; limit 2 MB.',
        { ...notebookId, filePath: text },
        (input, invocation) => this.importFile(input, invocation)
      ),
      this.tool(
        'notebook_download_report',
        'Export and download matching ipynb/HTML and up to four bounded PNG/JPEG previews into Project artifacts. Return file paths, revision and hashes. Delivery uses the independent channel tool.',
        notebookId,
        (input, invocation) => this.downloadReport(String(input.notebookId), invocation)
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
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).some((field) => !Object.hasOwn(properties, field)) ||
          Object.entries(properties).some(([field, raw]) => {
            const schema = raw as { type: string; enum?: string[] };
            return (
              !Object.hasOwn(input, field) ||
              (schema.type === 'integer'
                ? !Number.isSafeInteger(input[field])
                : typeof input[field] !== schema.type) ||
              (schema.enum !== undefined && !schema.enum.includes(input[field] as string))
            );
          })
        ) {
          throw new Error('Invalid Notebook command input; read its schema with jupyter tools');
        }
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
    if (this.closed) {
      throw new Error('Notebook tool invocation is closed');
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...new Set(this.documents.values())].map(async (pending) => (await pending).doc.close())
    );
    this.documents.clear();
  }

  private async importFile(
    input: Record<string, unknown>,
    invocation: ToolContext
  ): Promise<unknown> {
    const localPath = path.resolve(this.root, String(input.filePath));
    const relative = path.relative(this.root, fs.realpathSync(localPath));
    const identity = fs.lstatSync(localPath);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.size > inputLimit
    ) {
      throw new Error('Input must be a regular file inside this Project, at most 2 MB');
    }
    const attachment = {
      localPath,
      identity,
      name:
        path
          .basename(localPath)
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .replace(/^\.+/, '')
          .slice(-120) || 'input',
    };
    const bound = await this.bound(String(input.notebookId));
    const descriptor = fs.openSync(
      attachment.localPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    let data: Buffer;
    try {
      const current = fs.fstatSync(descriptor);
      const original = attachment.identity;
      if (
        !current.isFile() ||
        current.size > inputLimit ||
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        current.size !== original.size ||
        current.mtimeMs !== original.mtimeMs
      ) {
        throw new Error('Input file changed before importing');
      }
      data = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      if (
        data.length !== original.size ||
        after.mtimeMs !== original.mtimeMs ||
        after.size !== original.size
      ) {
        throw new Error('Input file changed during reading');
      }
    } finally {
      fs.closeSync(descriptor);
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    const directory = path.posix.join(
      path.posix.dirname(bound.ref.contentPath),
      `disclaude-inputs-${bound.doc.documentId}`
    );
    const remotePath = path.posix.join(directory, `${sha256}-${attachment.name}`);
    const route = (value: string): string =>
      `api/contents/${value.split('/').map(encodeURIComponent).join('/')}`;
    invocation.signal.throwIfAborted();
    this.assertBound(bound);
    const existingDirectory = await bound.client.response(`${route(directory)}?content=0`);
    if (existingDirectory.status === 404) {
      await existingDirectory.body?.cancel();
      invocation.signal.throwIfAborted();
      this.assertBound(bound);
      await bound.client.json(route(directory), 'PUT', { type: 'directory' });
    } else if (existingDirectory.ok) {
      const metadata = JSON.parse(await bound.client.responseText(existingDirectory)) as {
        type?: string;
      };
      if (metadata.type !== 'directory') {
        throw new Error('Remote Notebook input directory belongs to another resource');
      }
    } else {
      await existingDirectory.body?.cancel();
      throw new Error('Remote Notebook input directory could not be verified');
    }
    const existing = await bound.client.response(`${route(remotePath)}?format=base64`);
    let state = 'existing';
    if (existing.status === 404) {
      await existing.body?.cancel();
      invocation.signal.throwIfAborted();
      this.assertBound(bound);
      await bound.client.json(route(remotePath), 'PUT', {
        type: 'file',
        format: 'base64',
        content: data.toString('base64'),
      });
      state = 'imported';
    } else if (existing.ok) {
      const stored = JSON.parse(await bound.client.responseText(existing)) as {
        type?: string;
        format?: string;
        content?: unknown;
      };
      if (
        stored.type !== 'file' ||
        stored.format !== 'base64' ||
        typeof stored.content !== 'string' ||
        createHash('sha256').update(Buffer.from(stored.content, 'base64')).digest('hex') !== sha256
      ) {
        throw new Error('Remote input content changed; refusing to overwrite it');
      }
    } else {
      await existing.body?.cancel();
      throw new Error('Remote input content could not be verified');
    }
    return {
      state,
      filePath: path.relative(this.root, localPath),
      remotePath,
      kernelRelativePath: path.posix.relative(
        path.posix.dirname(bound.ref.contentPath),
        remotePath
      ),
      sha256,
      size: data.length,
    };
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
      const contentPath = await this.options.useClient(
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
      pending = this.options.useClient(ref.connectionId, ref.serverNamespace, async (client) => {
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
      });
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

  private outputProvenance(cell: Record<string, unknown>, source: string): Record<string, unknown> {
    if (cell.cell_type !== 'code') {
      return {};
    }
    const metadata = cell.metadata as Record<string, unknown> | undefined;
    const provenance = metadata?.jupyter_server_nbmodel_provenance as
      | Record<string, unknown>
      | undefined;
    if (!provenance || typeof provenance.sourceHash !== 'string') {
      return { outputState: 'unverified' };
    }
    return {
      outputState: provenance.sourceHash === hash(source) ? 'current' : 'historical',
      executedSourceHash: provenance.sourceHash,
      ...(typeof provenance.requestId === 'string'
        ? { outputRequestId: provenance.requestId }
        : {}),
    };
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
        ...this.outputProvenance(c, String(c.source)),
      })),
      omittedCells: Math.max(0, snapshot.cells.length - limit),
    };
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
    return this.submit(input, invocation);
  }
  private async submit(input: Record<string, unknown>, invocation: ToolContext): Promise<unknown> {
    const runId = String(input.runId);
    const previous = this.journal.get(runId);
    if (previous) {
      this.record(String(input.notebookId), runId);
      if (
        previous.target.cellId !== input.cellId ||
        previous.target.sourceHash !== input.expectedSourceHash
      ) {
        throw new Error('Notebook runId conflicts with the original attempt');
      }
      return this.observe(previous);
    }
    const bound = await this.bound(String(input.notebookId));
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
      throw new Error('Notebook run does not belong to this Project/resource');
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
    return this.options.useClient(ref.connectionId, ref.serverNamespace, operation);
  }
  private async observe(record: DatalayerRunRecord): Promise<unknown> {
    let current = record;
    if (!terminal.has(record.state) && record.handle) {
      const { handle } = record;
      let observation: Awaited<ReturnType<DatalayerJupyterClient['observe']>>;
      try {
        observation = await this.useRecord(record, (client) => client.observe(handle));
      } catch {
        observation = { state: 'unknown' };
      }
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
    const revision = notebookSnapshotHash(notebook);
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
    const liveRevision = notebookSnapshotHash(bound.doc.notebook.toJSON());
    return {
      revision,
      revisionAlgorithm: 'nbformat-content-sha256-v2',
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

  private async downloadReport(
    notebookId: string,
    invocation: ToolContext
  ): Promise<Record<string, unknown>> {
    const bound = await this.bound(notebookId);
    const report = await this.export(bound);
    const notebookResponse = await bound.client.response(
      `files/${String(report.notebookPath).split('/').map(encodeURIComponent).join('/')}`
    );
    if (!notebookResponse.ok) {
      await notebookResponse.body?.cancel();
      throw new Error('Exported Notebook cannot be downloaded');
    }
    const notebookText = await bound.client.responseText(notebookResponse);
    const snapshot = { content: JSON.parse(notebookText) as Record<string, unknown> };
    if (notebookSnapshotHash(snapshot.content) !== report.revision) {
      throw new Error('Exported Notebook snapshot cannot be verified');
    }
    const response = await bound.client.response(
      `files/${String(report.htmlPath).split('/').map(encodeURIComponent).join('/')}`
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Exported HTML cannot be downloaded');
    }
    const html = await bound.client.responseText(response);
    if (
      !html.includes(`<meta name="disclaude-snapshot-sha256" content="${String(report.revision)}">`)
    ) {
      throw new Error('Exported HTML snapshot cannot be verified');
    }
    const copies: Array<{ name: string; bytes: Buffer; metadata: Record<string, unknown> }> = [
      {
        name: 'report.ipynb',
        bytes: Buffer.from(notebookText),
        metadata: { kind: 'ipynb' },
      },
      { name: 'report.html', bytes: Buffer.from(html), metadata: { kind: 'html' } },
    ];
    let omittedImages = 0;
    for (const [cellIndex, cell] of (
      (snapshot.content.cells ?? []) as Array<Record<string, unknown>>
    ).entries()) {
      for (const [outputIndex, output] of (
        (cell.outputs ?? []) as Array<Record<string, unknown>>
      ).entries()) {
        const mime = output.data as Record<string, unknown> | undefined;
        const mimeType = mime?.['image/png']
          ? 'image/png'
          : mime?.['image/jpeg']
            ? 'image/jpeg'
            : undefined;
        if (!mimeType) {
          continue;
        }
        const value = mime?.[mimeType];
        const encoded = Array.isArray(value) ? value.join('') : value;
        if (
          copies.length >= 6 ||
          typeof encoded !== 'string' ||
          !encoded ||
          encoded.length > 2_000_000 ||
          Buffer.from(encoded, 'base64').toString('base64') !== encoded
        ) {
          omittedImages++;
          continue;
        }
        const source = Array.isArray(cell.source)
          ? cell.source.join('')
          : String(cell.source ?? '');
        copies.push({
          name: `chart-${cellIndex}-${outputIndex}.${mimeType === 'image/png' ? 'png' : 'jpg'}`,
          bytes: Buffer.from(encoded, 'base64'),
          metadata: {
            kind: 'image',
            mimeType,
            cellId: cell.id,
            outputIndex,
            sourceHash: hash(source),
            ...this.outputProvenance(cell, source),
          },
        });
      }
    }
    const directory = createArtifactDirectory(this.root);
    const artifacts = [];
    for (const copy of copies) {
      invocation.signal.throwIfAborted();
      this.assertBound(bound);
      const filePath = path.join(directory, copy.name);
      fs.writeFileSync(filePath, copy.bytes, { mode: 0o600, flag: 'wx' });
      artifacts.push({
        ...copy.metadata,
        filePath,
        bytes: copy.bytes.length,
        sha256: createHash('sha256').update(copy.bytes).digest('hex'),
      });
    }
    return { ...report, state: 'downloaded', artifacts, omittedImages };
  }

  private async requestStop(record: DatalayerRunRecord): Promise<StopObservation> {
    const result: StopObservation = { runId: record.runId, state: 'unknown' };
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

/** Caller-owned, persistent artifacts; no callbacks or channel state. */
export function createArtifactDirectory(root: string): string {
  let directory = fs.realpathSync(root);
  for (const segment of ['.jupyter', 'artifacts']) {
    directory = path.join(directory, segment);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const state = fs.lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error('Unsafe Jupyter artifact directory');
    }
  }
  return fs.mkdtempSync(path.join(directory, 'report-'));
}
