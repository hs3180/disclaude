import { GoalController, GoalRevisionConflictError, type ControlCommand, type GoalExecutionRequest, type GoalExecutionStart,
  type GoalRecord, type GoalStore, type ProjectManager } from '@disclaude/core';
import type { Logger } from 'pino';
import type { AgentCreateOptions } from '../agents/factory.js';
import type { ChatAgentCallbacks } from '../agents/types.js';
import { NativeGoalExecutor, type NativeGoalSource } from '../agents/native-goal-executor.js';

export interface GoalExecutionServiceOptions {
  store: GoalStore;
  projectManager: Pick<ProjectManager, 'resolveCwd' | 'getWorkspaceDir'>;
  isCommandAllowed(command: ControlCommand<'goal'>): boolean;
  runtimeOptions(source: Readonly<GoalExecutionRequest>): AgentCreateOptions;
  callbacks(source: Readonly<GoalExecutionRequest>): ChatAgentCallbacks;
  logger?: Logger;
}
type Binding = {
  source: Readonly<GoalExecutionRequest>; action: 'start' | 'resume';
  runtime: AgentCreateOptions; callbacks: ChatAgentCallbacks;
  admission?: Promise<GoalExecutionStart>;
};
const sourceKey = (source: Readonly<NativeGoalSource>): string => JSON.stringify([
  source.chatId, source.projectRoot, source.actorId, source.sourceMessageId, source.threadRootId ?? null, source.chatType ?? null,
]);
const requestKey = (source: Readonly<GoalExecutionRequest>): string => JSON.stringify([
  source.goalId, source.expectedRevision, sourceKey(source),
]);
/** Final receipts inline the record (single-entry /goal has no per-ID query). */
const receiptSummary = (record: GoalRecord): string => [
  record.objective, ...(record.progress ? ['', `进展：${record.progress.slice(0, 800)}`] : []),
  ...(record.artifacts.length ? ['', '产物：', ...record.artifacts.slice(0, 10).map(item => `- ${item}`)] : []),
].join('\n');
const CONTINUATION = '如需继续推进，请直接发送新的 /goal <补充后的目标> 开新 Goal 接续；旧 Goal 保留存档。';

/** One service-owned runtime; only the trusted user-channel handler receives it. */
export class GoalExecutionService {
  private readonly bindings = new Map<string, Binding>();
  private readonly controls = new Map<string, { action: 'pause' | 'stop' }>();
  private readonly stopFlights = new Map<string, Promise<void>>();
  private readonly finalizers = new Set<Promise<void>>();
  private readonly executor: NativeGoalExecutor;
  private readonly controller: GoalController;
  private closing = false;
  private closeFlight?: Promise<void>;
  constructor(private readonly options: GoalExecutionServiceOptions) {
    this.executor = new NativeGoalExecutor({
      runtimeOptions: (goal, source) => this.binding(goal.id, source).runtime,
      callbacks: (source, goal) => this.binding(goal.id, source).callbacks,
    });
    this.controller = new GoalController(options.store, {
      authorize: (goal, source) => this.authorize(goal, source),
      // A stop racing a settling turn must not fund another round: the loop
      // would read the pre-stop record and dispatch work the user cancelled.
      runTurn: (goal, source, signal) => {
        if (this.stopFlights.has(goal.id)) { return Promise.reject(new Error('Goal stop is pending')); }
        return this.executor.runTurn(goal, source, signal);
      },
    });
  }
  private binding(id: string, source: Readonly<NativeGoalSource>): Binding {
    const binding = this.bindings.get(id);
    if (!binding || sourceKey(source) !== sourceKey(binding.source)) { throw new Error('Goal execution binding unavailable'); }
    return binding;
  }
  private authorize(goal: Readonly<GoalRecord>, source: Readonly<GoalExecutionRequest>): Promise<void> {
    const control = this.controls.get(requestKey(source));
    const resolution = this.options.projectManager.resolveCwd(source.chatId);
    const root = resolution.boundWorkingDir ?? this.options.projectManager.getWorkspaceDir();
    if (goal.projectRoot !== root || source.projectRoot !== root ||
        (!control && resolution.reason === 'bound-missing')) { return Promise.reject(new Error('Goal Project binding is unavailable or changed')); }
    const allowed = this.options.isCommandAllowed({ type: 'goal', chatId: source.chatId, actorId: source.actorId,
      sourceMessageId: source.sourceMessageId, ...(source.chatType ? { chatType: source.chatType } : {}), ...(source.threadRootId ? { threadRootId: source.threadRootId } : {}),
      data: { args: [goal.objective] } });
    return allowed ? Promise.resolve() : Promise.reject(new Error('Goal command is not authorized'));
  }
  async start(request: GoalExecutionRequest, action: 'activate' | 'resume'): Promise<GoalExecutionStart> {
    if (this.closing) { throw new Error('Goal execution service is closing'); }
    const source = Object.freeze({ ...request });
    const previous = this.bindings.get(source.goalId);
    if (previous) {
      if (requestKey(previous.source) !== requestKey(source) || previous.action !== (action === 'activate' ? 'start' : 'resume') || !previous.admission) {
        throw new Error('Goal still owns execution or delivery finalization');
      }
      return await previous.admission;
    }
    const selected = this.options.runtimeOptions(source);
    const binding: Binding = { source, action: action === 'activate' ? 'start' : 'resume',
      runtime: { ...selected, ...(selected.settings ? { settings: structuredClone(selected.settings) } : {}),
        ...(selected.env ? { env: { ...selected.env } } : {}) }, callbacks: this.options.callbacks(source) };
    this.bindings.set(source.goalId, binding);
    binding.admission = this.controller.start(source, action);
    const finalizer = this.finish(binding);
    this.finalizers.add(finalizer);
    const release = (): void => { this.finalizers.delete(finalizer); };
    void finalizer.then(release, release);
    return await binding.admission;
  }
  private async finish(binding: Binding): Promise<void> {
    const { source } = binding;
    try {
      const { admission } = binding;
      if (!admission) { throw new Error('Goal admission is unavailable'); }
      const { handle } = await admission;
      const outcome = await handle.completion;
      if (this.closing || outcome.reason === 'stopped') { return; }
      // A stop flight may still be committing; only read the record afterwards.
      await this.stopFlights.get(source.goalId)?.catch(() => {});
      const record = await this.options.store.get(source.goalId);
      const state = record?.status === 'completed' ? '已完成，验收记录已保存。'
        : record?.status === 'blocked' ? `等待你的决定。${CONTINUATION}`
          : record?.status === 'abandoned' ? '已停止，未自动重试。'
            : outcome.reason === 'failed' ? `本轮推进失败，未自动重试。请核对已执行操作。${CONTINUATION}` : '本轮执行已结束。';
      await binding.callbacks.sendMessage(source.chatId,
        `Goal ${source.goalId}（版本 ${record?.revision ?? '待核对'}）${state}${record ? `\n\n${receiptSummary(record)}` : ''}`, source.threadRootId);
    } catch {
      this.options.logger?.warn({ goalId: source.goalId }, 'Goal final outcome or notification could not be confirmed; no work was replayed');
    } finally {
      if (this.bindings.get(source.goalId) === binding) { this.bindings.delete(source.goalId); }
    }
  }
  async control(request: GoalExecutionRequest, action: 'pause' | 'stop'): ReturnType<GoalController['control']> {
    if (this.closing) { throw new Error('Goal execution service is closing'); }
    const key = requestKey(request); const entry = { action };
    this.controls.set(key, entry);
    try { return await this.controller.control(request, action); }
    finally { if (this.controls.get(key) === entry) { this.controls.delete(key); } }
  }
  /** `/stop` path: stop the chat's running Goals without a revision token (#5212).
   * Synchronous callers only learn whether a stop was initiated; settlement
   * is awaited by the finalizer and never reported as already finished.
   */
  stopForChat(chatId: string, threadRootId?: string): boolean {
    const matched = [...this.bindings.values()].filter(candidate => candidate.source.chatId === chatId
      && (threadRootId ? candidate.source.threadRootId === threadRootId : !candidate.source.threadRootId));
    if (!matched.length || this.closing) { return false; }
    for (const { source } of matched) {
      const flight = this.stopAtLatestRevision(source).catch(() =>
        this.options.logger?.warn({ chatId, goalId: source.goalId }, 'Goal stop for chat could not be confirmed'));
      this.stopFlights.set(source.goalId, flight);
      void flight.then(() => { if (this.stopFlights.get(source.goalId) === flight) { this.stopFlights.delete(source.goalId); } });
    }
    return true;
  }
  /** Turns advance the revision; re-read it and retry a bounded number of
   * times so a settling turn cannot race the user's stop into a conflict.
   */
  private async stopAtLatestRevision(source: Readonly<GoalExecutionRequest>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const record = await this.options.store.get(source.goalId);
      if (!record || record.status === 'abandoned' || record.status === 'completed') { return; }
      try {
        await this.control({ ...source, expectedRevision: record.revision }, 'stop');
        return;
      } catch (error) {
        if (!(error instanceof GoalRevisionConflictError) || attempt >= 2) { throw error; }
      }
    }
  }
  isBusy(chatId: string): boolean { return [...this.bindings.values()].some(binding => binding.source.chatId === chatId); }
  close(): Promise<void> {
    this.closing = true;
    this.closeFlight ??= (async () => {
      await this.controller.close(); await this.executor.close();
      while (this.finalizers.size) { await Promise.all([...this.finalizers]); }
    })();
    return this.closeFlight;
  }
}
