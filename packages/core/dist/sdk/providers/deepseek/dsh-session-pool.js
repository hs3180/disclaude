import { DshStdioTransport } from './dsh-transport.js';
export class DshSessionPool {
    options;
    createTransport;
    sessions = new Map();
    closed = false;
    constructor(options = {}) {
        this.options = options;
        this.createTransport =
            options.createTransport ?? ((transportOptions) => new DshStdioTransport(transportOptions));
    }
    getOrCreate(sessionKey) {
        if (this.closed) {
            throw new Error('dsh session pool is closed');
        }
        const existing = this.sessions.get(sessionKey);
        if (existing) {
            return existing;
        }
        const { createTransport: _createTransport, forSession, ...transportOptions } = this.options;
        const transport = this.createTransport({ ...transportOptions, ...forSession?.(sessionKey) });
        this.sessions.set(sessionKey, transport);
        return transport;
    }
    release(sessionKey) {
        const transport = this.sessions.get(sessionKey);
        if (!transport) {
            return false;
        }
        this.sessions.delete(sessionKey);
        transport.close();
        return true;
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const transport of this.sessions.values()) {
            transport.close();
        }
        this.sessions.clear();
    }
    async shutdown() {
        const results = await Promise.allSettled([...this.sessions.values()].map((transport) => transport.shutdown()));
        this.close();
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) {
            throw new AggregateError(failures.map((result) => result.reason), 'DSH runtime teardown failed');
        }
    }
    get size() {
        return this.sessions.size;
    }
}
