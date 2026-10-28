import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type GoalStatus = 'draft' | 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';
export type GoalControlAction = 'activate' | 'pause' | 'resume' | 'stop';
export interface GoalAcceptanceCheck {
  /** Zero-based index in the exact requirements revision being assessed. */
  criterion: number;
  satisfied: boolean;
  /** References to artifacts in this report, not unrecorded claims. */
  evidence: string[];
}
export interface GoalTurnReport {
  outcome: 'continue' | 'blocked' | 'completed';
  progress: string;
  artifacts: string[];
  checks: GoalAcceptanceCheck[];
}
export interface GoalAssessment {
  reviewedRevision: number;
  outcome: GoalTurnReport['outcome'];
  checks: GoalAcceptanceCheck[];
}
export interface GoalContent {
  objective: string;
  acceptance: string[];
  progress: string;
  artifacts: string[];
}
export interface GoalRecord extends GoalContent {
  version: 1;
  id: string;
  revision: number;
  chatId: string;
  projectRoot?: string;
  status: GoalStatus;
  lastAssessment?: GoalAssessment;
  createdAt: string;
  updatedAt: string;
}
export type CreateGoal = Pick<GoalRecord, 'objective' | 'acceptance' | 'chatId' | 'projectRoot'>;
export class GoalRevisionConflictError extends Error {
  constructor() { super('Goal changed; read the latest revision before updating'); this.name = 'GoalRevisionConflictError'; }
}

const MAX_BYTES = 128 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const writes = new Map<string, Promise<void>>();
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' && value.length <= max && (empty || !!value.trim());
const list = (value: unknown, max: number, empty = false): value is string[] =>
  Array.isArray(value) && value.length <= 100 && (empty || value.length > 0) && value.every(item => text(item, max));
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Invalid goal fields');
  }
}
function validateContent(value: Partial<GoalContent>): void {
  if ((value.objective !== undefined && !text(value.objective, 16_000))
    || (value.acceptance !== undefined && !list(value.acceptance, 4_000))
    || (value.progress !== undefined && !text(value.progress, 16_000, true))
    || (value.artifacts !== undefined && !list(value.artifacts, 2_000, true))) { throw new Error('Invalid goal content'); }
}
function validateAssessment(value: unknown, revision: number, acceptanceCount: number, artifacts: string[]): void {
  keys(value, ['reviewedRevision', 'outcome', 'checks']);
  if (!Number.isSafeInteger(value.reviewedRevision) || (value.reviewedRevision as number) < 1 ||
      (value.reviewedRevision as number) >= revision || !['continue', 'blocked', 'completed'].includes(value.outcome as string) ||
      !Array.isArray(value.checks) || value.checks.length > acceptanceCount) { throw new Error('Invalid goal assessment'); }
  const indices = new Set<number>();
  for (const check of value.checks) {
    keys(check, ['criterion', 'satisfied', 'evidence']);
    if (!Number.isSafeInteger(check.criterion) || (check.criterion as number) < 0 ||
        (check.criterion as number) >= acceptanceCount || indices.has(check.criterion as number) ||
        typeof check.satisfied !== 'boolean' || !list(check.evidence, 2_000, !check.satisfied) ||
        !check.evidence.every(item => artifacts.includes(item))) { throw new Error('Invalid goal acceptance evidence'); }
    indices.add(check.criterion as number);
  }
  if (value.outcome === 'completed' && (indices.size !== acceptanceCount ||
      value.checks.some(check => check.satisfied !== true))) { throw new Error('Goal completion requires evidence for every acceptance condition'); }
}

function validateRecord(value: unknown, id: string): asserts value is GoalRecord {
  keys(value, ['version', 'id', 'revision', 'chatId', 'projectRoot', 'status', 'createdAt', 'updatedAt', 'objective', 'acceptance', 'progress', 'artifacts', 'lastAssessment']);
  if (value.version !== 1 || value.id !== id || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !text(value.chatId, 512) || (value.projectRoot !== undefined && (!text(value.projectRoot, 4_096) || !isAbsolute(value.projectRoot)))
    || !['draft', 'active', 'paused', 'blocked', 'completed', 'abandoned'].includes(value.status as string)
    || !text(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))
    || !text(value.updatedAt, 64) || !Number.isFinite(Date.parse(value.updatedAt))
    || !text(value.objective, 16_000) || !list(value.acceptance, 4_000)
    || !text(value.progress, 16_000, true) || !list(value.artifacts, 2_000, true)) { throw new Error('Invalid goal record'); }
  if (value.lastAssessment !== undefined) {
    validateAssessment(value.lastAssessment, value.revision as number, value.acceptance.length, value.artifacts);
    const assessment = value.lastAssessment as unknown as GoalAssessment;
    if ((assessment.outcome === 'completed') !== (value.status === 'completed')) { throw new Error('Invalid goal completion state'); }
  }
}

/**
 * Private Goal records for one owning service process. All writers must use
 * that service; this is not a cross-process claim/lock or an execution loop.
 * No timer, scheduler, inferred goal creation, or cost budget lives here.
 */
export class GoalStore {
  readonly directory: string;
  constructor(directory: string) {
    if (!isAbsolute(directory)) { throw new Error('Goal store directory must be absolute'); }
    this.directory = resolve(directory);
  }
  private file(id: string): string {
    if (!idPattern.test(id)) { throw new Error('Invalid goal ID'); }
    return join(this.directory, `${id}.json`);
  }
  private async prepare(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error('Goal store must be a real directory'); }
    await fs.chmod(this.directory, 0o700);
  }
  /** Discover durable identities after restart; unknown and staging files stay untouched. */
  async listIds(): Promise<string[]> {
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error('Goal store must be a real directory'); }
      return (await fs.readdir(this.directory)).filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5)))
        .map(name => name.slice(0, -5)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
      throw new Error('Cannot list goal records; repair the storage directory privately');
    }
  }
  async get(id: string): Promise<GoalRecord | undefined> {
    const file = this.file(id);
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error(); }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) { throw new Error(); }
        const record: unknown = JSON.parse(await handle.readFile('utf8'));
        validateRecord(record, id);
        return record;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw new Error('Cannot read goal record; repair or restore it privately');
    }
  }
  async create(input: CreateGoal): Promise<GoalRecord> {
    keys(input, ['objective', 'acceptance', 'chatId', 'projectRoot']);
    if (!text(input.chatId, 512) || !text(input.objective, 16_000) || !list(input.acceptance, 4_000)
      || (input.projectRoot !== undefined && (!text(input.projectRoot, 4_096) || !isAbsolute(input.projectRoot)))) { throw new Error('Invalid goal creation'); }
    const now = new Date().toISOString();
    const snapshot = structuredClone(input);
    const record: GoalRecord = { chatId: snapshot.chatId, objective: snapshot.objective, acceptance: snapshot.acceptance,
      ...(snapshot.projectRoot !== undefined ? { projectRoot: snapshot.projectRoot } : {}), version: 1, id: randomUUID(), revision: 1,
      status: 'draft', progress: '', artifacts: [], createdAt: now, updatedAt: now };
    await this.publish(record, true);
    return structuredClone(record);
  }
  async update(id: string, expectedRevision: number, patch: Partial<GoalContent>): Promise<GoalRecord> {
    keys(patch, ['objective', 'acceptance', 'progress', 'artifacts']);
    if (Object.values(patch).some(value => value === undefined)) { throw new Error('Invalid goal update'); }
    validateContent(patch);
    const snapshot = structuredClone(patch);
    return await this.change(id, expectedRevision, previous => {
      const revised = { ...previous, ...snapshot };
      // Content edits invalidate a prior assessment, including its artifact references.
      delete revised.lastAssessment;
      return revised;
    });
  }
  /** Persist the settled turn's assessment against exactly the active revision.
   * The execution adapter must validate authority and actual work settlement.
   * Evidence references are recorded assertions, not verification of their contents.
   */
  async recordTurn(id: string, expectedRevision: number, report: GoalTurnReport): Promise<GoalRecord> {
    keys(report, ['outcome', 'progress', 'artifacts', 'checks']);
    validateContent({ progress: report.progress, artifacts: report.artifacts });
    if (!text(report.progress, 16_000) || !list(report.artifacts, 2_000, true)) { throw new Error('Invalid goal turn report'); }
    const snapshot = structuredClone(report);
    return await this.change(id, expectedRevision, previous => {
      if (previous.status !== 'active') { throw new Error('Goal is not active'); }
      const assessment: GoalAssessment = { reviewedRevision: expectedRevision, outcome: snapshot.outcome, checks: snapshot.checks };
      validateAssessment(assessment, previous.revision + 1, previous.acceptance.length, snapshot.artifacts);
      const status: Record<GoalTurnReport['outcome'], GoalStatus> = { continue: 'active', blocked: 'blocked', completed: 'completed' };
      return { ...previous, status: status[snapshot.outcome], progress: snapshot.progress,
        artifacts: snapshot.artifacts, lastAssessment: assessment };
    });
  }

  /**
   * Persist an explicit user command. The authenticated entry point must check
   * user/chat authority before calling and separately reconcile/cancel native
   * work. This storage operation never starts a turn or certifies completion.
   */
  async control(id: string, expectedRevision: number, action: GoalControlAction): Promise<GoalRecord> {
    const transitions: Record<GoalControlAction, Partial<Record<GoalStatus, GoalStatus>>> = {
      activate: { draft: 'active' }, pause: { active: 'paused' },
      resume: { paused: 'active', blocked: 'active' },
      stop: { draft: 'abandoned', active: 'abandoned', paused: 'abandoned', blocked: 'abandoned' },
    };
    if (!Object.hasOwn(transitions, action)) { throw new Error('Invalid goal control'); }
    return await this.change(id, expectedRevision, previous => {
      const status = transitions[action][previous.status];
      if (!status) { throw new Error('Goal control is not valid in the current state'); }
      return { ...previous, status };
    });
  }
  private async change(id: string, expectedRevision: number, edit: (previous: GoalRecord) => GoalRecord): Promise<GoalRecord> {
    this.file(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) { throw new Error('Invalid goal revision'); }
    // Canonicalize existing storage so parent-directory aliases share a queue.
    const file = join(await fs.realpath(this.directory), `${id}.json`);
    const operation = (writes.get(file) ?? Promise.resolve()).then(async () => {
      const previous = await this.get(id);
      if (!previous) { throw new Error('Goal not found'); }
      if (previous.revision !== expectedRevision) { throw new GoalRevisionConflictError(); }
      if (['completed', 'abandoned'].includes(previous.status)) { throw new Error('Cannot edit a terminal goal'); }
      if (previous.revision === Number.MAX_SAFE_INTEGER) { throw new Error('Goal revision exhausted'); }
      const record = { ...edit(previous), revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      await this.publish(record, false);
      return structuredClone(record);
    });
    const settled = operation.then(() => {}, () => {});
    writes.set(file, settled);
    void settled.then(() => { if (writes.get(file) === settled) { writes.delete(file); } });
    return await operation;
  }
  private async publish(record: GoalRecord, exclusive: boolean): Promise<void> {
    const file = this.file(record.id);
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > MAX_BYTES) { throw new Error('Goal record exceeds the storage limit'); }
    await this.prepare();
    const staging = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await fs.open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(data); await handle.sync(); await handle.close();
      if (exclusive) { await fs.link(staging, file); } else { await fs.rename(staging, file); }
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(staging, { force: true }).catch(() => {});
    }
  }
}
