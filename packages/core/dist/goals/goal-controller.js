import { isAbsolute } from 'node:path';
import { GoalLoop } from './goal-loop.js';
import { GoalRevisionConflictError } from './goal-store.js';
/** Compose durable controls/assessments with one owned sequential execution.
 * No automatic restoration, execution retries, polling or execution budgets.
 */
export class GoalController {
    store;
    port;
    starts = new Map();
    closing = false;
    closeFlight;
    constructor(store, port) {
        this.store = store;
        this.port = port;
    }
    capture(request) {
        const { goalId, expectedRevision, chatId, projectRoot, actorId, sourceMessageId, threadRootId, chatType } = request;
        if (![goalId, chatId, actorId, sourceMessageId].every(value => typeof value === 'string' && value.trim() && value.length <= 512) ||
            typeof projectRoot !== 'string' || projectRoot.length > 4096 || !isAbsolute(projectRoot) ||
            !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
            (chatType !== undefined && !['p2p', 'group', 'topic'].includes(chatType)) ||
            (threadRootId !== undefined && (typeof threadRootId !== 'string' || !threadRootId.trim() || threadRootId.length > 512))) {
            throw new Error('Invalid explicit Goal request');
        }
        return Object.freeze({ goalId, expectedRevision, chatId, projectRoot, actorId, sourceMessageId, ...(chatType ? { chatType } : {}), ...(threadRootId ? { threadRootId } : {}) });
    }
    async readOwned(request) {
        const record = await this.store.get(request.goalId);
        if (!record || record.chatId !== request.chatId || record.projectRoot !== request.projectRoot) {
            throw new Error('Goal is not in this chat and Project');
        }
        await this.port.authorize(structuredClone(record), request);
        return record;
    }
    start(request, action) {
        if (this.closing) {
            return Promise.reject(new Error('Goal controller is closing'));
        }
        if (action !== 'activate' && action !== 'resume') {
            return Promise.reject(new Error('Invalid Goal start action'));
        }
        let owner;
        try {
            owner = this.capture(request);
        }
        catch (error) {
            return Promise.reject(error);
        }
        const key = JSON.stringify([action, owner]);
        const existing = this.starts.get(owner.goalId);
        if (existing) {
            return existing.key === key ? existing.result : Promise.reject(new Error('Goal still owns an execution; await its settlement'));
        }
        const entry = { key, result: this.admit(owner, action) };
        this.starts.set(owner.goalId, entry);
        const release = () => { if (this.starts.get(owner.goalId) === entry) {
            this.starts.delete(owner.goalId);
        } };
        void entry.result.then(({ handle }) => handle.completion.then(release), release);
        return entry.result;
    }
    async admit(owner, action) {
        await this.readOwned(owner);
        if (this.closing) {
            throw new Error('Goal controller is closing');
        }
        const record = await this.store.control(owner.goalId, owner.expectedRevision, action);
        const loop = new GoalLoop({
            read: id => this.store.get(id),
            runTurn: async (snapshot, signal) => {
                const latest = await this.readOwned(owner);
                if (signal.aborted || latest.status !== 'active') {
                    return;
                }
                // User feedback during authorization is read on the next iteration.
                const admitted = await this.store.get(owner.goalId);
                if (signal.aborted || !admitted || admitted.status !== 'active' || admitted.revision !== snapshot.revision) {
                    return;
                }
                const report = await this.port.runTurn(structuredClone(snapshot), owner, signal);
                if (signal.aborted) {
                    return;
                }
                const after = await this.readOwned(owner);
                if (signal.aborted) {
                    return;
                }
                if (after.revision !== snapshot.revision) {
                    throw new GoalRevisionConflictError();
                }
                await this.store.recordTurn(snapshot.id, snapshot.revision, report);
            },
        });
        const handle = loop.start(owner.goalId);
        if (this.closing) {
            handle.stop();
        }
        return { record, handle };
    }
    async control(request, action) {
        if (this.closing) {
            throw new Error('Goal controller is closing');
        }
        if (action !== 'pause' && action !== 'stop') {
            throw new Error('Invalid Goal control action');
        }
        const owner = this.capture(request);
        await this.readOwned(owner);
        if (this.closing) {
            throw new Error('Goal controller is closing');
        }
        const record = await this.store.control(owner.goalId, owner.expectedRevision, action);
        const entry = this.starts.get(owner.goalId);
        const settlement = entry?.result.then(({ handle }) => { handle.stop(); return handle.completion; }, (error) => ({ reason: 'failed', error }));
        return { record, ...(settlement ? { settlement } : {}) };
    }
    /** Stop ownership without inferring a user pause or completed goal. */
    close() {
        this.closing = true;
        this.closeFlight ??= Promise.all([...this.starts.values()].map(async (entry) => {
            try {
                const { handle } = await entry.result;
                handle.stop();
                await handle.completion;
            }
            catch { /* a failed admission owns no loop */ }
        })).then(() => { });
        return this.closeFlight;
    }
}
