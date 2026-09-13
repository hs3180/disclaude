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
            env: this.options.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        if (!child.stdout) {
            throw new Error('dsh transport stdout is unavailable');
        }
        this.readline = createInterface({ input: child.stdout });
        this.readline.on('line', (line) => this.handleLine(line));
        child.on('error', (error) => this.fail(error));
        child.on('close', (code, signal) => {
            this.fail(new Error(`dsh process exited before completion (code=${code}, signal=${signal ?? 'none'})`));
        });
    }
    request(method, params, signal) {
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
            if (!stdin.write(`${JSON.stringify(request)}\n`)) {
                this.pending.delete(id);
                this.clearPending(pending);
                reject(new Error('dsh transport failed to write request'));
            }
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
    async shutdown() {
        if (this.closed) {
            return;
        }
        try {
            await this.request('shutdown', {});
        }
        finally {
            this.close();
        }
    }
    handleLine(line) {
        if (!line.trim()) {
            return;
        }
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            this.options.onProtocolError?.(new Error('dsh emitted invalid JSON'), line);
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
    fail(error) {
        for (const pending of this.pending.values()) {
            this.clearPending(pending);
            pending.reject(error);
        }
        this.pending.clear();
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
