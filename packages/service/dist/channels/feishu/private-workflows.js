import { randomUUID } from 'node:crypto';
import { ActionBoundInput, createPrivateProcessAction, createLogger, } from "../../../../core/dist/index.js";
import { FeishuPrivateInput } from './private-input.js';
/** Validate transport shape only. Workflow policy belongs to the authenticated agent. */
export function isPrivateWorkflowRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const r = value;
    const w = r.workflow;
    return (['chatId', 'actorId', 'sourceMessageId'].every((k) => typeof r[k] === 'string' && r[k].length > 0) &&
        !!w &&
        typeof w === 'object' &&
        !Array.isArray(w) &&
        ['command', 'title', 'description'].every((k) => typeof w[k] === 'string' && w[k].length > 0) &&
        (w.args === undefined ||
            (Array.isArray(w.args) && w.args.every((a) => typeof a === 'string'))) &&
        (w.cwd === undefined || typeof w.cwd === 'string') &&
        (w.env === undefined ||
            (!!w.env &&
                typeof w.env === 'object' &&
                !Array.isArray(w.env) &&
                Object.values(w.env).every((v) => typeof v === 'string'))) &&
        (w.timeoutMs === undefined ||
            (typeof w.timeoutMs === 'number' && Number.isFinite(w.timeoutMs) && w.timeoutMs > 0)));
}
/** Each request freezes a task-selected consumer; form callbacks cannot replace it. */
export class FeishuPrivateWorkflows {
    send;
    pending = new Map();
    constructor(send) {
        this.send = send;
    }
    async request(request) {
        if (!isPrivateWorkflowRequest(request)) {
            throw new Error('Invalid private workflow');
        }
        for (const [id, entry] of this.pending) {
            if (entry.actor === request.actorId && entry.chat === request.chatId) {
                this.remove(id);
            }
        }
        if (this.pending.size >= 500) {
            throw new Error('Too many pending private workflows');
        }
        const actionId = randomUUID();
        const audit = createLogger('PrivateWorkflow');
        const input = new FeishuPrivateInput(new ActionBoundInput(createPrivateProcessAction({ ...request.workflow, id: actionId }), (event) => audit.info(event, 'Private workflow completed')), this.send);
        const timer = setTimeout(() => this.remove(actionId), 300_000);
        timer.unref();
        this.pending.set(actionId, { input, actor: request.actorId, chat: request.chatId, timer });
        try {
            await input.request(actionId, request.actorId, request.chatId, request.sourceMessageId);
        }
        catch {
            this.remove(actionId);
            throw new Error('Private workflow card was not delivered');
        }
        return { actionId };
    }
    async submit(data) {
        const action = data.action;
        const id = action?.value?.private_action;
        if (typeof id !== 'string') {
            return false;
        }
        const entry = this.pending.get(id);
        if (!entry) {
            return false;
        }
        const outcome = await entry.input.submit(data);
        if (outcome && outcome !== 'invalid') {
            this.remove(id);
        }
        return true;
    }
    remove(id) {
        const entry = this.pending.get(id);
        if (entry) {
            clearTimeout(entry.timer);
            entry.input.revoke();
            this.pending.delete(id);
        }
    }
    revoke() {
        for (const id of this.pending.keys()) {
            this.remove(id);
        }
    }
}
