import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { ProjectArtifactIdentity } from './project-artifact.js';

export interface ReviewEvidence { criterion: number; note: string }
export interface TaskReviewDecision {
  id: string; reviewer: string; verdict: 'changes-requested' | 'approved'; reason: string; evidence: ReviewEvidence[]; at: string;
}
export interface TaskSubmission {
  id: string; submitter: string; summary: string; criteria: string[]; artifacts: ProjectArtifactIdentity[]; at: string;
  review?: TaskReviewDecision;
}
export interface TaskReviewRecord {
  version: 1; key: string; revision: number; criteria: string[]; submissions: TaskSubmission[];
  operation: { id: string; digest: string };
}
export interface SubmitTaskArtifacts { id: string; submitter: string; summary: string; refs: string[] }
export interface ReviewTaskSubmission {
  id: string; submissionId: string; reviewer: string; verdict: TaskReviewDecision['verdict']; reason: string; evidence: ReviewEvidence[];
}
export class TaskReviewConflictError extends Error {
  constructor() { super('Task submission changed; read the current revision before continuing'); this.name = 'TaskReviewConflictError'; }
}
const writes = new Map<string, Promise<void>>();
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(item => text(item, max));
const date = (value: unknown): boolean => text(value, 64) && Number.isFinite(Date.parse(value));
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Invalid task review fields');
  }
}
function identity(value: unknown): asserts value is ProjectArtifactIdentity {
  fields(value, ['ref', 'sha256', 'bytes']);
  if (!text(value.ref, 2048) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) { throw new Error('Invalid artifact identity'); }
}
function evidence(value: unknown, count: number, approved: boolean): asserts value is ReviewEvidence[] {
  if (!Array.isArray(value) || value.length > count) { throw new Error('Invalid review evidence'); }
  const seen = new Set<number>();
  for (const entry of value) {
    fields(entry, ['criterion', 'note']);
    if (!Number.isSafeInteger(entry.criterion) || (entry.criterion as number) < 0 || (entry.criterion as number) >= count ||
      seen.has(entry.criterion as number) || !text(entry.note, 4000)) { throw new Error('Invalid review evidence'); }
    seen.add(entry.criterion as number);
  }
  if (approved && seen.size !== count) { throw new Error('Approval must cover every acceptance criterion'); }
}
function record(value: unknown, key: string): asserts value is TaskReviewRecord {
  fields(value, ['version', 'key', 'revision', 'criteria', 'submissions', 'operation']);
  if (value.version !== 1 || value.key !== key || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
    !strings(value.criteria, 4000) || !Array.isArray(value.submissions)) { throw new Error('Invalid task review record'); }
  fields(value.operation, ['id', 'digest']);
  if (!uuid(value.operation.id) || typeof value.operation.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.operation.digest)) { throw new Error('Invalid review operation'); }
  const ids = new Set<string>();
  for (const submission of value.submissions) {
    fields(submission, ['id', 'submitter', 'summary', 'criteria', 'artifacts', 'at', 'review']);
    if (!uuid(submission.id) || ids.has(submission.id) || !text(submission.submitter, 256) || !text(submission.summary, 16000) ||
      !strings(submission.criteria, 4000) || !date(submission.at) || !Array.isArray(submission.artifacts) ||
      submission.artifacts.length < 1 || submission.artifacts.length > 100) { throw new Error('Invalid submission'); }
    ids.add(submission.id); const refs = new Set<string>();
    for (const artifact of submission.artifacts) { identity(artifact); if (refs.has(artifact.ref)) { throw new Error('Duplicate artifact'); } refs.add(artifact.ref); }
    if (submission.review !== undefined) {
      const { review } = submission; fields(review, ['id', 'reviewer', 'verdict', 'reason', 'evidence', 'at']);
      if (!uuid(review.id) || ids.has(review.id) || !text(review.reviewer, 256) || review.reviewer === submission.submitter ||
        !['changes-requested', 'approved'].includes(review.verdict as string) || !text(review.reason, 16000) || !date(review.at)) { throw new Error('Invalid independent review'); }
      ids.add(review.id); evidence(review.evidence, submission.criteria.length, review.verdict === 'approved');
    }
  }
}

/** Single owning service, versioned submission history and exact write retries.
 * The host supplies current authorization and authenticated execution identities.
 * Inspect reads actual artifacts; this store never executes/replays a reviewer.
 */
export class TaskReviewStore {
  readonly directory: string;
  constructor(directory: string, private readonly inspect: (ref: string) => Promise<ProjectArtifactIdentity>) {
    if (!isAbsolute(directory)) { throw new Error('Task review storage must be absolute'); } this.directory = resolve(directory);
  }
  private file(key: string): string {
    if (!text(key, 2048)) { throw new Error('Invalid task review key'); } return join(this.directory, `${digest(key)}.json`);
  }
  async get(key: string): Promise<TaskReviewRecord | undefined> {
    const file = this.file(key);
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error(); }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size > 128 * 1024) { throw new Error(); }
        const value: unknown = JSON.parse(await handle.readFile('utf8')); record(value, key); return value;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw new Error('Cannot read task reviews; preserve and privately restore their storage');
    }
  }
  create(key: string, criteria: string[], operationId: string): Promise<TaskReviewRecord> {
    if (!strings(criteria, 4000)) { throw new Error('Task needs acceptance criteria'); }
    const input = structuredClone(criteria);
    return this.mutate(key, 0, operationId, ['create', input], () => Promise.resolve({ criteria: input, submissions: [] }));
  }
  updateCriteria(key: string, revision: number, criteria: string[], operationId: string): Promise<TaskReviewRecord> {
    if (!strings(criteria, 4000)) { throw new Error('Task needs acceptance criteria'); }
    const input = structuredClone(criteria);
    return this.mutate(key, revision, operationId, ['criteria', input], previous => {
      if (!previous) { throw new Error('Task review record not found'); }
      return Promise.resolve({ ...previous, criteria: input });
    });
  }
  submit(key: string, revision: number, input: SubmitTaskArtifacts): Promise<TaskReviewRecord> {
    fields(input, ['id', 'submitter', 'summary', 'refs']);
    if (!uuid(input.id) || !text(input.submitter, 256) || !text(input.summary, 16000) || !strings(input.refs, 2048) || new Set(input.refs).size !== input.refs.length) { throw new Error('Invalid artifact submission'); }
    const value = structuredClone(input);
    return this.mutate(key, revision, value.id, ['submit', value.submitter, value.summary, value.refs], async previous => {
      if (!previous) { throw new Error('Task review record not found'); }
      const artifacts = await Promise.all(value.refs.map(async ref => {
        const artifact = await this.inspect(ref); identity(artifact); if (artifact.ref !== ref) { throw new Error('Artifact reference changed'); } return structuredClone(artifact);
      }));
      return { ...previous, submissions: [...previous.submissions, { id: value.id, submitter: value.submitter, summary: value.summary,
        criteria: [...previous.criteria], artifacts, at: new Date().toISOString() }] };
    });
  }
  review(key: string, revision: number, input: ReviewTaskSubmission): Promise<TaskReviewRecord> {
    fields(input, ['id', 'submissionId', 'reviewer', 'verdict', 'reason', 'evidence']);
    if (!uuid(input.id) || !uuid(input.submissionId) || !text(input.reviewer, 256) || !text(input.reason, 16000) ||
      !['changes-requested', 'approved'].includes(input.verdict)) { throw new Error('Invalid review decision'); }
    const value = structuredClone(input);
    return this.mutate(key, revision, value.id, ['review', value.submissionId, value.reviewer, value.verdict, value.reason, value.evidence], async previous => {
      if (!previous) { throw new Error('Task review record not found'); }
      const submission = previous.submissions.at(-1);
      if (!submission || submission.id !== value.submissionId || submission.review || value.reviewer === submission.submitter ||
        JSON.stringify(submission.criteria) !== JSON.stringify(previous.criteria)) { throw new Error('Review needs the current submission and an independent reviewer'); }
      evidence(value.evidence, submission.criteria.length, value.verdict === 'approved'); await this.verify(submission.artifacts);
      const review: TaskReviewDecision = { id: value.id, reviewer: value.reviewer, verdict: value.verdict, reason: value.reason, evidence: value.evidence, at: new Date().toISOString() };
      return { ...previous, submissions: [...previous.submissions.slice(0, -1), { ...submission, review }] };
    });
  }
  /** A stored approval describes specific bytes, not present-day completion.
   * Recheck current criteria/revision and bytes before projecting completion.
   */
  async verifyApproved(key: string, revision: number): Promise<TaskReviewRecord> {
    const value = await this.get(key); if (!value || value.revision !== revision) { throw new TaskReviewConflictError(); }
    const submission = value.submissions.at(-1);
    if (!submission?.review || submission.review.verdict !== 'approved' || JSON.stringify(submission.criteria) !== JSON.stringify(value.criteria)) { throw new Error('Current submission has no valid approval'); }
    await this.verify(submission.artifacts);
    if ((await this.get(key))?.revision !== revision) { throw new TaskReviewConflictError(); }
    return value;
  }
  private async verify(artifacts: ProjectArtifactIdentity[]): Promise<void> {
    for (const expected of artifacts) {
      const actual = await this.inspect(expected.ref); identity(actual);
      if (actual.ref !== expected.ref || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) { throw new Error('Artifact changed; submit and review its current bytes'); }
    }
  }
  private async mutate(key: string, expected: number, operationId: string, command: unknown[], transform: (previous?: TaskReviewRecord) => Promise<Pick<TaskReviewRecord, 'criteria' | 'submissions'>>): Promise<TaskReviewRecord> {
    this.file(key);
    if (!uuid(operationId) || !Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) { throw new Error('Invalid review operation identity/revision'); }
    const operation = { id: operationId, digest: digest(JSON.stringify([key, expected, ...command])) };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error('Task review storage must be a real directory'); } await fs.chmod(this.directory, 0o700);
    const canonical = join(await fs.realpath(this.directory), `${digest(key)}.json`);
    const work = (writes.get(canonical) ?? Promise.resolve()).then(async () => {
      const previous = await this.get(key);
      if (previous?.operation.id === operationId) {
        if (previous.revision !== expected + 1 || previous.operation.digest !== operation.digest) { throw new TaskReviewConflictError(); }
        await this.sync(); return previous;
      }
      if ((previous?.revision ?? 0) !== expected) { throw new TaskReviewConflictError(); }
      const next: TaskReviewRecord = { ...await transform(previous), version: 1, key, revision: expected + 1, operation };
      record(next, key); await this.publish(next, !previous); return structuredClone(next);
    });
    const settled = work.then(() => {}, () => {}); writes.set(canonical, settled);
    void settled.then(() => { if (writes.get(canonical) === settled) { writes.delete(canonical); } }); return await work;
  }
  private async sync(): Promise<void> { const handle = await fs.open(this.directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
  private async publish(value: TaskReviewRecord, exclusive: boolean): Promise<void> {
    const data = JSON.stringify(value); if (Buffer.byteLength(data) > 128 * 1024) { throw new Error('Task review history exceeds storage capacity; preserve it before continuing'); }
    const staging = join(this.directory, `.${randomUUID()}.tmp`), handle = await fs.open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(data); await handle.sync(); await handle.close();
      if (exclusive) { await fs.link(staging, this.file(value.key)); } else { await fs.rename(staging, this.file(value.key)); }
      await this.sync();
    } finally { await handle.close().catch(() => {}); await fs.rm(staging, { force: true }).catch(() => {}); }
  }
}
