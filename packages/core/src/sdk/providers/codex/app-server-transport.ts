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
  }>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: CodexAppServerTransportOptions = {}) {
    this.child = spawn(options.binary ?? 'codex', ['app-server', '--stdio'], {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.receive(line));
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('close', (code, signal) => {
      this.failAll(new Error(`codex app-server exited (code=${String(code)}, signal=${String(signal)})`));
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
    if (this.closed) {
      return Promise.reject(new Error('codex app-server transport is closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) {
      this.write({ jsonrpc: '2.0', method, params });
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    this.child.kill('SIGTERM');
    this.failAll(new Error('codex app-server transport closed'));
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
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
      if (message.error) {
        waiter.reject(new Error(`Codex app-server error ${message.error.code}: ${message.error.message}`));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.options.onNotification?.(message.method, message.params);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}
