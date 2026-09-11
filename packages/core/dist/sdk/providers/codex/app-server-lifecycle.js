import { CodexAppServerTransport, } from './app-server-transport.js';
/** Owns app-server thread/turn identity; it never retries an uncertain turn. */
export class CodexAppServerLifecycle {
    transport;
    sessions = new Map();
    threadFlights = new Map();
    completedTurns = new Set();
    interruptFlights = new Map();
    turnWaiters = new Map();
    interruptTimeoutMs;
    initialized = false;
    initializeFlight;
    constructor(options = {}) {
        this.interruptTimeoutMs = options.requestTimeoutMs ?? 10000;
        this.transport = new CodexAppServerTransport({
            ...options,
            onNotification: (method, params) => {
                this.receive(method, params);
                options.onNotification?.(method, params);
            },
            onExit: (exit) => {
                for (const waiter of this.turnWaiters.values()) {
                    waiter.reject(new Error('codex app-server exited before interruption completed'));
                }
                this.turnWaiters.clear();
                options.onExit?.(exit);
            },
        });
    }
    async initialize() {
        if (this.initialized) {
            return;
        }
        this.initializeFlight ??= this.transport.initialize().then(() => {
            this.initialized = true;
        });
        await this.initializeFlight;
    }
    async ensureThread(sessionKey, options = {}) {
        await this.initialize();
        const current = this.sessions.get(sessionKey);
        if (current?.threadId) {
            return current.threadId;
        }
        const existingFlight = this.threadFlights.get(sessionKey);
        if (existingFlight) {
            return existingFlight;
        }
        const flight = this.createThread(sessionKey, options);
        this.threadFlights.set(sessionKey, flight);
        try {
            return await flight;
        }
        finally {
            this.threadFlights.delete(sessionKey);
        }
    }
    async createThread(sessionKey, options) {
        const sandbox = options.sandbox ?? 'read-only';
        const response = options.threadId
            ? await this.transport.request('thread/resume', {
                threadId: options.threadId,
                ...(options.cwd ? { cwd: options.cwd } : {}),
                ...(options.model ? { model: options.model } : {}),
                sandbox,
                approvalPolicy: 'never',
            })
            : await this.transport.request('thread/start', {
                ...(options.cwd ? { cwd: options.cwd } : {}),
                ...(options.model ? { model: options.model } : {}),
                approvalPolicy: 'never',
                sandbox,
            });
        const threadId = response.thread?.id;
        if (!threadId) {
            throw new Error('codex app-server thread response omitted thread.id');
        }
        this.sessions.set(sessionKey, { sessionKey, threadId, state: 'idle' });
        return threadId;
    }
    async startTurn(sessionKey, input, options = {}) {
        const session = this.requireSession(sessionKey);
        if (session.state === 'uncertain') {
            throw new Error('previous app-server turn has unknown commit state; refusing automatic replay');
        }
        if (session.activeTurnId) {
            throw new Error(`app-server session already has active turn ${session.activeTurnId}`);
        }
        session.state = 'uncertain';
        try {
            const response = (await this.transport.request('turn/start', {
                threadId: session.threadId,
                input: [{ type: 'text', text: input }],
                approvalPolicy: 'never',
                sandboxPolicy: options.sandbox === 'danger-full-access'
                    ? { type: 'dangerFullAccess' }
                    : options.sandbox === 'workspace-write'
                        ? {
                            type: 'workspaceWrite',
                            networkAccess: options.networkAccess ?? false,
                            writableRoots: options.cwd ? [options.cwd] : [],
                            excludeSlashTmp: true,
                            excludeTmpdirEnvVar: true,
                        }
                        : { type: 'readOnly', networkAccess: options.networkAccess ?? false },
            }));
            const turnId = response.turn?.id ?? response.turnId;
            if (!turnId) {
                throw new Error('codex app-server turn response omitted turn id');
            }
            session.activeTurnId = turnId;
            const completionKey = `${session.threadId}:${turnId}`;
            if (this.completedTurns.delete(completionKey)) {
                session.activeTurnId = undefined;
                session.state = 'idle';
            }
            else {
                session.state = 'active';
            }
            return turnId;
        }
        catch (error) {
            // The request may have reached Codex before the transport failed.
            // Keep `uncertain`: callers must reconcile, never replay silently.
            throw error;
        }
    }
    async interrupt(sessionKey) {
        const pending = this.interruptFlights.get(sessionKey);
        if (pending) {
            return pending;
        }
        const flight = this.interruptTurn(sessionKey);
        this.interruptFlights.set(sessionKey, flight);
        try {
            await flight;
        }
        finally {
            this.interruptFlights.delete(sessionKey);
        }
    }
    async interruptTurn(sessionKey) {
        const session = this.requireActive(sessionKey);
        const turnId = session.activeTurnId;
        const key = `${session.threadId}:${turnId}`;
        // The RPC ACK only accepts the interrupt. Keep the stream busy until the
        // matching terminal notification makes it safe to start another turn.
        let timer;
        const completed = new Promise((resolve, reject) => {
            this.turnWaiters.set(key, { resolve, reject });
            timer = setTimeout(() => reject(new Error('codex interruption completion timed out')), this.interruptTimeoutMs);
        });
        try {
            await Promise.all([
                completed,
                this.transport.request('turn/interrupt', { threadId: session.threadId, turnId }).catch((error) => {
                    // A natural completion can win the interrupt RPC. Its matching
                    // terminal event, not this error or the ACK, remains the authority.
                    if (!(error instanceof Error && error.message.includes('no active turn to interrupt'))) {
                        throw error;
                    }
                }),
            ]);
        }
        catch (error) {
            if (session.activeTurnId === turnId) {
                session.state = 'uncertain';
            }
            throw error;
        }
        finally {
            if (timer) {
                clearTimeout(timer);
            }
            this.turnWaiters.delete(key);
        }
    }
    async steer(sessionKey, input) {
        const session = this.requireActive(sessionKey);
        const response = (await this.transport.request('turn/steer', {
            threadId: session.threadId,
            expectedTurnId: session.activeTurnId,
            input: [{ type: 'text', text: input }],
        }));
        return response.turnId ?? session.activeTurnId;
    }
    snapshot(sessionKey) {
        const session = this.sessions.get(sessionKey);
        return session ? { ...session } : undefined;
    }
    forgetSession(sessionKey) {
        this.sessions.delete(sessionKey);
        this.threadFlights.delete(sessionKey);
    }
    close() {
        return this.transport.close();
    }
    receive(method, params) {
        if (method !== 'turn/completed') {
            return;
        }
        const event = params;
        const { threadId } = event;
        const turnId = event.turn?.id;
        if (threadId && turnId) {
            this.completedTurns.add(`${threadId}:${turnId}`);
            this.turnWaiters.get(`${threadId}:${turnId}`)?.resolve();
        }
        for (const session of this.sessions.values()) {
            if (session.threadId === threadId && session.activeTurnId === turnId) {
                this.completedTurns.delete(`${threadId}:${turnId}`);
                session.activeTurnId = undefined;
                session.state = 'idle';
            }
        }
    }
    requireSession(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (!session?.threadId) {
            throw new Error(`app-server session ${sessionKey} has no thread`);
        }
        return session;
    }
    requireActive(sessionKey) {
        const session = this.requireSession(sessionKey);
        if (session.state !== 'active' || !session.activeTurnId) {
            throw new Error(`app-server session ${sessionKey} has no steerable active turn`);
        }
        return session;
    }
}
