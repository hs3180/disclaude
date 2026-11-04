import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { sanitizeDiagnosticText } from "../../../core/dist/index.js";
import { AgentTaskRunner } from './agent-task-runner.js';
/** Service owns child work after the parent's tool/turn returns. Parent wakeup
 * is an injected admitted port, not an invented successful channel callback.
 */
export class BackgroundAgentTasks {
    options;
    operations = new Map();
    inFlight = new Set();
    closing = false;
    closeFlight;
    constructor(options) {
        this.options = options;
    }
    async start(operationId, request) {
        if (this.closing) {
            throw new Error('Background task owner is closing');
        }
        if (typeof operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(operationId)) {
            throw new Error('Invalid background operation ID');
        }
        if (!isAbsolute(request.workingDirectory) || !isAbsolute(request.projectRoot)) {
            throw new Error('Background task needs an absolute Project and directory');
        }
        const input = Object.freeze({ ...structuredClone(request), workingDirectory: realpathSync(request.workingDirectory), projectRoot: realpathSync(request.projectRoot) });
        const path = relative(input.projectRoot, input.workingDirectory);
        if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
            throw new Error('Background task directory is outside its Project');
        }
        const key = JSON.stringify([input.chatId, input.senderOpenId, input.sourceMessageId, input.threadRootId ?? null, operationId]);
        const fingerprint = createHash('sha256').update(JSON.stringify([input.task, input.projectRoot, input.workingDirectory, input.chatType ?? null,
            input.replyRootId === undefined ? 'unspecified' : input.replyRootId])).digest('hex');
        const existing = this.operations.get(key);
        if (existing) {
            await this.options.authorize(input);
            if (existing.fingerprint !== fingerprint) {
                throw new Error('Background operation already belongs to different work');
            }
            if (existing.admission) {
                return await existing.admission;
            }
            if (!existing.id) {
                throw new Error('Background admission did not complete');
            }
            const { id } = existing;
            return { id, stop: () => { }, completion: this.options.outbox.get(id).then(async (record) => {
                    if (!record) {
                        throw new Error('Existing background task needs result reconciliation; work was not repeated');
                    }
                    await this.options.authorize(input);
                    return record;
                }) };
        }
        const entry = { fingerprint, chatId: input.chatId, threadRootId: input.threadRootId, busy: true, stopped: false };
        this.operations.set(key, entry);
        entry.admission = this.admit(input, entry);
        const { admission } = entry;
        void admission.catch(() => { if (!entry.id) {
            this.operations.delete(key);
            entry.busy = false;
        } });
        this.track(admission);
        return await admission;
    }
    track(work) {
        this.inFlight.add(work);
        const release = () => { this.inFlight.delete(work); };
        void work.then(release, release);
    }
    async admit(input, entry) {
        await this.options.authorize(input);
        if (this.closing || entry.stopped) {
            throw new Error('Background task stopped before admission');
        }
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
        let task;
        try {
            task = runner.start({ ...input }, this.options.callbacks(input));
        }
        catch (error) {
            await runner.close();
            throw error;
        }
        entry.id = task.id;
        entry.stopNative = task.stop;
        const completion = (async () => {
            try {
                const native = await task.completion;
                const detail = [native.outcome !== 'succeeded' ? native.error : undefined, native.text].filter(Boolean).join('\n');
                const summary = sanitizeDiagnosticText(`[${native.outcome}${native.truncated ? '; output truncated' : ''}] ${detail || 'Native task returned without a summary'}`).slice(0, 16000);
                const report = { id: task.id, chatId: input.chatId, actorId: input.senderOpenId,
                    sourceMessageId: input.sourceMessageId, projectRoot: input.projectRoot,
                    ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
                    outcome: native.truncated && native.outcome === 'succeeded' ? 'failed' : native.outcome,
                    summary, // Structured artifacts arrive via the CLI report channel when it lands;
                    // the native result carries no artifact list today.
                    artifacts: [] };
                const saved = await this.options.outbox.publish(report);
                if (this.closing || entry.stopped) {
                    return saved;
                }
                try {
                    await this.options.authorize(input);
                }
                catch {
                    return saved;
                }
                if (this.closing || entry.stopped) {
                    return saved;
                }
                try {
                    return await this.options.outbox.deliver(task.id, value => this.options.wakeParent(value));
                }
                catch (error) {
                    const stored = await this.options.outbox.get(task.id);
                    if (stored?.delivery === 'uncertain' || stored?.delivery === 'sending' || stored?.delivery === 'delivered') {
                        return stored;
                    }
                    throw error;
                }
            }
            finally {
                await runner.close();
                entry.busy = false;
                entry.admission = undefined;
                entry.stopNative = undefined;
            }
        })();
        this.track(completion);
        const stop = () => { entry.stopped = true; task.stop(); };
        return { id: task.id, completion, stop };
    }
    isBusy(chatId) { return [...this.operations.values()].some(entry => entry.chatId === chatId && entry.busy); }
    stopForParent(chatId, threadRootId) {
        let stopped = false;
        for (const entry of this.operations.values()) {
            if (entry.busy && entry.chatId === chatId && entry.threadRootId === threadRootId) {
                stopped = true;
                entry.stopped = true;
                entry.stopNative?.();
            }
        }
        return stopped;
    }
    close() {
        this.closing = true;
        this.closeFlight ??= (async () => {
            for (const entry of this.operations.values()) {
                entry.stopped = true;
                entry.stopNative?.();
            }
            while (this.inFlight.size) {
                await Promise.allSettled([...this.inFlight]);
            }
        })();
        return this.closeFlight;
    }
}
