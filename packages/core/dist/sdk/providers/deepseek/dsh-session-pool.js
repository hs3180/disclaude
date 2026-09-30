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
        const { createTransport: _createTransport, ...transportOptions } = this.options;
        const transport = this.createTransport(transportOptions);
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
    get size() {
        return this.sessions.size;
    }
}
