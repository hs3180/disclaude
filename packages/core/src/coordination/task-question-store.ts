import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export interface TaskQuestion {
  id: string; taskKey: string; question: string;
  chatId: string; actorId: string; sourceMessageId: string; projectRoot: string;
  threadRootId?: string; replyRootId?: string | null;
}
export interface TaskQuestionAnswer {
  /** Actual question-card message, not a fabricated user-message identity. */
  messageId: string; text: string; eventId?: string;
}
export interface TaskQuestionRecord {
  version: 1; revision: number; question: TaskQuestion; cancelled: boolean;
  delivery: 'prepared' | 'sending' | 'delivered' | 'uncertain'; cardMessageId?: string;
  answer?: TaskQuestionAnswer;
  wake: 'none' | 'pending' | 'sending' | 'delivered' | 'uncertain'; wakeReceiptId?: string;
  updatedAt: string;
}
const ids = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const writes = new Map<string, Promise<void>>();
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) { throw new Error('Invalid task question fields'); }
}
function question(value: unknown): asserts value is TaskQuestion {
  fields(value, ['id', 'taskKey', 'question', 'chatId', 'actorId', 'sourceMessageId', 'projectRoot', 'threadRootId', 'replyRootId']);
  if (typeof value.id !== 'string' || !ids.test(value.id) || !text(value.taskKey, 2048) || !text(value.question, 16000) ||
    ![value.chatId, value.actorId, value.sourceMessageId].every(item => text(item, 512)) || !text(value.projectRoot, 4096) || !isAbsolute(value.projectRoot) ||
    value.threadRootId !== undefined && !text(value.threadRootId, 512) || value.replyRootId !== undefined && value.replyRootId !== null && !text(value.replyRootId, 512)) {
    throw new Error('Invalid bound task question');
  }
}
function record(value: unknown, id: string): asserts value is TaskQuestionRecord {
  fields(value, ['version', 'revision', 'question', 'cancelled', 'delivery', 'cardMessageId', 'answer', 'wake', 'wakeReceiptId', 'updatedAt']);
  question(value.question);
  if (value.version !== 1 || value.question.id !== id || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
    typeof value.cancelled !== 'boolean' || !['prepared', 'sending', 'delivered', 'uncertain'].includes(value.delivery as string) ||
    (value.delivery === 'delivered' ? !text(value.cardMessageId, 512) : value.cardMessageId !== undefined) ||
    !['none', 'pending', 'sending', 'delivered', 'uncertain'].includes(value.wake as string) ||
    (value.wake === 'delivered' ? !text(value.wakeReceiptId, 512) || value.wakeReceiptId === id : value.wakeReceiptId !== undefined) ||
    !text(value.updatedAt, 64) || !Number.isFinite(Date.parse(value.updatedAt))) { throw new Error('Invalid task question record'); }
  if (value.answer !== undefined) {
    fields(value.answer, ['messageId', 'text', 'eventId']);
    if (value.delivery !== 'delivered' || value.answer.messageId !== value.cardMessageId || !text(value.answer.text, 16000) ||
      value.answer.eventId !== undefined && !text(value.answer.eventId, 512) || value.wake === 'none') { throw new Error('Invalid task answer'); }
  } else if (value.wake !== 'none') { throw new Error('Cannot wake without an actual answer'); }
}

/** Public business feedback only; private credentials use the private-input path.
 * One owning service authenticates source/callbacks and current permissions.
 * Prepared/sending/uncertain records never authorize an automatic external retry.
 */
export class TaskQuestionStore {
  readonly directory: string;
  constructor(directory: string) { if (!isAbsolute(directory)) { throw new Error('Task question storage must be absolute'); } this.directory = resolve(directory); }
  private file(id: string): string { if (typeof id !== 'string' || !ids.test(id)) { throw new Error('Invalid task question ID'); } return join(this.directory, `${id}.json`); }
  async get(id: string): Promise<TaskQuestionRecord | undefined> {
    const file = this.file(id);
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error(); }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size > 128 * 1024) { throw new Error(); }
        const value: unknown = JSON.parse(await handle.readFile('utf8')); record(value, id); return value;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw new Error('Cannot read task question; preserve and restore its private record');
    }
  }
  async listIds(): Promise<string[]> {
    try {
      if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error(); }
      return (await fs.readdir(this.directory)).filter(name => name.endsWith('.json') && ids.test(name.slice(0, -5))).map(name => name.slice(0, -5)).sort();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw new Error('Cannot list task questions'); }
  }
  async create(input: TaskQuestion): Promise<TaskQuestionRecord> {
    question(input);
    const value: TaskQuestion = { id: input.id, taskKey: input.taskKey, question: input.question, chatId: input.chatId,
      actorId: input.actorId, sourceMessageId: input.sourceMessageId, projectRoot: input.projectRoot,
      ...(input.threadRootId !== undefined ? { threadRootId: input.threadRootId } : {}),
      ...(input.replyRootId !== undefined ? { replyRootId: input.replyRootId } : {}) };
    return await this.serialize(value.id, async () => {
      const old = await this.get(value.id);
      if (old) {
        if (JSON.stringify(old.question) !== JSON.stringify(value)) { throw new Error('Question ID belongs to different work'); }
        await this.sync(); return old;
      }
      const next: TaskQuestionRecord = { version: 1, revision: 1, question: value, cancelled: false, delivery: 'prepared', wake: 'none', updatedAt: new Date().toISOString() };
      await this.save(next, true); return next;
    });
  }
  /** Only the caller that persists a fresh intent may dispatch. Recovered intent
   * returns dispatch:false, even if the preceding acknowledgement was lost.
   */
  async begin(id: string, phase: 'delivery' | 'wake'): Promise<{ record: TaskQuestionRecord; dispatch: boolean }> {
    if (!['delivery', 'wake'].includes(phase)) { throw new Error('Invalid task question phase'); }
    let dispatch = false;
    const value = await this.change(id, current => {
      if (current.cancelled) { throw new Error('Task question was cancelled'); }
      if (phase === 'wake' && !current.answer) { throw new Error('Task question has no answer'); }
      if (current[phase] !== (phase === 'delivery' ? 'prepared' : 'pending')) { return current; }
      dispatch = true; return { ...current, [phase]: 'sending' };
    });
    return { record: value, dispatch };
  }
  /** Host-confirmed platform receipt; route is checked against its bound source. */
  confirmDelivery(id: string, receipt: { messageId: string; chatId: string; threadRootId?: string; replyRootId?: string | null }): Promise<TaskQuestionRecord> {
    const value = structuredClone(receipt);
    return this.change(id, current => {
      if (!text(value.messageId, 512) || value.chatId !== current.question.chatId || value.threadRootId !== current.question.threadRootId ||
        value.replyRootId !== current.question.replyRootId || current.delivery === 'prepared' ||
        current.cardMessageId !== undefined && current.cardMessageId !== value.messageId) { throw new Error('Task question receipt does not match the original route'); }
      return current.delivery === 'delivered' ? current : { ...current, delivery: 'delivered', cardMessageId: value.messageId };
    });
  }
  answer(id: string, input: { actorId: string; chatId: string; messageId: string; text: string; eventId?: string }): Promise<TaskQuestionRecord> {
    const value = structuredClone(input);
    return this.change(id, current => {
      if (current.cancelled || current.delivery !== 'delivered' || value.actorId !== current.question.actorId || value.chatId !== current.question.chatId ||
        value.messageId !== current.cardMessageId || !text(value.text, 16000) || value.eventId !== undefined && !text(value.eventId, 512)) { throw new Error('Answer does not belong to this live task question'); }
      if (current.answer) {
        if (current.answer.text !== value.text) { throw new Error('Question already has an answer; preserve it'); } return current;
      }
      return { ...current, answer: { messageId: value.messageId, text: value.text, ...(value.eventId ? { eventId: value.eventId } : {}) }, wake: 'pending' };
    });
  }
  confirmWake(id: string, receiptId: string): Promise<TaskQuestionRecord> {
    return this.change(id, current => {
      if (!current.answer || !text(receiptId, 512) || receiptId === id || !['sending', 'uncertain', 'delivered'].includes(current.wake) ||
        current.wakeReceiptId !== undefined && current.wakeReceiptId !== receiptId) { throw new Error('No matching admitted task-answer receipt'); }
      return current.wake === 'delivered' ? current : { ...current, wake: 'delivered', wakeReceiptId: receiptId };
    });
  }
  uncertain(id: string, phase: 'delivery' | 'wake'): Promise<TaskQuestionRecord> {
    if (!['delivery', 'wake'].includes(phase)) { throw new Error('Invalid task question phase'); }
    return this.change(id, current => current[phase] === 'sending' ? { ...current, [phase]: 'uncertain' } : current);
  }
  /** Only the dispatch owner may return its exact intent before calling any
   * external port. Unknown/entered RPCs must use uncertain, never this path.
   */
  deferUnsent(id: string, phase: 'delivery' | 'wake', intentRevision: number): Promise<TaskQuestionRecord> {
    if (!['delivery', 'wake'].includes(phase) || !Number.isSafeInteger(intentRevision)) { throw new Error('Invalid unsent task question intent'); }
    return this.change(id, current => {
      if (current.revision !== intentRevision || current[phase] !== 'sending' || current.cancelled) { throw new Error('Task question intent changed; preserve it for reconciliation'); }
      return { ...current, [phase]: phase === 'delivery' ? 'prepared' : 'pending' };
    });
  }
  cancel(id: string): Promise<TaskQuestionRecord> { return this.change(id, current => current.cancelled ? current : { ...current, cancelled: true }); }
  private async change(id: string, update: (current: TaskQuestionRecord) => TaskQuestionRecord): Promise<TaskQuestionRecord> {
    return await this.serialize(id, async () => {
      const current = await this.get(id); if (!current) { throw new Error('Task question not found'); }
      const next = update(structuredClone(current));
      if (JSON.stringify(next) === JSON.stringify(current)) { await this.sync(); return current; }
      if (current.revision === Number.MAX_SAFE_INTEGER) { throw new Error('Task question revision exhausted'); }
      const changed = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      record(changed, id); await this.save(changed, false); return changed;
    });
  }
  private async serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.file(id); await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) { throw new Error('Task question storage must be a real directory'); } await fs.chmod(this.directory, 0o700);
    const key = join(await fs.realpath(this.directory), `${id}.json`), work = (writes.get(key) ?? Promise.resolve()).then(operation);
    const settled = work.then(() => {}, () => {}); writes.set(key, settled);
    void settled.then(() => { if (writes.get(key) === settled) { writes.delete(key); } }); return await work;
  }
  private async sync(): Promise<void> { const handle = await fs.open(this.directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
  private async save(value: TaskQuestionRecord, exclusive: boolean): Promise<void> {
    const body = JSON.stringify(value); if (Buffer.byteLength(body) > 128 * 1024) { throw new Error('Task question exceeds storage capacity'); }
    const staging = join(this.directory, `.${randomUUID()}.tmp`), handle = await fs.open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(body); await handle.sync(); await handle.close();
      if (exclusive) { await fs.link(staging, this.file(value.question.id)); } else { await fs.rename(staging, this.file(value.question.id)); }
      await this.sync();
    } finally { await handle.close().catch(() => {}); await fs.rm(staging, { force: true }).catch(() => {}); }
  }
}
