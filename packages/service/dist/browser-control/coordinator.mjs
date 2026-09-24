import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
/** Cooperative browser-control coordinator, NOT a production security boundary. */
export class Coordinator {
    constructor({ url, target, event = () => { }, verifyReclaimed = async () => { }, ttlMs = 1000, hardMs = 10000, workerModule = new URL('./harness-worker.mjs', import.meta.url), workerOptions = {}, detachedWorker = false, startupMs = 5000, cleanupWorker = () => { }, onTargetChange = () => { } }) {
        Object.assign(this, { url, target, event, verifyReclaimed, ttlMs, hardMs, workerModule, workerOptions, detachedWorker, startupMs, cleanupWorker, onTargetChange });
        this.boot = randomUUID();
        this.epoch = 0;
        this.queue = [];
        this.holder = null;
        this.busy = false;
        this.closed = false;
        this.monitor = setInterval(() => {
            const h = this.holder;
            if (h && h.state === 'held' && performance.now() >= h.deadline)
                void this.revoke(h, 'expired');
        }, 20);
    }
    log(type, fields = {}) { this.event({ type, ms: performance.now(), ...fields }); }
    acquire(actor, { waitMs = 5000 } = {}) {
        const ticket = { actor, id: randomUUID(), enqueued: performance.now() };
        const promise = new Promise((resolve, reject) => Object.assign(ticket, { resolve, reject }));
        if (this.closed) {
            ticket.reject(new Error('Coordinator unavailable'));
            return { promise, cancel() { } };
        }
        ticket.timer = setTimeout(() => this.cancel(ticket, 'wait timeout'), waitMs);
        this.queue.push(ticket);
        this.log('queued', { actor, ticket: ticket.id });
        void this.pump();
        return { promise, cancel: () => this.cancel(ticket, 'cancelled') };
    }
    cancel(ticket, reason) {
        const index = this.queue.indexOf(ticket);
        if (index < 0) {
            const h = this.holder;
            if (h?.ticket !== ticket || h.state !== 'allocating')
                return false;
            clearTimeout(ticket.timer);
            ticket.reject(new Error(reason));
            this.log('waiter-removed', { actor: ticket.actor, reason });
            void this.revoke(h, 'allocation-cancelled');
            return true;
        }
        this.queue.splice(index, 1);
        clearTimeout(ticket.timer);
        ticket.reject(new Error(reason));
        this.log('waiter-removed', { actor: ticket.actor, reason });
        return true;
    }
    async pump() {
        if (this.busy || this.holder || this.closed || !this.queue.length)
            return;
        this.busy = true;
        const ticket = this.queue.shift();
        clearTimeout(ticket.timer);
        const h = { ticket, actor: ticket.actor, epoch: ++this.epoch, token: randomUUID(), state: 'allocating', pending: new Map(), serial: Promise.resolve(), seq: 0 };
        this.holder = h;
        try {
            h.workerOptions = typeof this.workerOptions === 'function' ? this.workerOptions() : this.workerOptions;
            h.child = fork(this.workerModule, [], { detached: this.detachedWorker, env: { ...process.env, DISCLAUDE_BROWSER_WORKER_GROUP: this.detachedWorker ? '1' : '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            h.exited = new Promise(resolve => h.child.once('exit', (code, signal) => {
                this.log('worker-exit', { epoch: h.epoch, pid: h.child.pid, code, signal, stderr: h.workerStderr?.trim() || undefined });
                for (const p of h.pending.values())
                    p.reject(new Error('Worker exited; outcome unknown'));
                h.pending.clear();
                resolve();
                if (h.state === 'held')
                    void this.revoke(h, 'worker-exit');
            }));
            h.workerStderr = '';
            h.child.stderr.setEncoding('utf8');
            h.child.stderr.on('data', chunk => { h.workerStderr = (h.workerStderr + chunk).slice(-4000); });
            h.child.on('error', error => this.log('worker-error', { epoch: h.epoch, error: error.message, stderr: h.workerStderr.trim() || undefined }));
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const error = new Error('Worker startup timeout');
                    this.log('worker-startup-timeout', { epoch: h.epoch, startupMs: this.startupMs, stderr: h.workerStderr.trim() || undefined });
                    reject(error);
                }, this.startupMs);
                h.child.once('exit', (code, signal) => {
                    clearTimeout(timer);
                    this.log('worker-startup-exit', { epoch: h.epoch, code, signal, stderr: h.workerStderr.trim() || undefined });
                    reject(new Error(`Worker startup exit (code=${code}, signal=${signal || 'none'})`));
                });
                h.child.on('message', message => {
                    if (message.kind === 'daemon-started')
                        this.log('daemon-started', { epoch: h.epoch, pid: message.pid, python: message.python, cwd: message.cwd });
                    else if (message.kind === 'daemon-exit')
                        this.log('daemon-exit', { epoch: h.epoch, code: message.code, signal: message.signal, error: message.error });
                    else if (message.kind === 'ready') {
                        clearTimeout(timer);
                        resolve();
                    }
                    else if (message.kind === 'init-error') {
                        clearTimeout(timer);
                        this.log('worker-init-error', { epoch: h.epoch, error: message.error, stderr: h.workerStderr.trim() || undefined });
                        reject(new Error(message.error));
                    }
                    else if (message.kind === 'result') {
                        const item = h.pending.get(message.id);
                        if (!item)
                            return;
                        h.pending.delete(message.id);
                        if (message.target && h === this.holder && h.state === 'held') {
                            this.target = message.target;
                            this.onTargetChange(message.target);
                        }
                        message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
                    }
                });
                h.child.send({ kind: 'init', url: this.url, target: this.target, options: h.workerOptions }, error => {
                    if (!error)
                        return;
                    clearTimeout(timer);
                    this.log('worker-init-send-error', { epoch: h.epoch, error: error.message, stderr: h.workerStderr.trim() || undefined });
                    reject(error);
                });
            });
            if (this.closed || h.state !== 'allocating')
                throw new Error('Allocation cancelled');
            h.state = 'held';
            h.hardDeadline = performance.now() + this.hardMs;
            h.deadline = Math.min(performance.now() + this.ttlMs, h.hardDeadline);
            this.log('granted', { actor: h.actor, epoch: h.epoch, pid: h.child.pid, waitMs: performance.now() - ticket.enqueued });
            ticket.resolve({ actor: h.actor, epoch: h.epoch, token: h.token, boot: this.boot });
        }
        catch (error) {
            this.log('allocation-failed', { epoch: h.epoch, error: error.message, stderr: h.workerStderr?.trim() || undefined });
            ticket.reject(error);
            await this.revoke(h, 'allocation-failed');
        }
        finally {
            this.busy = false;
            void this.pump();
        }
    }
    validate(lease) {
        const h = this.holder;
        if (!h || h.state !== 'held' || lease.boot !== this.boot || lease.token !== h.token || lease.actor !== h.actor || lease.epoch !== h.epoch || performance.now() >= h.deadline)
            throw new Error('Lease is not current');
        return h;
    }
    heartbeat(lease) { const h = this.validate(lease); h.deadline = Math.min(performance.now() + this.ttlMs, h.hardDeadline); }
    execute(lease, command, value) {
        let h;
        try {
            h = this.validate(lease);
        }
        catch (error) {
            return Promise.reject(error);
        }
        const operation = h.serial.then(() => {
            this.validate(lease); // fencing at actual send, not only enqueue
            const id = ++h.seq;
            this.log('execute', { actor: h.actor, epoch: h.epoch, id, command });
            return new Promise((resolve, reject) => {
                h.pending.set(id, { resolve, reject });
                h.child.send({ kind: 'execute', id, command, value }, error => {
                    if (error) {
                        h.pending.delete(id);
                        reject(error);
                    }
                });
            });
        });
        h.serial = operation.catch(() => { });
        return operation;
    }
    async release(lease) {
        let h;
        try {
            h = this.validate(lease);
        }
        catch {
            return false;
        }
        await this.revoke(h, 'release');
        return true;
    }
    revoke(h, reason) {
        if (h.recovery)
            return h.recovery;
        h.state = 'revoking';
        this.log('revoking', { epoch: h.epoch, reason });
        h.recovery = (async () => {
            if (h.child && h.child.exitCode === null && h.child.signalCode === null) {
                if (h.child.connected)
                    h.child.send({ kind: 'stop' }, () => { });
                const timer = setTimeout(() => this.killWorker(h), 500);
                await h.exited;
                clearTimeout(timer);
            }
            if (this.detachedWorker && h.child)
                this.killWorker(h); // Includes an orphaned harness/CLI after worker death.
            // Also verify browser-side detachment; process exit alone is not the barrier.
            // Cleanup is part of the same barrier: a cleanup exception must quarantine
            // the coordinator instead of becoming an unhandled rejection that drops
            // every connected client as an unexplained IPC EOF.
            let cleanupPhase = 'verify-reclaimed';
            try {
                await this.verifyReclaimed();
                cleanupPhase = 'cleanup-worker';
                await this.cleanupWorker(h.workerOptions);
            }
            catch (error) {
                this.closed = true;
                h.state = 'quarantined';
                this.log('quarantined', { epoch: h.epoch, phase: cleanupPhase, reason: error.message });
                for (const ticket of [...this.queue])
                    this.cancel(ticket, 'Browser unavailable: reclaim failed');
                return;
            }
            this.log('reclaimed', { epoch: h.epoch });
            if (this.holder === h)
                this.holder = null;
            void this.pump();
        })();
        return h.recovery;
    }
    killWorker(h) {
        try {
            if (this.detachedWorker)
                process.kill(-h.child.pid, 'SIGKILL');
            else
                h.child.kill('SIGKILL');
        }
        catch (error) {
            if (error.code !== 'ESRCH')
                throw error;
        }
    }
    inject(lease, fault) {
        const h = this.validate(lease);
        if (fault === 'kill')
            h.child.kill('SIGKILL');
        else if (fault === 'disconnect')
            h.child.send({ kind: 'disconnect' });
        else
            throw new Error('Unknown fault');
    }
    async close() {
        this.closed = true;
        clearInterval(this.monitor);
        for (const ticket of [...this.queue])
            this.cancel(ticket, 'Coordinator closed');
        if (this.holder)
            await this.revoke(this.holder, 'shutdown');
    }
}
