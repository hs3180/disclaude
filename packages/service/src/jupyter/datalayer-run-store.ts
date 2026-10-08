import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  DatalayerExecutionHandle,
  DatalayerExecutionObservation,
} from '@disclaude/core/jupyter';

export interface DatalayerRunTarget {
  connectionId: string;
  serverNamespace: string;
  contentPath: string;
  documentId: string;
  cellId: string;
  sourceHash: string;
  kernelId: string;
  kernelIncarnation?: string;
  serverInstanceId?: string;
}

export interface DatalayerRunRecord {
  runId: string;
  target: DatalayerRunTarget;
  state: 'submitting' | 'accepted' | 'rejected' | DatalayerExecutionObservation['state'];
  handle?: DatalayerExecutionHandle;
  observation?: DatalayerExecutionObservation;
  observedAt: number;
}

const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const MAX_BYTES = 16 * 1024 * 1024;

/** Host journal, not a replacement execution runtime or a remote idempotency guarantee. */
export class DatalayerRunStore {
  readonly path: string;
  private readonly directory: string;

  constructor(root: string) {
    this.directory = join(fs.realpathSync(root), '.jupyter');
    this.path = join(this.directory, 'datalayer-runs.json');
  }

  private directoryState(create = false): void {
    try {
      const stat = fs.lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Unsafe Notebook journal directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      if (create) {
        fs.mkdirSync(this.directory, { mode: 0o700 });
      }
    }
  }

  records(): DatalayerRunRecord[] {
    this.directoryState();
    try {
      const stat = fs.lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || stat.mode & 0o077) {
        throw new Error('Unsafe Notebook journal');
      }
      const data = JSON.parse(fs.readFileSync(this.path, 'utf8')) as {
        version?: unknown;
        records?: DatalayerRunRecord[];
      };
      if (
        data.version !== 1 ||
        !Array.isArray(data.records) ||
        data.records.length > 256 ||
        data.records.some(
          (r) =>
            !r ||
            typeof r.runId !== 'string' ||
            !r.target ||
            typeof r.target.documentId !== 'string' ||
            typeof r.target.sourceHash !== 'string' ||
            typeof r.state !== 'string'
        )
      ) {
        throw new Error('Invalid Notebook journal');
      }
      return data.records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  get(runId: string): DatalayerRunRecord | undefined {
    return this.records().find((r) => r.runId === runId);
  }

  reserve(runId: string, target: DatalayerRunTarget): DatalayerRunRecord {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(runId)) {
      throw new Error('Invalid Notebook runId');
    }
    const records = this.records();
    const previous = records.find((r) => r.runId === runId);
    if (previous) {
      if (JSON.stringify(previous.target) !== JSON.stringify(target)) {
        throw new Error('Notebook runId already belongs to another execution target');
      }
      return previous;
    }
    if (records.length >= 256) {
      throw new Error('Notebook journal retention limit reached');
    }
    const record: DatalayerRunRecord = {
      runId,
      target,
      state: 'submitting',
      observedAt: Date.now(),
    };
    records.push(record);
    this.persist(records);
    return record;
  }

  update(
    runId: string,
    patch: Partial<Pick<DatalayerRunRecord, 'state' | 'handle' | 'observation'>>
  ): DatalayerRunRecord {
    const records = this.records();
    const index = records.findIndex((r) => r.runId === runId);
    if (index < 0) {
      throw new Error('Notebook runId is not in this Project');
    }
    const previous = records[index];
    if (terminal.has(previous.state)) {
      return previous;
    }
    const record = { ...previous, ...patch, observedAt: Date.now() };
    records[index] = record;
    this.persist(records);
    return record;
  }

  private persist(records: DatalayerRunRecord[]): void {
    this.directoryState(true);
    const text = `${JSON.stringify({ version: 1, records })}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) {
      throw new Error('Notebook journal exceeded its size limit');
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, this.path);
    } finally {
      if (fs.existsSync(temporary)) {
        fs.unlinkSync(temporary);
      }
    }
  }
}
