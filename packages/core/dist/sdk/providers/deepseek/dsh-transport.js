import { browserAgentEnv } from '../../../utils/browser-env.js';
/**
 * Minimal dsh SDK transport (Issue #4742).
 *
 * dsh's SDK profile is a line-delimited JSON-RPC process.  This module owns
 * only process/lifecycle and request correlation; event mapping and provider
 * session policy remain separate follow-ups.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
export class DshStdioTransport {
    options;
    child;
    readline;
    nextId = 1;
    closed = false;
    ended = false;
    processExit;
    shutdownFlight;
    pending = new Map();
    constructor(options = {}) {
        this.options = options;
    }
    start() {
        if (this.closed) {
            throw new Error('dsh transport is closed');
        }
        if (this.child) {
            return;
        }
        const child = spawn(this.options.binary ?? 'dsh', this.options.args ?? ['--profile', 'sdk'], {
            cwd: this.options.cwd,
            env: browserAgentEnv(this.options.env),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        this.processExit = new Promise((resolve) => child.once('close', () => resolve()));
        // Drain diagnostics even when no consumer is attached, so startup cannot
        // deadlock on a full stderr pipe (for example, an unsupported SDK profile).
        child.stderr?.resume();
        const { onStderr } = this.options;
        if (onStderr) {
            child.stderr?.on('data', (chunk) => onStderr(String(chunk)));
        }
        if (!child.stdout) {
            throw new Error('dsh transport stdout is unavailable');
        }
        this.readline = createInterface({ input: child.stdout });
        this.readline.on('line', (line) => this.handleLine(line));
        child.on('error', (error) => this.exited(error));
        child.on('close', (code, signal) => {
            this.exited(new Error(`dsh process exited before completion (code=${code}, signal=${signal ?? 'none'})`));
        });
    }
    request(method, params, signal) {
        if (signal?.aborted) {
            return Promise.reject(new Error(`dsh request cancelled: ${method}`));
        }
        if (this.ended) {
            return Promise.reject(new Error('dsh process has exited'));
        }
        this.start();
        const stdin = this.child?.stdin;
        if (!stdin || stdin.destroyed) {
            return Promise.reject(new Error('dsh transport stdin is unavailable'));
        }
        const id = this.nextId++;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            ...(params === undefined ? {} : { params }),
        };
        return new Promise((resolve, reject) => {
            const pending = { resolve, reject };
            const rejectCancelled = () => {
                this.pending.delete(id);
                this.clearPending(pending);
                reject(new Error(`dsh request cancelled: ${method}`));
            };
            if (signal?.aborted) {
                rejectCancelled();
                return;
            }
            if (signal) {
                pending.onAbort = rejectCancelled;
                pending.signal = signal;
                signal.addEventListener('abort', rejectCancelled, { once: true });
            }
            if (this.options.requestTimeoutMs && this.options.requestTimeoutMs > 0) {
                pending.timer = setTimeout(() => {
                    this.pending.delete(id);
                    this.clearPending(pending);
                    reject(new Error(`dsh request timed out: ${method} (${this.options.requestTimeoutMs}ms)`));
                }, this.options.requestTimeoutMs);
                pending.timer.unref?.();
            }
            this.pending.set(id, pending);
            stdin.write(`${JSON.stringify(request)}\n`, (error) => {
                if (!error || !this.pending.delete(id)) {
                    return;
                }
                this.clearPending(pending);
                reject(new Error('dsh transport failed to write request', { cause: error }));
            });
        });
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.readline?.close();
        this.child?.kill();
        this.fail(new Error('dsh transport closed'));
    }
    /** Ask the SDK runtime to dispose its agents before closing stdio. */
    shutdown() {
        if (this.shutdownFlight) {
            return this.shutdownFlight;
        }
        this.shutdownFlight = (async () => {
            if (this.closed) {
                return;
            }
            if (!this.child) {
                this.closed = true;
                return;
            }
            try {
                await this.request('shutdown', {});
            }
            finally {
                this.closed = true;
                this.child.stdin?.end();
                // SDK startup owns EOF/root disposal. Reap the process before removing
                // its profile overlay or persistent home; a SIGTERM alone is not a wait.
                if (!(await this.waitForExit(2_000))) {
                    this.child.kill();
                    if (!(await this.waitForExit(2_000))) {
                        this.child.kill('SIGKILL');
                        if (!(await this.waitForExit(2_000))) {
                            throw new Error('Owned DSH process did not exit');
                        }
                    }
                }
                this.readline?.close();
                this.fail(new Error('dsh transport closed'));
            }
        })();
        return this.shutdownFlight;
    }
    handleLine(line) {
        if (!line.trim()) {
            return;
        }
        let message;
        try {
            message = JSON.parse(line);
            if (!message || typeof message !== 'object' || Array.isArray(message)) {
                throw new Error('Invalid RPC envelope');
            }
        }
        catch {
            this.options.onProtocolError?.(new Error('dsh emitted invalid JSON'), line);
            return;
        }
        if ('id' in message &&
            'method' in message &&
            (typeof message.id === 'string' || typeof message.id === 'number')) {
            const request = message;
            void Promise.resolve()
                .then(() => {
                if (!this.options.onRequest) {
                    throw new Error('DSH host requests are not configured');
                }
                return this.options.onRequest(request);
            })
                .then((result) => this.reply(request.id, { result }), (error) => this.reply(request.id, {
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : 'DSH host operation failed',
                },
            }));
            return;
        }
        if ('id' in message && typeof message.id === 'number') {
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            this.clearPending(pending);
            if ('error' in message && message.error) {
                pending.reject(new Error(`dsh RPC error ${message.error.code}: ${message.error.message}`));
            }
            else {
                pending.resolve(message.result);
            }
            return;
        }
        if ('method' in message && typeof message.method === 'string') {
            this.options.onNotification?.(message);
            return;
        }
        this.options.onProtocolError?.(new Error('dsh emitted an unknown JSON-RPC message'), line);
    }
    reply(id, body) {
        const stdin = this.child?.stdin;
        if (!stdin || stdin.destroyed || this.closed) {
            return;
        }
        let frame;
        try {
            frame = JSON.stringify({ jsonrpc: '2.0', id, ...body });
        }
        catch {
            frame = JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message: 'DSH host output is not JSON serializable' },
            });
        }
        stdin.write(`${frame}\n`, (error) => {
            if (error) {
                this.fail(new Error('DSH host response write failed', { cause: error }));
            }
        });
    }
    fail(error) {
        for (const pending of this.pending.values()) {
            this.clearPending(pending);
            pending.reject(error);
        }
        this.pending.clear();
    }
    exited(error) {
        if (this.ended) {
            return;
        }
        this.ended = true;
        this.fail(error);
        if (!this.closed) {
            this.options.onExit?.(error);
        }
    }
    async waitForExit(timeoutMs) {
        const exit = this.processExit;
        if (!exit) {
            return true;
        }
        let timer;
        try {
            return await Promise.race([
                exit.then(() => true),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(false), timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
    clearPending(pending) {
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }
        // AbortSignal listeners are one-shot, but removing the callback here also
        // covers successful responses, timeouts, write failures, and transport
        // shutdown before the signal fires.
        if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener('abort', pending.onAbort);
        }
        pending.onAbort = undefined;
        pending.signal = undefined;
    }
}
