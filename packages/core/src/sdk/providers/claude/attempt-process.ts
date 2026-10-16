import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { browserAgentEnv } from '../../../utils/browser-env.js';

type Identity = { pid: number; parent: number; group: number; owner: number; started: string; state: string };
export interface AttemptExit {
  pid?: number;
  status: 'not-started' | 'exited' | 'killed' | 'unconfirmed';
  confirmed: boolean;
  closeFailed: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  signals: NodeJS.Signals[];
  inspectionAvailable: boolean;
}

async function processes(): Promise<Identity[]> {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,stat='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]), group: Number(row[3]),
      owner: Number(row[4]), started: row[5], state: row[6] }] : [];
  });
}
const same = (a: Identity, b: Identity) => a.pid === b.pid && a.group === b.group
  && a.owner === b.owner && a.started === b.started;

/** Own exactly one SDK spawn. Sealing also rejects deferred spawns after close. */
export class ClaudeAttemptProcess {
  private child?: ChildProcessWithoutNullStreams;
  private sealed = false;
  private ended = false;
  private flight?: Promise<AttemptExit>;
  private known = new Map<number, Identity>();
  private inspected = false;
  private inspectionAvailable = process.platform !== 'win32';
  private closeFailed = false;
  private readonly signals: NodeJS.Signals[] = [];
  private readonly listeners = new Set<() => void>();
  private initialInspection: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    stderr?: (data: string) => void;
    eofGraceMs?: number;
    termGraceMs?: number;
    killWaitMs?: number;
  } = {}) {}

  get started(): boolean { return this.child?.pid !== undefined; }
  get pid(): number | undefined { return this.child?.pid; }
  get closed(): boolean { return this.sealed; }

  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    if (this.sealed || this.child) { throw new Error('Claude attempt no longer accepts a process spawn'); }
    // The SDK merges its environment again before this hook. Apply the existing
    // provider environment policy at the final OS boundary as well.
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: browserAgentEnv(options.env),
      stdio: 'pipe', detached: process.platform !== 'win32', windowsHide: true, signal: options.signal });
    this.child = child;
    child.stdin.on('error', () => { /* The SDK also observes its stdin failure. */ });
    child.stderr.on('data', (data: Buffer) => {
      try { this.options.stderr?.(data.toString()); } catch { /* Diagnostic observers cannot own process liveness. */ }
    });
    child.once('exit', () => { this.ended = true; this.wake(); });
    child.once('error', () => {
      if (!child.pid) { this.ended = true; this.wake(); }
    });
    this.initialInspection = this.inspect().then(() => {}, () => { this.inspectionAvailable = false; });
    return child;
  };

  private wake(): void { for (const listener of this.listeners) { listener(); } }

  /** Capture descendants while their ancestry is visible and retain lifetime IDs. */
  private async inspect(): Promise<Identity[]> {
    const pid = this.child?.pid;
    if (!pid || process.platform === 'win32') { return []; }
    const rows = await processes();
    this.inspectionAvailable = true;
    const root = rows.find(row => row.pid === pid && row.parent === process.pid);
    if (!this.inspected && root && !this.ended) { this.known.set(root.pid, root); }
    this.inspected = true;
    const owned = new Set(rows.filter(row => {
      const previous = this.known.get(row.pid);
      return previous && same(previous, row);
    }).map(row => row.pid));
    let count = -1;
    while (count !== owned.size) {
      count = owned.size;
      for (const row of rows) {
        const owner = root?.owner ?? this.known.values().next().value?.owner;
        if (owned.has(row.parent) && row.owner === owner) { owned.add(row.pid); }
      }
    }
    for (const row of rows) { if (owned.has(row.pid)) { this.known.set(row.pid, row); } }
    return rows.filter(row => {
      const previous = this.known.get(row.pid);
      return previous && same(previous, row) && !row.state.startsWith('Z');
    });
  }

  private async signal(signal: NodeJS.Signals): Promise<void> {
    if (!this.child) { return; }
    if (process.platform === 'win32') {
      if (!this.ended && this.child.kill(signal)) { this.signals.push(signal); }
      return;
    }
    // Recheck every lifetime immediately before signaling. A known member
    // proves its dedicated group still belongs to this attempt after reparenting.
    let live: Identity[];
    try { live = await this.inspect(); }
    catch {
      this.inspectionAvailable = false;
      // The held ChildProcess handle still identifies the native child. Its
      // descendants remain unverified and exit confirmation will report that.
      if (!this.ended && this.child.kill(signal)) { this.signals.push(signal); }
      return;
    }
    const groups = new Set<number>();
    for (const row of live) {
      if (row.group === this.child.pid || this.known.has(row.group)) { groups.add(row.group); }
    }
    for (const group of groups) {
      try { process.kill(-group, signal); this.signals.push(signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
    }
    for (const row of live) {
      if (groups.has(row.group)) { continue; }
      try { process.kill(row.pid, signal); this.signals.push(signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
    }
  }

  private wait(ms: number): Promise<void> {
    if (this.ended) { return new Promise(resolve => setTimeout(resolve, ms)); }
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.listeners.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.listeners.add(done);
    });
  }

  private async confirmed(): Promise<boolean> {
    if (!this.child) { return true; }
    const { pid } = this.child;
    if (!pid) { return this.ended; }
    if (process.platform === 'win32') { return this.ended; }
    try {
      const live = await this.inspect();
      if (!this.ended || live.length) { return false; }
      if (this.known.size) { return true; }
      // A very short-lived child may exit before the first ps snapshot.
      try { process.kill(-pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    } catch { this.inspectionAvailable = false; return false; }
  }

  stop(close?: () => void): Promise<AttemptExit> {
    this.sealed = true;
    if (this.flight) { return this.flight; }
    const closeSdk = () => {
      try { close?.(); } catch { this.closeFailed = true; }
      try { this.child?.stdin.end(); } catch { this.closeFailed = true; }
    };
    if (!this.child) {
      closeSdk();
      this.flight = Promise.resolve(this.report(true));
      return this.flight;
    }
    this.flight = (async () => {
      await this.initialInspection;
      try { await this.inspect(); } catch { this.inspectionAvailable = false; }
      closeSdk();
      let confirmed = await this.confirmed();
      try {
        if (!confirmed) {
          await this.wait(this.options.eofGraceMs ?? 2000);
          confirmed = await this.confirmed();
        }
        if (!confirmed) {
          await this.signal('SIGTERM');
          await this.wait(this.options.termGraceMs ?? 5000);
          confirmed = await this.confirmed();
        }
        if (!confirmed) {
          await this.signal('SIGKILL');
          await this.wait(this.options.killWaitMs ?? 1000);
          confirmed = await this.confirmed();
        }
      } catch { this.inspectionAvailable = false; }
      if (this.ended) {
        this.child?.stdin.destroy(); this.child?.stdout.destroy(); this.child?.stderr.destroy();
      }
      return this.report(confirmed);
    })();
    return this.flight;
  }

  private report(confirmed: boolean): AttemptExit {
    return { pid: this.child?.pid, status: !this.child?.pid ? 'not-started' : !confirmed ? 'unconfirmed'
      : this.child.signalCode ? 'killed' : 'exited', confirmed,
    closeFailed: this.closeFailed, code: this.child?.exitCode, signal: this.child?.signalCode,
    signals: [...new Set(this.signals)], inspectionAvailable: this.inspectionAvailable };
  }
}
