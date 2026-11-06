export function emptyWelcomeState(botId) { return { version: 1, botId, peers: {} }; }
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
export function validWelcomeState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const state = value;
    return Object.keys(state).every(key => ['version', 'botId', 'peers'].includes(key)) && state.version === 1 && text(state.botId)
        && !!state.peers && typeof state.peers === 'object' && !Array.isArray(state.peers) && Object.keys(state.peers).length <= 10_000
        && Object.entries(state.peers).every(([peer, record]) => text(peer) && !!record && typeof record === 'object' && !Array.isArray(record)
            && Object.keys(record).every(key => ['phase', 'startedAt', 'acceptedAt', 'messageId'].includes(key))
            && ['attempted', 'accepted'].includes(record.phase) && text(record.startedAt) && Number.isFinite(Date.parse(record.startedAt))
            && (record.phase === 'accepted' ? record.acceptedAt !== undefined : record.acceptedAt === undefined && record.messageId === undefined)
            && (record.acceptedAt === undefined || (text(record.acceptedAt) && Number.isFinite(Date.parse(record.acceptedAt))))
            && (record.messageId === undefined || text(record.messageId)));
}
/** One owning account listener. Persist intent before sending; uncertain delivery is never blindly repeated. */
export class WeChatWelcome {
    save;
    context;
    send;
    report;
    state;
    jobs = new Map();
    writes = Promise.resolve();
    closed = false;
    constructor(state, save, context, send, report) {
        this.save = save;
        this.context = context;
        this.send = send;
        this.report = report;
        if (!validWelcomeState(state)) {
            throw new Error('Invalid WeChat welcome state');
        }
        this.state = structuredClone(state);
    }
    request(peer) {
        if (this.closed || !text(peer) || !this.context(peer) || this.jobs.has(peer) || Object.hasOwn(this.state.peers, peer)) {
            return;
        }
        const job = this.run(peer).catch(() => this.event(peer, 'state-unavailable')).finally(() => {
            if (this.jobs.get(peer) === job) {
                this.jobs.delete(peer);
            }
        });
        this.jobs.set(peer, job);
    }
    async close() { this.closed = true; await this.idle(); }
    async idle() { await Promise.all([...this.jobs.values()]); }
    event(peer, event) { try {
        this.report?.(peer, event);
    }
    catch { /* Never fail the first user task. */ } }
    update(peer, record) {
        const operation = this.writes.then(async () => {
            const next = structuredClone(this.state);
            if (record) {
                if (!Object.hasOwn(next.peers, peer) && Object.keys(next.peers).length >= 10_000) {
                    throw new Error('Welcome state full');
                }
                next.peers = { ...next.peers, [peer]: record };
            }
            else {
                delete next.peers[peer];
            }
            await this.save(structuredClone(next));
            this.state = next;
        });
        this.writes = operation.catch(() => { });
        return operation;
    }
    async run(peer) {
        const attempt = { phase: 'attempted', startedAt: new Date().toISOString() };
        await this.update(peer, attempt);
        const context = this.context(peer);
        if (!context || this.closed) {
            await this.update(peer);
            return;
        }
        this.event(peer, 'attempting');
        let messageId;
        try {
            messageId = await this.send(peer, context);
        }
        catch {
            this.event(peer, 'delivery-unconfirmed');
            return;
        }
        try {
            await this.update(peer, { ...attempt, phase: 'accepted', acceptedAt: new Date().toISOString(), ...(messageId ? { messageId } : {}) });
            this.event(peer, 'accepted');
        }
        catch {
            // API acceptance and local checkpoint failure are separate facts.
            this.event(peer, 'accepted-checkpoint-failed');
        }
    }
}
