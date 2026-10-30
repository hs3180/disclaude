import type { TaskQuestion, TaskQuestionRecord, TaskQuestionStore } from '@disclaude/core';

type Receipt = { messageId: string; chatId: string; threadRootId?: string; replyRootId?: string | null };
export interface TaskQuestionFlowPorts {
  store: TaskQuestionStore;
  /** Current authority, not authentication inferred from persisted strings. */
  authorize(question: Readonly<TaskQuestion>, phase: 'send' | 'answer' | 'wake'): void | Promise<void>;
  send(question: Readonly<TaskQuestion>): Promise<Receipt>;
  /** Verify the actual platform card/token/original route on an early callback. */
  reconcileCard(question: Readonly<TaskQuestion>, messageId: string): Promise<Receipt>;
  wake(record: Readonly<TaskQuestionRecord>): Promise<string>;
  /** Read actual original-task admission; never dispatch another input here. */
  admitted(record: Readonly<TaskQuestionRecord>): Promise<string | undefined>;
}

/** Finite host operations, never a promise waiting on a future human answer.
 * Call acceptAuthenticatedAnswer only from a verified channel callback, not a
 * model tool/REST body. The host retains Goal/Project and task control gates.
 */
export class TaskQuestionFlow {
  private closing = false;
  private readonly active = new Set<Promise<unknown>>();
  private closeFlight?: Promise<void>;
  constructor(private readonly ports: TaskQuestionFlowPorts) {}
  get busy(): boolean { return this.active.size > 0; }
  ask(question: TaskQuestion): Promise<TaskQuestionRecord> {
    const input = Object.freeze(structuredClone(question));
    return this.track(async () => {
      await this.ports.authorize(input, 'send');
      if (this.closing) { throw new Error('Task question flow is closing'); }
      await this.ports.store.create(input);
      if (this.closing) { throw new Error('Task question flow is closing'); }
      const intent = await this.ports.store.begin(input.id, 'delivery');
      if (!intent.dispatch) {
        if (intent.record.delivery === 'delivered') { return intent.record; }
        throw new Error('Question delivery needs reconciliation; no card was resent');
      }
      let dispatched = false;
      try {
        await this.ports.authorize(input, 'send');
        if (this.closing) { throw new Error('Task question flow is closing'); }
        dispatched = true; const receipt = await this.ports.send(input);
        return await this.ports.store.confirmDelivery(input.id, receipt);
      } catch {
        if (dispatched) { await this.ports.store.uncertain(input.id, 'delivery'); }
        else { await this.ports.store.deferUnsent(input.id, 'delivery', intent.record.revision); }
        const current = await this.read(input.id);
        if (current.delivery === 'delivered') { return current; }
        throw new Error('Question delivery was not confirmed; preserve its known state');
      }
    });
  }
  acceptAuthenticatedAnswer(id: string, input: { actorId: string; chatId: string; messageId: string; text: string; eventId?: string }): Promise<TaskQuestionRecord> {
    const answer = structuredClone(input);
    return this.track(async () => {
      let current = await this.read(id); const { question } = current;
      if (current.cancelled || answer.actorId !== question.actorId || answer.chatId !== question.chatId || current.delivery === 'prepared') {
        throw new Error('Callback does not belong to this live task question');
      }
      await this.ports.authorize(question, 'answer');
      if (current.delivery !== 'delivered') {
        const receipt = await this.ports.reconcileCard(Object.freeze(structuredClone(question)), answer.messageId);
        if (receipt.messageId !== answer.messageId) { throw new Error('Callback card was not verified'); }
        current = await this.ports.store.confirmDelivery(id, receipt);
      }
      await this.ports.authorize(current.question, 'answer');
      return await this.ports.store.answer(id, answer);
    });
  }
  wake(id: string): Promise<TaskQuestionRecord> {
    return this.track(async () => {
      const current = await this.read(id); await this.ports.authorize(current.question, 'wake');
      if (this.closing) { throw new Error('Task question flow is closing'); }
      const intent = await this.ports.store.begin(id, 'wake');
      if (!intent.dispatch) {
        if (intent.record.wake === 'delivered') { return intent.record; }
        throw new Error('Task answer admission needs reconciliation; no input was repeated');
      }
      let dispatched = false;
      try {
        if (this.closing) { throw new Error('Task question flow is closing'); }
        await this.ports.authorize(intent.record.question, 'wake');
        if (this.closing) { throw new Error('Task question flow is closing'); }
        dispatched = true; const receipt = await this.ports.wake(Object.freeze(structuredClone(intent.record)));
        return await this.ports.store.confirmWake(id, receipt);
      } catch {
        if (dispatched) { await this.ports.store.uncertain(id, 'wake'); }
        else { await this.ports.store.deferUnsent(id, 'wake', intent.record.revision); }
        throw new Error('Task answer admission was not confirmed; reconcile the original input');
      }
    });
  }
  reconcileWake(id: string): Promise<TaskQuestionRecord> {
    return this.track(async () => {
      const current = await this.read(id); await this.ports.authorize(current.question, 'wake');
      if (current.cancelled || !['sending', 'uncertain', 'delivered'].includes(current.wake)) { throw new Error('No task-answer admission to reconcile'); }
      if (current.wake === 'delivered') { return current; }
      const receipt = await this.ports.admitted(Object.freeze(structuredClone(current)));
      if (!receipt) { throw new Error('Original task answer has no confirmed admission; it was not repeated'); }
      return await this.ports.store.confirmWake(id, receipt);
    });
  }
  close(): Promise<void> {
    this.closing = true;
    this.closeFlight ??= Promise.allSettled([...this.active]).then(() => {}); return this.closeFlight;
  }
  private async read(id: string): Promise<TaskQuestionRecord> {
    const value = await this.ports.store.get(id); if (!value) { throw new Error('Task question not found'); } return value;
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) { return Promise.reject(new Error('Task question flow is closing')); }
    const work = operation(); this.active.add(work);
    const settled = (): void => { this.active.delete(work); }; void work.then(settled, settled); return work;
  }
}

/** Apply after normal task/Goal permission and lifecycle filtering. This only
 * gates questions; it cannot activate paused/stopped work or complete a Goal.
 */
export function taskQuestionReadiness(taskKeys: readonly string[], questions: readonly TaskQuestionRecord[], activeExecutions: number): {
  ready: string[]; waiting: string[]; attention: string[]; state: 'runnable' | 'running' | 'waiting' | 'needs-reconciliation' | 'idle';
} {
  if (!Number.isSafeInteger(activeExecutions) || activeExecutions < 0) { throw new Error('Invalid active execution count'); }
  const ready: string[] = [], waiting: string[] = [], attention: string[] = [];
  for (const key of new Set(taskKeys)) {
    const pending = questions.filter(value => value.question.taskKey === key && !value.cancelled && value.wake !== 'delivered');
    if (!pending.length) { ready.push(key); }
    else if (pending.every(value => value.delivery === 'delivered' && !value.answer)) { waiting.push(key); }
    else { attention.push(key); }
  }
  return { ready, waiting, attention, state: ready.length ? 'runnable' : activeExecutions ? 'running' : attention.length ? 'needs-reconciliation' : waiting.length ? 'waiting' : 'idle' };
}
