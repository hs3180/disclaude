import { browserAgentEnv } from '../../../utils/browser-env.js';
import { CODEX_BROWSER_DISABLE_ARGS } from './browser-policy.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { UserInput } from '../../types.js';
import { createLogger } from '../../../utils/logger.js';

import { readProcessGroupResources } from './process-resources.js';
import { parseAgentInputParams, validateAgentInputAnswers, type AgentInputRequest, type AgentInputParams } from '../../user-input.js';
import { captureDescendantGroups, signalDescendantGroups, type OwnedDescendantGroup } from './owned-descendants.js';

type JsonRpcId = number | string;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexAppServerTransportOptions {
  binary?: string;
  sessionKey?: string;
  correlation?: UserInput['correlation'];
  env?: NodeJS.ProcessEnv;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (exit: CodexAppServerExit) => void;
  requestTimeoutMs?: number;
  killGraceMs?: number;
  onUserInput?: (request: AgentInputRequest) => Promise<void>;
  userInputTimeoutMs?: number;
}

export interface CodexAppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

/**
 * Experimental persistent stdio transport for the Codex app-server protocol.
 * It is deliberately not selected by CodexAgentProvider yet: `codex exec`
 * remains the default until thread/turn lifecycle parity is implemented.
 */
export class CodexAppServerTransport {
  private readonly logger;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly exitPromise: Promise<CodexAppServerExit>;
  private resolveExit!: (exit: CodexAppServerExit) => void;
  private stderrTail = '';
  private nextId = 1;
  private acceptingRequests = true;
  private shutdownStarted = false;
  private exitReported = false;
  private cleanup?: Promise<CodexAppServerExit>;
  private readonly inputs = new Map<JsonRpcId, {
    params: AgentInputParams; abort: AbortController; timer: ReturnType<typeof setTimeout>; writing: boolean;
  }>();
  private readonly seenInputIds = new Set<JsonRpcId>();

  constructor(private readonly options: CodexAppServerTransportOptions = {}) {
    this.logger = createLogger('CodexAppServerTransport', Object.freeze({
      sessionKey: options.sessionKey, runId: randomUUID(), ...options.correlation,
    }));
    this.child = spawn(options.binary ?? 'codex', ['app-server', '--stdio', ...CODEX_BROWSER_DISABLE_ARGS,
      ...(options.onUserInput ? ['--enable', 'default_mode_request_user_input'] : [])], {
      env: browserAgentEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      // A dedicated POSIX process group owns ordinary tool descendants too.
      detached: process.platform !== 'win32',
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.receive(line));
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8192);
      this.logger.debug({ source: 'stderr', chunkLength: chunk.length }, 'Codex app-server diagnostic chunk');
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
    // Descendants can outlive a crashed parent, including with detached stdio.
    this.child.once('exit', (code, signal) => {
      this.failAll(new Error(`codex app-server exited (code=${String(code)}, signal=${String(signal)})`));
      void this.close();
    });
  }

  async initialize(clientName = 'disclaude', clientVersion = '0.5.0'): Promise<unknown> {
    const result = await this.request('initialize', {
      clientInfo: { name: clientName, title: 'Disclaude', version: clientVersion },
      capabilities: this.options.onUserInput ? { experimentalApi: true } : null,
    });
    this.notify('initialized');
    await this.reportResources('initialized');
    return result;
  }

  request(method: string, params?: unknown): Promise<unknown> {
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

  notify(method: string, params?: unknown): void {
    if (this.acceptingRequests) {
      this.write({ jsonrpc: '2.0', method, params });
    }
  }

  close(): Promise<CodexAppServerExit> {
    if (this.shutdownStarted) {
      return this.cleanup ?? this.exitPromise;
    }
    this.shutdownStarted = true;
    this.acceptingRequests = false;
    this.lines.close();
    this.failAll(new Error('codex app-server transport closed'));
    this.cleanup = (async () => {
      let descendants: OwnedDescendantGroup[] = [];
      try { descendants = await captureDescendantGroups(this.child.pid ?? 0); }
      catch { this.logger.warn('Could not inspect app-server descendant groups before shutdown'); }
      const signalDescendants = async (signal: NodeJS.Signals): Promise<void> => {
        try { await signalDescendantGroups(descendants, signal); }
        catch { this.logger.warn({ signal }, 'Could not signal verified app-server descendant groups'); }
      };
      await signalDescendants('SIGTERM');
      const signalled = this.signalOwnedGroup('SIGTERM');
      if (signalled || descendants.length) {
        // Parent exit is not proof that its children exited. Await the grace
        // period before escalating the owned group, even after parent close.
        const deadline = Date.now() + (this.options.killGraceMs ?? 1_000);
        while ((this.groupAlive() || descendants.length > 0) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await signalDescendants('SIGKILL');
        if (this.groupAlive()) {this.signalOwnedGroup('SIGKILL');}
      }
      const exit = await this.exitPromise;
      await this.reportResources('closed');
      return exit;
    })();
    return this.cleanup;
  }

  private async reportResources(phase: 'initialized' | 'closed'): Promise<void> {
    const resources = await readProcessGroupResources(this.child.pid ?? 0);
    this.logger.info({ sessionKey: this.options.sessionKey, phase, ...resources }, 'Codex owned process resources');
  }

  private groupAlive(): boolean {
    if (!this.child.pid) {return false;}
    if (process.platform === 'win32') {return this.child.exitCode === null && this.child.signalCode === null;}
    try {process.kill(-this.child.pid, 0); return true;}
    catch (error) {return (error as NodeJS.ErrnoException).code !== 'ESRCH';}
  }

  private signalOwnedGroup(signal: NodeJS.Signals): boolean {
    if (!this.child.pid) {return false;}
    try {
      if (process.platform === 'win32') {return this.child.kill(signal);}
      process.kill(-this.child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {return false;}
      // macOS can report EPERM while a dying group's final member is reaped.
      // Keep teardown idempotent; record a real signaling failure for operators.
      this.logger.warn({ pid: this.child.pid, signal, code: (error as NodeJS.ErrnoException).code }, 'Could not signal owned app-server process group');
      return signal !== 'SIGKILL';
    }
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  cancelUserInputs(threadId: string, turnId: string): void {
    for (const [id, input] of this.inputs) {
      if (input.params.threadId === threadId && input.params.turnId === turnId) { this.cancelInput(id, 'Turn interrupted'); }
    }
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        this.failAll(error);
      }
    });
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return;
      }
      message = parsed as JsonRpcMessage;
    } catch {
      return;
    }
    this.logger.debug({ source: 'stdout', eventType: message.method ?? 'response', requestId: message.id }, 'Codex app-server event');
    if (message.id !== undefined && message.method) {
      if (message.method === 'item/tool/requestUserInput' && this.options.onUserInput) {
        this.receiveUserInput(message.id, message.params);
        return;
      }
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
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      const event = message.params as { threadId?: string; requestId?: JsonRpcId; turn?: { id?: string } } | undefined;
      if (message.method === 'serverRequest/resolved' && event?.requestId !== undefined) {
        if (this.inputs.get(event.requestId)?.params.threadId === event.threadId) { this.cancelInput(event.requestId, undefined, 'resolved'); }
      }
      if (message.method === 'turn/completed' && event?.threadId && event.turn?.id) {
        for (const [id, input] of this.inputs) {
          if (input.params.threadId === event.threadId && input.params.turnId === event.turn.id) { this.cancelInput(id, undefined, 'turn-ended'); }
        }
      }
      try {
        this.options.onNotification?.(message.method, message.params);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        void this.close();
      }
    }
  }

  private failAll(error: Error): void {
    this.acceptingRequests = false;
    for (const id of this.inputs.keys()) { this.cancelInput(id, undefined, 'closed'); }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private cancelInput(id: JsonRpcId, replyError?: string, reason = 'cancelled'): void {
    const input = this.inputs.get(id);
    if (!input) { return; }
    this.inputs.delete(id);
    clearTimeout(input.timer);
    input.abort.abort(reason);
    if (replyError && this.acceptingRequests && !input.writing) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32800, message: replyError } });
    }
  }

  private receiveUserInput(id: JsonRpcId, raw: unknown): void {
    if (!this.acceptingRequests) { return; }
    // A duplicated server request must not create two actionable cards or replies.
    if (this.seenInputIds.has(id)) { return; }
    let params: AgentInputParams;
    try {
      if (!(typeof id === 'string' && id.length <= 200) && !Number.isSafeInteger(id)) { throw new Error('Invalid ID'); }
      params = parseAgentInputParams(raw);
    } catch {
      this.write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unsupported user-input request shape' } });
      return;
    }
    if (this.seenInputIds.size >= 1000) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Too many user-input requests in this session' } });
      return;
    }
    this.seenInputIds.add(id);
    const abort = new AbortController();
    const timer = setTimeout(() => this.cancelInput(id, 'User input expired without an answer', 'expired'), this.options.userInputTimeoutMs ?? 15 * 60_000);
    timer.unref();
    const pending = { params, abort, timer, writing: false };
    this.inputs.set(id, pending);
    const request: AgentInputRequest = { ...params, requestId: id, signal: abort.signal, respond: async value => {
      if (this.inputs.get(id) !== pending || pending.writing || !this.acceptingRequests) { throw new Error('User-input request is no longer active'); }
      const answers = validateAgentInputAnswers(params, value);
      pending.writing = true;
      try {
        await new Promise<void>((resolve, reject) => {
          this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { answers } })}\n`, error => error ? reject(new Error('User-input response delivery failed')) : resolve());
        });
        if (abort.signal.aborted) { throw new Error('User-input response delivery failed'); }
        clearTimeout(timer);
        this.inputs.delete(id);
      } catch {
        this.cancelInput(id, undefined, 'unavailable');
        throw new Error('User-input response delivery failed');
      }
    } };
    // Keep the JSON-RPC reader free to process turn completion and cancellation.
    void Promise.resolve().then(() => {
      if (!abort.signal.aborted) { return this.options.onUserInput?.(request); }
      return undefined;
    }).catch(() => this.cancelInput(id, 'User-input channel unavailable', 'unavailable'));
  }

  private reportExit(exit: CodexAppServerExit): void {
    if (this.exitReported) {return;}
    this.exitReported = true;
    this.resolveExit(exit);
    try {
      this.options.onExit?.(exit);
    } catch {
      // Exit observers are diagnostic/lifecycle hooks; never escape an event handler.
    }
  }
}
