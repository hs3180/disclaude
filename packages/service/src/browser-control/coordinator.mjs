import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BrowserHarnessSession } from './harness-session.mjs';

/** Cooperative browser-control coordinator, NOT a production security boundary. */
export class Coordinator {
  constructor({
    url,
    target,
    event = () => {},
    verifyReclaimed = async () => {},
    ttlMs = 1000,
    hardMs = 10000,
    sessionOptions = {},
    createSession = options => new BrowserHarnessSession(options),
    startupMs = 5000,
    cleanupRuntime = () => {},
    onTargetChange = () => {},
  }) {
    Object.assign(this, {
      url,
      target,
      event,
      verifyReclaimed,
      ttlMs,
      hardMs,
      sessionOptions,
      createSession,
      startupMs,
      cleanupRuntime,
      onTargetChange,
    });
    this.boot = randomUUID();
    this.epoch = 0;
    this.queue = [];
    this.holder = null;
    this.busy = false;
    this.closed = false;
    this.monitor = setInterval(() => {
      const holder = this.holder;
      if (holder && holder.state === 'held' && performance.now() >= holder.deadline) {
        void this.revoke(holder, 'expired');
      }
    }, 20);
  }

  log(type, fields = {}) {
    this.event({ type, ms: performance.now(), ...fields });
  }

  acquire(actor, { waitMs = 5000 } = {}) {
    const ticket = { actor, id: randomUUID(), enqueued: performance.now() };
    const promise = new Promise((resolve, reject) => Object.assign(ticket, { resolve, reject }));
    if (this.closed) {
      ticket.reject(new Error('Coordinator unavailable'));
      return { promise, cancel() {} };
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
      const holder = this.holder;
      if (holder?.ticket !== ticket || holder.state !== 'allocating') return false;
      clearTimeout(ticket.timer);
      ticket.reject(new Error(reason));
      this.log('waiter-removed', { actor: ticket.actor, reason });
      void this.revoke(holder, 'allocation-cancelled');
      return true;
    }
    this.queue.splice(index, 1);
    clearTimeout(ticket.timer);
    ticket.reject(new Error(reason));
    this.log('waiter-removed', { actor: ticket.actor, reason });
    return true;
  }

  async startSession(session) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Browser harness startup timeout (${this.startupMs}ms)`)), this.startupMs);
    });
    try {
      return await Promise.race([session.start(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async pump() {
    if (this.busy || this.holder || this.closed || !this.queue.length) return;
    this.busy = true;
    const ticket = this.queue.shift();
    clearTimeout(ticket.timer);
    const holder = {
      ticket,
      actor: ticket.actor,
      epoch: ++this.epoch,
      token: randomUUID(),
      state: 'allocating',
      serial: Promise.resolve(),
    };
    this.holder = holder;
    try {
      holder.sessionOptions = typeof this.sessionOptions === 'function'
        ? this.sessionOptions()
        : this.sessionOptions;
      holder.session = this.createSession({
        ...holder.sessionOptions,
        url: this.url,
        target: this.target,
        startupMs: this.startupMs,
        onEvent: record => this.log(record.type, { epoch: holder.epoch, ...record }),
        onDaemonExit: details => {
          if (holder.state === 'held') void this.revoke(holder, 'daemon-exit');
          else holder.daemonExitDetails = details;
        },
      });
      const session = await this.startSession(holder.session);
      if (this.closed || holder.state !== 'allocating') throw new Error('Allocation cancelled');
      if (holder.daemonExitDetails || holder.session.daemonExitDetails) {
        const details = holder.daemonExitDetails ?? holder.session.daemonExitDetails;
        throw new Error(`Browser harness daemon exited during startup (code=${details.code ?? 'none'}, signal=${details.signal ?? 'none'})`);
      }
      holder.pid = session?.pid ?? holder.session.daemon?.pid;
      holder.state = 'held';
      holder.hardDeadline = performance.now() + this.hardMs;
      holder.deadline = Math.min(performance.now() + this.ttlMs, holder.hardDeadline);
      this.log('granted', {
        actor: holder.actor,
        epoch: holder.epoch,
        pid: holder.pid,
        waitMs: performance.now() - ticket.enqueued,
      });
      ticket.resolve({ actor: holder.actor, epoch: holder.epoch, token: holder.token, boot: this.boot });
    } catch (error) {
      if (String(error.message).includes('startup timeout')) {
        this.log('harness-startup-timeout', {
          epoch: holder.epoch,
          startupMs: this.startupMs,
          stderr: holder.session?.stderr || undefined,
        });
      }
      this.log('allocation-failed', {
        epoch: holder.epoch,
        error: error.message,
        stderr: holder.session?.stderr || undefined,
      });
      ticket.reject(error);
      await this.revoke(holder, 'allocation-failed');
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  validate(lease) {
    const holder = this.holder;
    if (
      !holder ||
      holder.state !== 'held' ||
      lease.boot !== this.boot ||
      lease.token !== holder.token ||
      lease.actor !== holder.actor ||
      lease.epoch !== holder.epoch ||
      performance.now() >= holder.deadline
    ) {
      throw new Error('Lease is not current');
    }
    return holder;
  }

  heartbeat(lease) {
    const holder = this.validate(lease);
    holder.deadline = Math.min(performance.now() + this.ttlMs, holder.hardDeadline);
  }

  execute(lease, command, value) {
    let holder;
    try {
      holder = this.validate(lease);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = holder.serial.then(async () => {
      this.validate(lease); // Fence again when the queued script actually begins.
      if (command !== 'script' || typeof value?.code !== 'string') {
        throw new Error('Expected Python script');
      }
      const result = await holder.session.execute(value.code, value.cwd);
      if (result.target && holder === this.holder && holder.state === 'held') {
        this.target = result.target;
        this.onTargetChange(result.target);
      }
      return result.result;
    });
    holder.serial = operation.catch(() => {});
    return operation;
  }

  async release(lease) {
    let holder;
    try {
      holder = this.validate(lease);
    } catch {
      return false;
    }
    await this.revoke(holder, 'release');
    return true;
  }

  revoke(holder, reason) {
    if (holder.recovery) return holder.recovery;
    holder.state = 'revoking';
    this.log('revoking', { epoch: holder.epoch, reason });
    holder.recovery = (async () => {
      let cleanupPhase = 'stop-harness-session';
      try {
        await holder.session?.stop();
        cleanupPhase = 'verify-reclaimed';
        await this.verifyReclaimed();
        cleanupPhase = 'cleanup-runtime';
        await this.cleanupRuntime(holder.sessionOptions);
      } catch (error) {
        this.closed = true;
        holder.state = 'quarantined';
        this.log('quarantined', { epoch: holder.epoch, phase: cleanupPhase, reason: error.message });
        for (const ticket of [...this.queue]) this.cancel(ticket, 'Browser unavailable: reclaim failed');
        return;
      }
      this.log('reclaimed', { epoch: holder.epoch });
      if (this.holder === holder) this.holder = null;
      void this.pump();
    })();
    return holder.recovery;
  }

  async close() {
    this.closed = true;
    clearInterval(this.monitor);
    for (const ticket of [...this.queue]) this.cancel(ticket, 'Coordinator closed');
    if (this.holder) await this.revoke(this.holder, 'shutdown');
  }
}
