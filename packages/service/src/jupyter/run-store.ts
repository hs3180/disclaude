import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  JupyterControllerGeneration,
  JupyterExecutionHandle,
  JupyterExecutionState,
  JupyterExecutionTarget,
} from '@disclaude/core';

export type NotebookAttemptState = JupyterExecutionState | 'prepared' | 'rejected' | 'not_started';

export interface NotebookRunRecord {
  target: JupyterExecutionTarget;
  handle?: JupyterExecutionHandle;
  state: NotebookAttemptState;
  createdAt: number;
  observedAt: number;
  stopRequested?: boolean;
}

interface Records {
  version: 1;
  ownerId: string;
  leases: Record<string, JupyterControllerGeneration>;
  runs: Record<string, NotebookRunRecord>;
}

const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected', 'not_started']);
const states = new Set([
  ...terminal,
  'prepared',
  'queued',
  'running',
  'input_required',
  'stopping',
  'unknown',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Notebook execution record');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Invalid Notebook execution identifier');
  }
}

function controller(value: unknown): asserts value is JupyterControllerGeneration {
  const data = object(value);
  text(data.ownerId);
  if (!Number.isSafeInteger(data.generation) || Number(data.generation) < 0) {
    throw new Error('Invalid Notebook execution generation');
  }
}

function target(value: unknown): asserts value is JupyterExecutionTarget {
  const data = object(value);
  const notebook = object(data.notebook);
  const identity = object(notebook.identity);
  for (const key of ['connectionId', 'serverNamespace', 'documentId']) {
    text(identity[key]);
  }
  text(notebook.contentPath);
  if (
    String(notebook.contentPath).startsWith('/') ||
    String(notebook.contentPath)
      .split('/')
      .some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error('Invalid Notebook server path');
  }
  for (const key of [
    'cellId',
    'expectedRevision',
    'sourceHash',
    'kernelId',
    'kernelIncarnation',
    'runId',
  ]) {
    text(data[key]);
  }
  if (!uuid.test(String(data.runId))) {
    throw new Error('Invalid Notebook run ID');
  }
  controller(data.controller);
}

/** Metadata only, with one Service writer; the Jupyter ledger remains authoritative. */
export class NotebookRunStore {
  readonly path: string;

  constructor(workingDir: string, conversationKey: string) {
    const key = createHash('sha256').update(conversationKey).digest('hex');
    this.path = join(workingDir, '.jupyter', 'executions', `${key}.json`);
  }

  private load(): Records {
    let raw: string;
    try {
      const stat = fs.lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3_000_000) {
        throw new Error('Notebook execution records cannot be verified');
      }
      raw = fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, ownerId: `disclaude:${randomUUID()}`, leases: {}, runs: {} };
      }
      throw error;
    }
    const data = object(JSON.parse(raw));
    if (data.version !== 1) {
      throw new Error('Unsupported Notebook execution record version');
    }
    text(data.ownerId);
    const leases = object(data.leases);
    const runs = object(data.runs);
    for (const [key, value] of Object.entries(leases)) {
      if (!/^[0-9a-f]{64}$/.test(key)) {
        throw new Error('Invalid Notebook lease key');
      }
      controller(value);
      if (value.ownerId !== data.ownerId) {
        throw new Error('Notebook lease has another owner');
      }
    }
    for (const [key, value] of Object.entries(runs)) {
      const record = object(value);
      target(record.target);
      if (
        record.target.runId !== key ||
        record.target.controller.ownerId !== data.ownerId ||
        !states.has(String(record.state)) ||
        !Number.isSafeInteger(record.createdAt) ||
        !Number.isSafeInteger(record.observedAt) ||
        (record.stopRequested !== undefined && typeof record.stopRequested !== 'boolean')
      ) {
        throw new Error('Invalid Notebook run record');
      }
      if (record.handle !== undefined) {
        target(record.handle);
        text(object(record.handle).requestId);
        if (
          JSON.stringify(handleTarget(record.handle)) !==
          JSON.stringify(handleTarget(record.target))
        ) {
          throw new Error('Notebook handle has another target');
        }
      }
    }
    return data as unknown as Records;
  }

  private save(records: Records): void {
    const settled = Object.values(records.runs)
      .filter((r) => terminal.has(r.state))
      .sort((a, b) => b.observedAt - a.observedAt);
    for (const record of settled.slice(256)) {
      delete records.runs[record.target.runId];
    }
    if (Object.values(records.runs).filter((r) => !terminal.has(r.state)).length > 256) {
      throw new Error('Unreconciled Notebook execution record limit reached');
    }
    const data = `${JSON.stringify(records)}\n`;
    if (Buffer.byteLength(data) > 3_000_000) {
      throw new Error('Notebook execution record limit reached');
    }
    fs.mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.path);
      const directory = fs.openSync(dirname(this.path), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (created) {
        try {
          fs.unlinkSync(temp);
        } catch {
          /* Successful rename removed it. */
        }
      }
    }
  }

  ownerId(): string {
    const data = this.load();
    this.save(data);
    return data.ownerId;
  }

  lease(key: string): JupyterControllerGeneration | undefined {
    return this.load().leases[key];
  }

  saveLease(key: string, value: JupyterControllerGeneration): void {
    const data = this.load();
    if (value.ownerId !== data.ownerId) {
      throw new Error('Cannot adopt another Notebook owner');
    }
    data.leases[key] = value;
    this.save(data);
  }

  prepare(execution: JupyterExecutionTarget): void {
    const data = this.load();
    if (execution.controller.ownerId !== data.ownerId || data.runs[execution.runId]) {
      throw new Error('Notebook execution owner or run ID changed');
    }
    const time = Date.now();
    data.runs[execution.runId] = {
      target: execution,
      state: 'prepared',
      createdAt: time,
      observedAt: time,
    };
    this.save(data);
  }

  observe(runId: string, state: NotebookAttemptState, handle?: JupyterExecutionHandle): void {
    const data = this.load();
    const record = data.runs[runId];
    if (!record) {
      throw new Error('Notebook execution has no prepared record');
    }
    if (
      handle &&
      (JSON.stringify(handleTarget(handle)) !== JSON.stringify(handleTarget(record.target)) ||
        (record.handle && handle.requestId !== record.handle.requestId))
    ) {
      throw new Error('Notebook execution identity changed');
    }
    // A failed read cannot erase a previously verified terminal outcome.
    // A contradictory server observation with its exact handle remains observable.
    if (terminal.has(record.state) && state === 'unknown' && !handle) {
      return;
    }
    record.state = state;
    record.observedAt = Date.now();
    if (handle) {
      record.handle = handle;
    }
    this.save(data);
  }

  records(): NotebookRunRecord[] {
    return Object.values(this.load().runs);
  }

  requestStop(): void {
    const data = this.load();
    for (const record of Object.values(data.runs)) {
      if (!terminal.has(record.state)) {
        record.stopRequested = true;
      }
    }
    this.save(data);
  }
}

/** Compare every persisted target field without relying on object property order. */
export function handleTarget(value: JupyterExecutionTarget): unknown[] {
  const { identity } = value.notebook;
  return [
    identity.connectionId,
    identity.serverNamespace,
    identity.documentId,
    value.cellId,
    value.expectedRevision,
    value.sourceHash,
    value.kernelId,
    value.kernelIncarnation,
    value.runId,
    value.controller.ownerId,
    value.controller.generation,
  ];
}
