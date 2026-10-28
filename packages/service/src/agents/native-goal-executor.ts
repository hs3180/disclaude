import type { GoalRecord, ToolDefinition } from '@disclaude/core';
import { AgentTaskRunner } from './agent-task-runner.js';
import type { AgentCreateOptions } from './factory.js';
import type { ChatAgentCallbacks } from './types.js';
import { createGoalReportTool, type NativeGoalReport } from './goal-report-tool.js';

export interface NativeGoalSource {
  chatId: string;
  projectRoot: string;
  actorId: string;
  sourceMessageId: string;
  chatType?: 'p2p' | 'group' | 'topic';
  threadRootId?: string;
}
export interface NativeGoalExecutorOptions {
  /** Trusted host selection; the model cannot select another runtime or source. */
  runtimeOptions?(goal: Readonly<GoalRecord>, source: Readonly<NativeGoalSource>): AgentCreateOptions;
  callbacks(source: Readonly<NativeGoalSource>, goal: Readonly<GoalRecord>): ChatAgentCallbacks;
  createTurnTools?(goal: Readonly<GoalRecord>, source: Readonly<NativeGoalSource>): NativeGoalTurnTools;
}
export interface NativeGoalTurnTools {
  tools: readonly ToolDefinition[];
  /** Request cancellation of turn-owned work; must not throw from an event listener. */
  stop?(): void;
  /** Join owned tool work before returning an assessment. Detached work needs
   * its own Goal/service lifetime owner rather than this turn's cleanup.
   */
  close(): Promise<void>;
  /** Validate a proposal after every owned native/tool resource has settled. */
  assess?(report: Readonly<NativeGoalReport>): Promise<void>;
}

/** Native turn port for the Goal controller. Authorization belongs to its host.
 * Each round owns an independent task, pinned directory and report collector.
 */
export class NativeGoalExecutor {
  private readonly runs = new Map<symbol, { chatId: string; stop(): void; completion: Promise<NativeGoalReport> }>();
  private closing = false;
  private closeFlight?: Promise<void>;
  constructor(private readonly options: NativeGoalExecutorOptions) {}

  isBusy(chatId: string): boolean { return [...this.runs.values()].some(run => run.chatId === chatId); }

  runTurn(goal: Readonly<GoalRecord>, source: Readonly<NativeGoalSource>, signal: AbortSignal): Promise<NativeGoalReport> {
    if (this.closing) { return Promise.reject(new Error('Native Goal executor is closing')); }
    if (goal.status !== 'active' || goal.chatId !== source.chatId || !goal.projectRoot || goal.projectRoot !== source.projectRoot) {
      return Promise.reject(new Error('Native Goal source does not match the active chat and Project'));
    }
    const snapshot = structuredClone(goal);
    const owner = Object.freeze(structuredClone(source));
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) { stop(); }
    const id = Symbol('goal-round');
    const completion = Promise.resolve().then(async () => {
      try { return await this.execute(snapshot, owner, controller.signal); }
      finally { signal.removeEventListener('abort', stop); }
    });
    this.runs.set(id, { chatId: owner.chatId, stop, completion });
    const release = (): void => { this.runs.delete(id); };
    void completion.then(release, release);
    return completion;
  }
  private async execute(goal: Readonly<GoalRecord>, owner: Readonly<NativeGoalSource>, signal: AbortSignal): Promise<NativeGoalReport> {
    signal.throwIfAborted();
    const collector = createGoalReportTool(goal);
    const runtime = this.options.runtimeOptions?.(structuredClone(goal), owner) ?? {};
    const turnTools = this.options.createTurnTools?.(structuredClone(goal), owner);
    const runner = new AgentTaskRunner({ ...runtime, configureQueryOptions: options => {
      const configured = runtime.configureQueryOptions?.(options) ?? options;
      // This worker ends after one round; a later async answer cannot re-enter it.
      return { ...configured, onAsyncUserInputAnswer: undefined, tools: [...(configured.tools ?? []), ...(turnTools?.tools ?? []), collector.tool] };
    } });
    let cancel: (() => void) | undefined;
    let toolsStopped = false, stopFailed = false;
    const stop = (): void => {
      collector.close();
      if (!toolsStopped) { toolsStopped = true; try { turnTools?.stop?.(); } catch { stopFailed = true; } }
      cancel?.();
    };
    signal.addEventListener('abort', stop, { once: true });
    let assessment: NativeGoalReport | undefined;
    try {
      const task = runner.start({ chatId: owner.chatId, senderOpenId: owner.actorId, sourceMessageId: owner.sourceMessageId,
        workingDirectory: owner.projectRoot, ...(owner.chatType ? { chatType: owner.chatType } : {}), ...(owner.threadRootId ? { threadRootId: owner.threadRootId } : {}),
        task: ['按此 Goal 的最新要求推进一轮，完成实际工作并核对产物。',
          '退出前调用 goal_report 提交进展、产物和逐项验收证据；criterion 从 0 开始。',
          '有后续工作用 continue；需要用户决策用 blocked；全部条件都有证据才用 completed。',
          '报告是待保存的提案，不要仅用正文宣告 Goal 已被系统标记完成。',
          JSON.stringify({ id: goal.id, revision: goal.revision, objective: goal.objective,
            acceptance: goal.acceptance, progress: goal.progress, artifacts: goal.artifacts }),
        ].join('\n'),
      }, this.options.callbacks(owner, structuredClone(goal)));
      cancel = task.stop;
      if (signal.aborted) { stop(); }
      const result = await task.completion;
      signal.throwIfAborted();
      if (stopFailed) { throw new Error('Goal tool cancellation was not confirmed; reconcile its owned work'); }
      if (result.outcome !== 'succeeded' || result.truncated) { throw new Error(result.error ?? 'Native Goal turn did not settle successfully'); }
      assessment = collector.getReport();
      if (!assessment) { throw new Error('Native Goal turn settled without an assessment; work was not repeated'); }
    } finally {
      collector.close(); signal.removeEventListener('abort', stop);
      try { await turnTools?.close(); } finally { await runner.close(); }
    }
    signal.throwIfAborted();
    await turnTools?.assess?.(structuredClone(assessment));
    return assessment;
  }
  close(): Promise<void> {
    this.closing = true;
    this.closeFlight ??= (async () => {
      const runs = [...this.runs.values()];
      for (const run of runs) { run.stop(); }
      await Promise.allSettled(runs.map(run => run.completion));
    })();
    return this.closeFlight;
  }
}
