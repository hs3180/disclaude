/**
 * Minimal dsh SDK transport (Issue #4742).
 *
 * dsh's SDK profile is a line-delimited JSON-RPC process.  This module owns
 * only process/lifecycle and request correlation; event mapping and provider
 * session policy remain separate follow-ups.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface DshTransportOptions {
  binary?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  onNotification?: (message: DshRpcNotification) => void;
  onProtocolError?: (error: Error, line: string) => void;
}

export interface DshRpcNotification {
  jsonrpc?: string;
  method: string;
  params?: unknown;
}

export interface DshRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface DshRpcResponse {
  jsonrpc?: string;
  id: number;
  result?: unknown;
  error?: DshRpcError;
}

interface DshRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class DshStdioTransport {
  private readonly options: DshTransportOptions;
  private child: ChildProcess | undefined;
  private readline: Interface | undefined;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: DshTransportOptions = {}) {
    this.options = options;
  }

  start(): void {
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
      this.fail(
        new Error(`dsh process exited before completion (code=${code}, signal=${signal ?? 'none'})`)
      );
    });
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    this.start();
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      return Promise.reject(new Error('dsh transport stdin is unavailable'));
    }

    const id = this.nextId++;
    const request: DshRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
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
          reject(
            new Error(`dsh request timed out: ${method} (${this.options.requestTimeoutMs}ms)`)
          );
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

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readline?.close();
    this.child?.kill();
    this.fail(new Error('dsh transport closed'));
  }

  /** Ask the SDK runtime to dispose its agents before closing stdio. */
  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.request('shutdown', {});
    } finally {
      this.close();
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: DshRpcResponse | DshRpcNotification;
    try {
      message = JSON.parse(line) as DshRpcResponse | DshRpcNotification;
    } catch {
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
      } else {
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

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      this.clearPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearPending(pending: PendingRequest): void {
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
