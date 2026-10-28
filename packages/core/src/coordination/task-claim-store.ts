import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export interface TaskClaimSnapshot { key: string; revision: number; owner?: string }
export interface TaskClaimLease extends TaskClaimSnapshot { owner: string; claimId: string }
export class TaskClaimConflictError extends Error {
  constructor() { super('Task claim changed or belongs to another owner; read its latest revision'); this.name = 'TaskClaimConflictError'; }
}
interface Record {
  version: 1; key: string; revision: number; owner: string | null;
  claimHash: string | null; released?: string; updatedAt: string;
}
const writes = new Map<string, Promise<void>>();
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const revision = (value: number, minimum = 0): boolean => Number.isSafeInteger(value) && value >= minimum;
const claimIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const snapshot = (key: string, record?: Record): TaskClaimSnapshot => ({ key, revision: record?.revision ?? 0,
  ...(record?.owner ? { owner: record.owner } : {}) });
const fingerprint = (lease: TaskClaimLease): string => hash(JSON.stringify([lease.key, lease.revision, lease.owner, lease.claimId]));

/** Private reservations owned by ONE service process. Managed workers call that
 * service, never open this store in separate CLI/worker processes. It does not
 * start agents, edit a remote board, infer authority, or expire claims by time.
 */
export class TaskClaimStore {
  readonly directory: string;
  constructor(directory: string) {
    if (!isAbsolute(directory)) { throw new Error('Task claim storage must be absolute'); }
    this.directory = resolve(directory);
  }
  private file(key: string): string {
    if (!text(key, 2048)) { throw new Error('Invalid task claim key'); }
    return join(this.directory, `${hash(key)}.json`);
  }
  private async read(key: string): Promise<Record | undefined> {
    const file = this.file(key);
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error(); }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 16_384) { throw new Error(); }
        const record = JSON.parse(await handle.readFile('utf8')) as Record;
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || Object.keys(record).some(name => !['version', 'key', 'revision', 'owner', 'claimHash', 'released', 'updatedAt'].includes(name))
          || record.version !== 1 || record.key !== key || !revision(record.revision, 1)
          || !text(record.updatedAt, 64) || !Number.isFinite(Date.parse(record.updatedAt))
          || (record.owner === null
            ? record.claimHash !== null || typeof record.released !== 'string' || !digestPattern.test(record.released)
            : !text(record.owner, 256) || typeof record.claimHash !== 'string' || !digestPattern.test(record.claimHash) || record.released !== undefined)) {
          throw new Error();
        }
        return record;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw new Error('Cannot read task claim; restore its storage privately');
    }
  }
  async get(key: string): Promise<TaskClaimSnapshot> { return snapshot(key, await this.read(key)); }

  /** Supply a host-created claimId before an RPC if its acknowledgement may be
   * lost. The exact same claim/revision is idempotent; a different worker loses.
   */
  async claim(key: string, expectedRevision: number, owner: string, claimId: string = randomUUID()): Promise<TaskClaimLease> {
    this.file(key);
    if (!revision(expectedRevision) || !text(owner, 256) || typeof claimId !== 'string' || !claimIdPattern.test(claimId)) { throw new Error('Invalid task claim'); }
    claimId = claimId.toLowerCase();
    return await this.serialize(key, async () => {
      const previous = await this.read(key);
      if (previous?.owner === owner && previous.claimHash === hash(claimId) && previous.revision === expectedRevision + 1) {
        await this.syncDirectory();
        return { ...snapshot(key, previous), owner, claimId };
      }
      if (previous?.owner || (previous?.revision ?? 0) !== expectedRevision) { throw new TaskClaimConflictError(); }
      const next = this.nextRevision(previous?.revision ?? 0);
      await this.publish({ version: 1, key, revision: next, owner, claimHash: hash(claimId), updatedAt: new Date().toISOString() }, !previous);
      return { key, revision: next, owner, claimId };
    });
  }
  async release(lease: TaskClaimLease): Promise<TaskClaimSnapshot> {
    this.file(lease.key);
    if (Object.keys(lease).some(name => !['key', 'revision', 'owner', 'claimId'].includes(name))
      || !revision(lease.revision, 1) || !text(lease.owner, 256) || typeof lease.claimId !== 'string'
      || !claimIdPattern.test(lease.claimId)) { throw new Error('Invalid task claim lease'); }
    const input = { ...structuredClone(lease), claimId: lease.claimId.toLowerCase() };
    return await this.serialize(input.key, async () => {
      const previous = await this.read(input.key);
      if (previous?.owner === null && previous.revision === input.revision + 1 && previous.released === fingerprint(input)) {
        await this.syncDirectory(); return snapshot(input.key, previous);
      }
      if (!previous || previous.revision !== input.revision || previous.owner !== input.owner
        || previous.claimHash !== hash(input.claimId)) { throw new TaskClaimConflictError(); }
      const record: Record = { version: 1, key: input.key, revision: this.nextRevision(previous.revision), owner: null,
        claimHash: null, released: fingerprint(input), updatedAt: new Date().toISOString() };
      await this.publish(record, false); return snapshot(input.key, record);
    });
  }
  private nextRevision(previous: number): number {
    if (previous === Number.MAX_SAFE_INTEGER) { throw new Error('Task claim revision exhausted'); }
    return previous + 1;
  }
  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error('Task claim storage must be a real directory'); }
    await fs.chmod(this.directory, 0o700);
    const file = join(await fs.realpath(this.directory), `${hash(key)}.json`);
    const work = (writes.get(file) ?? Promise.resolve()).then(operation);
    const settled = work.then(() => {}, () => {});
    writes.set(file, settled);
    void settled.then(() => { if (writes.get(file) === settled) { writes.delete(file); } });
    return await work;
  }
  private async syncDirectory(): Promise<void> {
    const handle = await fs.open(this.directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async publish(record: Record, exclusive: boolean): Promise<void> {
    const file = this.file(record.key), staging = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await fs.open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close();
      if (exclusive) { await fs.link(staging, file); } else { await fs.rename(staging, file); }
      await this.syncDirectory();
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(staging, { force: true }).catch(() => {});
    }
  }
}
