import { DshStdioTransport, type DshTransportOptions } from './dsh-transport.js';

/**
 * Own one dsh transport per disclaude chat/session.
 *
 * The wire-level session methods are deliberately left to the provider. This
 * small pool only defines the lifecycle boundary needed by #4742: a chat
 * reuses its process, chats never share one, and reset/disposal closes it.
 */
export interface DshTransportFactory {
  (options: DshTransportOptions): DshStdioTransport;
}

export interface DshSessionPoolOptions extends DshTransportOptions {
  createTransport?: DshTransportFactory;
}

export class DshSessionPool {
  private readonly options: DshSessionPoolOptions;
  private readonly createTransport: DshTransportFactory;
  private readonly sessions = new Map<string, DshStdioTransport>();
  private closed = false;

  constructor(options: DshSessionPoolOptions = {}) {
    this.options = options;
    this.createTransport =
      options.createTransport ?? ((transportOptions) => new DshStdioTransport(transportOptions));
  }

  getOrCreate(sessionKey: string): DshStdioTransport {
    if (this.closed) {
      throw new Error('dsh session pool is closed');
    }
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const { createTransport: _createTransport, ...transportOptions } = this.options;
    const transport = this.createTransport(transportOptions);
    this.sessions.set(sessionKey, transport);
    return transport;
  }

  release(sessionKey: string): boolean {
    const transport = this.sessions.get(sessionKey);
    if (!transport) {
      return false;
    }
    this.sessions.delete(sessionKey);
    transport.close();
    return true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const transport of this.sessions.values()) {
      transport.close();
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
