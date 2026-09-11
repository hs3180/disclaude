import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
/**
 * Experimental persistent stdio transport for the Codex app-server protocol.
 * It is deliberately not selected by CodexAgentProvider yet: `codex exec`
 * remains the default until thread/turn lifecycle parity is implemented.
 */
export class CodexAppServerTransport {
    options;
    child;
    lines;
    pending = new Map();
    exitPromise;
    resolveExit;
    stderrTail = '';
    nextId = 1;
    acceptingRequests = true;
    shutdownStarted = false;
    exitReported = false;
    constructor(options = {}) {
        this.options = options;
        this.child = spawn(options.binary ?? 'codex', ['app-server', '--stdio'], {
            env: options.env ?? process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.lines = createInterface({ input: this.child.stdout });
        this.lines.on('line', (line) => this.receive(line));
        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve;
        });
        this.child.stderr.on('data', (chunk) => {
            this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8192);
        });
        this.child.stdin.on('error', (error) => this.failAll(error));
        this.child.once('error', (error) => {
            this.failAll(error);
            this.reportExit({ code: null, signal: null, stderrTail: this.stderrTail });
        });
        this.child.once('close', (code, signal) => {
            this.failAll(new Error(`codex app-server exited (code=${String(code)}, signal=${String(signal)})`));
            this.reportExit({ code, signal, stderrTail: this.stderrTail });
        });
    }
    async initialize(clientName = 'disclaude', clientVersion = '0.5.0') {
        const result = await this.request('initialize', {
            clientInfo: { name: clientName, title: 'Disclaude', version: clientVersion },
            capabilities: null,
        });
        this.notify('initialized');
        return result;
    }
    request(method, params) {
        if (!this.acceptingRequests) {
            return Promise.reject(new Error('codex app-server transport is closed'));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`codex app-server request timed out: ${method}`));
            }, this.options.requestTimeoutMs ?? 30_000);
            timer.unref();
            this.pending.set(id, { resolve, reject, timer });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }
    notify(method, params) {
        if (this.acceptingRequests) {
            this.write({ jsonrpc: '2.0', method, params });
        }
    }
    close() {
        if (this.shutdownStarted) {
            return this.exitPromise;
        }
        this.shutdownStarted = true;
        this.acceptingRequests = false;
        this.lines.close();
        this.child.kill('SIGTERM');
        const killTimer = setTimeout(() => this.child.kill('SIGKILL'), this.options.killGraceMs ?? 1_000);
        killTimer.unref();
        void this.exitPromise.finally(() => clearTimeout(killTimer));
        this.failAll(new Error('codex app-server transport closed'));
        return this.exitPromise;
    }
    getStderrTail() {
        return this.stderrTail;
    }
    write(message) {
        this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
            if (error) {
                this.failAll(error);
            }
        });
    }
    receive(line) {
        let message;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return;
            }
            message = parsed;
        }
        catch {
            return;
        }
        if (message.id !== undefined && message.method) {
            // Tool and approval requests require an explicit policy integration.
            // Rejecting is fail-closed; silently ignoring would hang the turn.
            this.write({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: `Unsupported app-server request: ${message.method}` },
            });
            return;
        }
        if (message.id !== undefined) {
            const waiter = this.pending.get(message.id);
            if (!waiter) {
                return;
            }
            this.pending.delete(message.id);
            clearTimeout(waiter.timer);
            if (message.error) {
                waiter.reject(new Error(`Codex app-server error ${message.error.code}: ${message.error.message}`));
            }
            else {
                waiter.resolve(message.result);
            }
            return;
        }
        if (message.method) {
            try {
                this.options.onNotification?.(message.method, message.params);
            }
            catch (error) {
                this.failAll(error instanceof Error ? error : new Error(String(error)));
                void this.close();
            }
        }
    }
    failAll(error) {
        this.acceptingRequests = false;
        for (const waiter of this.pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.pending.clear();
    }
    reportExit(exit) {
        if (this.exitReported) {
            return;
        }
        this.exitReported = true;
        this.resolveExit(exit);
        try {
            this.options.onExit?.(exit);
        }
        catch {
            // Exit observers are diagnostic/lifecycle hooks; never escape an event handler.
        }
    }
}
