import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export interface TaskCompletionReport {
  id: string;
  chatId: string;
  projectRoot: string;
  actorId: string;
  sourceMessageId: string;
  threadRootId?: string;
  outcome: 'succeeded' | 'failed' | 'stopped';
  summary: string;
  artifacts: string[];
}
export interface TaskResultRecord {
  version: 1;
  report: TaskCompletionReport;
  delivery: 'pending' | 'sending' | 'delivered' | 'uncertain';
  receiptId?: string;
  updatedAt: string;
}
const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const writes = new Map<string, Promise<void>>();
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
function report(input: TaskCompletionReport): TaskCompletionReport {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['id', 'chatId', 'projectRoot', 'actorId', 'sourceMessageId', 'threadRootId', 'outcome', 'summary', 'artifacts'].includes(key)) ||
      !ids.test(input.id) || ![input.chatId, input.actorId, input.sourceMessageId].every(value => text(value, 512)) ||
      !text(input.projectRoot, 4096) || !isAbsolute(input.projectRoot) ||
      (input.threadRootId !== undefined && !text(input.threadRootId, 512)) ||
      !['succeeded', 'failed', 'stopped'].includes(input.outcome) || !text(input.summary, 16000) ||
      !Array.isArray(input.artifacts) || input.artifacts.length > 100 || input.artifacts.some(value => !text(value, 2000))) {
    throw new Error('Invalid completed task report');
  }
  return { id: input.id, chatId: input.chatId, projectRoot: input.projectRoot, actorId: input.actorId,
    sourceMessageId: input.sourceMessageId, ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
    outcome: input.outcome, summary: input.summary, artifacts: [...input.artifacts] };
}

/** One service-owned durable outbox. It never starts/replays a task and does not
 * infer authority from persisted source strings. Its host must authorize before
 * publishing and before supplying the actual parent-wakeup/delivery callback.
 */
export class TaskResultOutbox {
  readonly directory: string;
  constructor(directory: string) {
    if (!isAbsolute(directory)) { throw new Error('Task result storage must be absolute'); }
    this.directory = resolve(directory);
  }
  private file(id: string): string {
    if (typeof id !== 'string' || !ids.test(id)) { throw new Error('Invalid completed task ID'); }
    return join(this.directory, `${id}.json`);
  }
  async get(id: string): Promise<TaskResultRecord | undefined> {
    const file = this.file(id);
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error(); }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size > 128 * 1024) { throw new Error(); }
        const record = JSON.parse(await handle.readFile('utf8')) as TaskResultRecord;
        if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 ||
            Object.keys(record).some(key => !['version', 'report', 'delivery', 'receiptId', 'updatedAt'].includes(key)) ||
            record.report?.id !== id || !['pending', 'sending', 'delivered', 'uncertain'].includes(record.delivery) ||
            !text(record.updatedAt, 64) || !Number.isFinite(Date.parse(record.updatedAt)) ||
            (record.delivery === 'delivered' ? !text(record.receiptId, 512) || record.receiptId === id : record.receiptId !== undefined)) { throw new Error(); }
        return { ...record, report: report(record.report) };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw new Error('Cannot read task result; restore its private storage');
    }
  }
  async listIds(): Promise<string[]> {
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error(); }
      return (await fs.readdir(this.directory)).filter(name => name.endsWith('.json') && ids.test(name.slice(0, -5))).map(name => name.slice(0, -5)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
      throw new Error('Cannot list task results');
    }
  }
  /** The actual settled result is immutable; an exact retry preserves delivery. */
  async publish(input: TaskCompletionReport): Promise<TaskResultRecord> {
    const payload = report(input);
    return await this.serialize(payload.id, async () => {
      const previous = await this.get(payload.id);
      if (previous) {
        if (JSON.stringify(previous.report) !== JSON.stringify(payload)) { throw new Error('Task result already belongs to different work'); }
        await this.syncDirectory(); return previous;
      }
      const record: TaskResultRecord = { version: 1, report: payload, delivery: 'pending', updatedAt: new Date().toISOString() };
      await this.save(record, true); return structuredClone(record);
    });
  }
  /** Persist intent before external delivery. Concurrent calls share the durable
   * result; an unknown acknowledgement or recovered sending state is not replayed.
   */
  async deliver(id: string, send: (record: Readonly<TaskCompletionReport>) => Promise<string>): Promise<TaskResultRecord> {
    return await this.serialize(id, async () => {
      const current = await this.get(id); if (!current) { throw new Error('Task result not found'); }
      if (current.delivery === 'delivered') { await this.syncDirectory(); return current; }
      if (current.delivery !== 'pending') { throw new Error('Task report delivery needs reconciliation; it was not replayed'); }
      const sending: TaskResultRecord = { ...current, delivery: 'sending', updatedAt: new Date().toISOString() };
      await this.save(sending, false);
      let receiptId: string;
      try {
        receiptId = await send(Object.freeze(structuredClone(current.report)));
        if (!text(receiptId, 512) || receiptId === id) { throw new Error('No confirmed delivery receipt'); }
      } catch {
        await this.save({ ...sending, delivery: 'uncertain', updatedAt: new Date().toISOString() }, false);
        throw new Error('Task report delivery was not confirmed; reconcile it before retrying');
      }
      const delivered: TaskResultRecord = { ...sending, delivery: 'delivered', receiptId, updatedAt: new Date().toISOString() };
      await this.save(delivered, false); return structuredClone(delivered);
    });
  }
  private async serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.file(id);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error('Task result storage must be a real directory'); }
    await fs.chmod(this.directory, 0o700);
    const key = join(await fs.realpath(this.directory), `${id}.json`);
    const work = (writes.get(key) ?? Promise.resolve()).then(operation);
    const done = work.then(() => {}, () => {}); writes.set(key, done);
    void done.then(() => { if (writes.get(key) === done) { writes.delete(key); } });
    return await work;
  }
  private async syncDirectory(): Promise<void> {
    const handle = await fs.open(this.directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); }
  }
  private async save(record: TaskResultRecord, exclusive: boolean): Promise<void> {
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > 128 * 1024) { throw new Error('Task result is too large to persist'); }
    const staging = join(this.directory, `.${randomUUID()}.tmp`), target = this.file(record.report.id);
    const handle = await fs.open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(body); await handle.sync(); await handle.close();
      if (exclusive) { await fs.link(staging, target); } else { await fs.rename(staging, target); }
      await this.syncDirectory();
    } finally { await handle.close().catch(() => {}); await fs.rm(staging, { force: true }).catch(() => {}); }
  }
}
