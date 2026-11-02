import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { TaskResultOutbox, sanitizeDiagnosticText, type TaskCompletionReport, type TaskResultRecord } from '@disclaude/core';
import { AgentTaskRunner, type AgentTaskRequest } from './agent-task-runner.js';
import type { AgentCreateOptions } from './factory.js';
import type { ChatAgentCallbacks } from './types.js';

export interface BackgroundAgentTaskRequest extends AgentTaskRequest { projectRoot: string }
export interface BackgroundAgentTaskOptions {
  outbox: TaskResultOutbox;
  /** Trusted host permission and current Project check, including before wakeup. */
  authorize(request: Readonly<BackgroundAgentTaskRequest>): void | Promise<void>;
  runtimeOptions(request: Readonly<BackgroundAgentTaskRequest>): AgentCreateOptions;
  callbacks(request: Readonly<BackgroundAgentTaskRequest>): ChatAgentCallbacks;
  wakeParent(report: Readonly<TaskCompletionReport>): Promise<string>;
}
export interface BackgroundAgentTaskHandle {
  id: string;
  completion: Promise<TaskResultRecord>;
  stop(): void;
}
type Entry = {
  fingerprint: string; chatId: string; threadRootId?: string; busy: boolean; stopped: boolean;
  id?: string; admission?: Promise<BackgroundAgentTaskHandle>; stopNative?: () => void;
};

/** Service owns child work after the parent's tool/turn returns. Parent wakeup
 * is an injected admitted port, not an invented successful channel callback.
 */
export class BackgroundAgentTasks {
  private readonly operations = new Map<string, Entry>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;
  private closeFlight?: Promise<void>;
  constructor(private readonly options: BackgroundAgentTaskOptions) {}

  async start(operationId: string, request: BackgroundAgentTaskRequest): Promise<BackgroundAgentTaskHandle> {
    if (this.closing) { throw new Error('Background task owner is closing'); }
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(operationId)) { throw new Error('Invalid background operation ID'); }
    if (!isAbsolute(request.workingDirectory) || !isAbsolute(request.projectRoot)) { throw new Error('Background task needs an absolute Project and directory'); }
    const input = Object.freeze({ ...structuredClone(request), workingDirectory: realpathSync(request.workingDirectory), projectRoot: realpathSync(request.projectRoot) });
    const path = relative(input.projectRoot, input.workingDirectory);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) { throw new Error('Background task directory is outside its Project'); }
    const key = JSON.stringify([input.chatId, input.senderOpenId, input.sourceMessageId, input.threadRootId ?? null, operationId]);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.task, input.projectRoot, input.workingDirectory, input.chatType ?? null,
      input.replyRootId === undefined ? 'unspecified' : input.replyRootId])).digest('hex');
    const existing = this.operations.get(key);
    if (existing) {
      await this.options.authorize(input);
      if (existing.fingerprint !== fingerprint) { throw new Error('Background operation already belongs to different work'); }
      if (existing.admission) { return await existing.admission; }
      if (!existing.id) { throw new Error('Background admission did not complete'); }
      const { id } = existing;
      return { id, stop: () => {}, completion: this.options.outbox.get(id).then(async record => {
        if (!record) { throw new Error('Existing background task needs result reconciliation; work was not repeated'); }
        await this.options.authorize(input);
        return record;
      }) };
    }
    const entry: Entry = { fingerprint, chatId: input.chatId, threadRootId: input.threadRootId, busy: true, stopped: false };
    this.operations.set(key, entry);
    entry.admission = this.admit(input, entry);
    const { admission } = entry;
    void admission.catch(() => { if (!entry.id) { this.operations.delete(key); entry.busy = false; } });
    this.track(admission);
    return await admission;
  }
  private track(work: Promise<unknown>): void {
    this.inFlight.add(work);
    const release = (): void => { this.inFlight.delete(work); };
    void work.then(release, release);
  }
  private async admit(input: Readonly<BackgroundAgentTaskRequest>, entry: Entry): Promise<BackgroundAgentTaskHandle> {
    await this.options.authorize(input);
    if (this.closing || entry.stopped) { throw new Error('Background task stopped before admission'); }
    const selected = this.options.runtimeOptions(input);
    // No injected model face: the child reports through its native turn
    // result only. A structured report channel, when needed, is provided
    // by the disclaude CLI + built-in skill pattern (#5603/#5611), never
    // by adding tools to the child's query options here.
    const runner = new AgentTaskRunner({ ...selected,
      ...(selected.settings ? { settings: structuredClone(selected.settings) } : {}), ...(selected.env ? { env: { ...selected.env } } : {}),
      configureQueryOptions: options => {
        const configured = selected.configureQueryOptions?.(options) ?? options;
        return { ...configured, capacityAdmission: 'queue', onAsyncUserInputAnswer: undefined };
      },
    });
    let task: ReturnType<AgentTaskRunner['start']>;
    try {
      task = runner.start({ ...input }, this.options.callbacks(input));
    } catch (error) { await runner.close(); throw error; }
    entry.id = task.id;
    entry.stopNative = task.stop;
    const completion = (async (): Promise<TaskResultRecord> => {
      try {
        const native = await task.completion;
        const detail = [native.outcome !== 'succeeded' ? native.error : undefined, native.text].filter(Boolean).join('\n');
        const summary = sanitizeDiagnosticText(`[${native.outcome}${native.truncated ? '; output truncated' : ''}] ${
          detail || 'Native task returned without a summary'}`).slice(0, 16000);
        const report: TaskCompletionReport = { id: task.id, chatId: input.chatId, actorId: input.senderOpenId,
          sourceMessageId: input.sourceMessageId, projectRoot: input.projectRoot,
          ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
          outcome: native.truncated && native.outcome === 'succeeded' ? 'failed' : native.outcome,
          summary, // Structured artifacts arrive via the CLI report channel when it lands;
          // the native result carries no artifact list today.
          artifacts: [] };
        const saved = await this.options.outbox.publish(report);
        if (this.closing || entry.stopped) { return saved; }
        try { await this.options.authorize(input); } catch { return saved; }
        if (this.closing || entry.stopped) { return saved; }
        try { return await this.options.outbox.deliver(task.id, value => this.options.wakeParent(value)); }
        catch (error) {
          const stored = await this.options.outbox.get(task.id);
          if (stored?.delivery === 'uncertain' || stored?.delivery === 'sending' || stored?.delivery === 'delivered') { return stored; }
          throw error;
        }
      } finally {
        await runner.close(); entry.busy = false; entry.admission = undefined; entry.stopNative = undefined;
      }
    })();
    this.track(completion);
    const stop = (): void => { entry.stopped = true; task.stop(); };
    return { id: task.id, completion, stop };
  }
  isBusy(chatId: string): boolean { return [...this.operations.values()].some(entry => entry.chatId === chatId && entry.busy); }
  stopForParent(chatId: string, threadRootId?: string): void {
    for (const entry of this.operations.values()) {
      if (entry.busy && entry.chatId === chatId && entry.threadRootId === threadRootId) { entry.stopped = true; entry.stopNative?.(); }
    }
  }
  close(): Promise<void> {
    this.closing = true;
    this.closeFlight ??= (async () => {
      for (const entry of this.operations.values()) { entry.stopped = true; entry.stopNative?.(); }
      while (this.inFlight.size) { await Promise.allSettled([...this.inFlight]); }
    })();
    return this.closeFlight;
  }
}
