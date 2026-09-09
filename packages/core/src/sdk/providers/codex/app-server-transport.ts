import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

type JsonRpcId = number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexAppServerTransportOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  onNotification?: (method: string, params: unknown) => void;
  requestTimeoutMs?: number;
  killGraceMs?: number;
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

  constructor(private readonly options: CodexAppServerTransportOptions = {}) {
    this.child = spawn(options.binary ?? 'codex', ['app-server', '--stdio'], {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.receive(line));
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8192);
    });
    this.child.stdin.on('error', (error) => this.failAll(error));
    this.child.once('error', (error) => {
      this.failAll(error);
      this.resolveExit({ code: null, signal: null, stderrTail: this.stderrTail });
    });
    this.child.once('close', (code, signal) => {
      this.failAll(new Error(`codex app-server exited (code=${String(code)}, signal=${String(signal)})`));
      this.resolveExit({ code, signal, stderrTail: this.stderrTail });
    });
  }

  async initialize(clientName = 'disclaude', clientVersion = '0.5.0'): Promise<unknown> {
    const result = await this.request('initialize', {
      clientInfo: { name: clientName, title: 'Disclaude', version: clientVersion },
      capabilities: null,
    });
    this.notify('initialized');
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

  getStderrTail(): string {
    return this.stderrTail;
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
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (message.method) {
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
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}
