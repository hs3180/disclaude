import { AgentTaskRunner } from './agent-task-runner.js';
import { createGoalReportTool } from './goal-report-tool.js';
/** Native turn port for the Goal controller. Authorization belongs to its host.
 * Each round owns an independent task, pinned directory and report collector.
 */
export class NativeGoalExecutor {
    options;
    runs = new Map();
    closing = false;
    closeFlight;
    constructor(options) {
        this.options = options;
    }
    isBusy(chatId) { return [...this.runs.values()].some(run => run.chatId === chatId); }
    runTurn(goal, source, signal) {
        if (this.closing) {
            return Promise.reject(new Error('Native Goal executor is closing'));
        }
        if (goal.status !== 'active' || goal.chatId !== source.chatId || !goal.projectRoot || goal.projectRoot !== source.projectRoot) {
            return Promise.reject(new Error('Native Goal source does not match the active chat and Project'));
        }
        const snapshot = structuredClone(goal);
        const owner = Object.freeze(structuredClone(source));
        const controller = new AbortController();
        const stop = () => controller.abort();
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) {
            stop();
        }
        const id = Symbol('goal-round');
        const completion = Promise.resolve().then(async () => {
            try {
                return await this.execute(snapshot, owner, controller.signal);
            }
            finally {
                signal.removeEventListener('abort', stop);
            }
        });
        this.runs.set(id, { chatId: owner.chatId, stop, completion });
        const release = () => { this.runs.delete(id); };
        void completion.then(release, release);
        return completion;
    }
    async execute(goal, owner, signal) {
        signal.throwIfAborted();
        const collector = createGoalReportTool(goal);
        const runtime = this.options.runtimeOptions?.(structuredClone(goal), owner) ?? {};
        const turnTools = this.options.createTurnTools?.(structuredClone(goal), owner);
        const runner = new AgentTaskRunner({ ...runtime, configureQueryOptions: options => {
                const configured = runtime.configureQueryOptions?.(options) ?? options;
                // This worker ends after one round; a later async answer cannot re-enter it.
                return { ...configured, onAsyncUserInputAnswer: undefined, tools: [...(configured.tools ?? []), ...(turnTools?.tools ?? []), collector.tool] };
            } });
        let cancel;
        let toolsStopped = false, stopFailed = false;
        const stop = () => {
            collector.close();
            if (!toolsStopped) {
                toolsStopped = true;
                try {
                    turnTools?.stop?.();
                }
                catch {
                    stopFailed = true;
                }
            }
            cancel?.();
        };
        signal.addEventListener('abort', stop, { once: true });
        let assessment;
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
            if (signal.aborted) {
                stop();
            }
            const result = await task.completion;
            signal.throwIfAborted();
            if (stopFailed) {
                throw new Error('Goal tool cancellation was not confirmed; reconcile its owned work');
            }
            if (result.outcome !== 'succeeded' || result.truncated) {
                throw new Error(result.error ?? 'Native Goal turn did not settle successfully');
            }
            assessment = collector.getReport();
            if (!assessment) {
                throw new Error('Native Goal turn settled without an assessment; work was not repeated');
            }
        }
        finally {
            collector.close();
            signal.removeEventListener('abort', stop);
            try {
                await turnTools?.close();
            }
            finally {
                await runner.close();
            }
        }
        // Assess only after every owned native/tool resource has settled, so a
        // refusal cannot strand work that still owes effects.
        signal.throwIfAborted();
        if (!assessment) {
            throw new Error('Native Goal turn settled without an assessment; work was not repeated');
        }
        await turnTools?.assess?.(structuredClone(assessment));
        return assessment;
    }
    close() {
        this.closing = true;
        this.closeFlight ??= (async () => {
            const runs = [...this.runs.values()];
            for (const run of runs) {
                run.stop();
            }
            await Promise.allSettled(runs.map(run => run.completion));
        })();
        return this.closeFlight;
    }
}
