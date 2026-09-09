import {
  CodexAppServerTransport,
  type CodexAppServerExit,
  type CodexAppServerTransportOptions,
} from './app-server-transport.js';

export type CodexAppServerSessionState = 'idle' | 'active' | 'uncertain';

export interface CodexAppServerSessionSnapshot {
  sessionKey: string;
  threadId?: string;
  activeTurnId?: string;
  state: CodexAppServerSessionState;
}

interface ThreadResponse {
  thread?: { id?: string };
}

interface TurnResponse {
  turn?: { id?: string };
  turnId?: string;
}

/** Owns app-server thread/turn identity; it never retries an uncertain turn. */
export class CodexAppServerLifecycle {
  private readonly transport: CodexAppServerTransport;
  private readonly sessions = new Map<string, CodexAppServerSessionSnapshot>();
  private initialized = false;

  constructor(options: CodexAppServerTransportOptions = {}) {
    this.transport = new CodexAppServerTransport({
      ...options,
      onNotification: (method, params) => {
        options.onNotification?.(method, params);
        this.receive(method, params);
      },
    });
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.transport.initialize();
      this.initialized = true;
    }
  }

  async ensureThread(
    sessionKey: string,
    options: { threadId?: string; cwd?: string; model?: string } = {},
  ): Promise<string> {
    await this.initialize();
    const current = this.sessions.get(sessionKey);
    if (current?.threadId) {
      return current.threadId;
    }
    const response = options.threadId
      ? await this.transport.request('thread/resume', {
          threadId: options.threadId,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.model ? { model: options.model } : {}),
        })
      : await this.transport.request('thread/start', {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.model ? { model: options.model } : {}),
          approvalPolicy: 'never',
        });
    const threadId = (response as ThreadResponse).thread?.id;
    if (!threadId) {
      throw new Error('codex app-server thread response omitted thread.id');
    }
    this.sessions.set(sessionKey, { sessionKey, threadId, state: 'idle' });
    return threadId;
  }

  async startTurn(sessionKey: string, input: string): Promise<string> {
    const session = this.requireSession(sessionKey);
    if (session.state === 'uncertain') {
      throw new Error('previous app-server turn has unknown commit state; refusing automatic replay');
    }
    if (session.activeTurnId) {
      throw new Error(`app-server session already has active turn ${session.activeTurnId}`);
    }
    session.state = 'uncertain';
    try {
      const response = (await this.transport.request('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: input }],
        approvalPolicy: 'never',
      })) as TurnResponse;
      const turnId = response.turn?.id ?? response.turnId;
      if (!turnId) {
        throw new Error('codex app-server turn response omitted turn id');
      }
      session.activeTurnId = turnId;
      session.state = 'active';
      return turnId;
    } catch (error) {
      // The request may have reached Codex before the transport failed.
      // Keep `uncertain`: callers must reconcile, never replay silently.
      throw error;
    }
  }

  async interrupt(sessionKey: string): Promise<void> {
    const session = this.requireActive(sessionKey);
    await this.transport.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
  }

  async steer(sessionKey: string, input: string): Promise<string> {
    const session = this.requireActive(sessionKey);
    const response = (await this.transport.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: session.activeTurnId,
      input: [{ type: 'text', text: input }],
    })) as TurnResponse;
    return response.turnId ?? session.activeTurnId as string;
  }

  snapshot(sessionKey: string): CodexAppServerSessionSnapshot | undefined {
    const session = this.sessions.get(sessionKey);
    return session ? { ...session } : undefined;
  }

  close(): Promise<CodexAppServerExit> {
    return this.transport.close();
  }

  private receive(method: string, params: unknown): void {
    if (method !== 'turn/completed') {
      return;
    }
    const event = params as { threadId?: string; turn?: { id?: string } };
    for (const session of this.sessions.values()) {
      if (session.threadId === event.threadId && session.activeTurnId === event.turn?.id) {
        session.activeTurnId = undefined;
        session.state = 'idle';
      }
    }
  }

  private requireSession(sessionKey: string): CodexAppServerSessionSnapshot {
    const session = this.sessions.get(sessionKey);
    if (!session?.threadId) {
      throw new Error(`app-server session ${sessionKey} has no thread`);
    }
    return session;
  }

  private requireActive(sessionKey: string): CodexAppServerSessionSnapshot {
    const session = this.requireSession(sessionKey);
    if (session.state !== 'active' || !session.activeTurnId) {
      throw new Error(`app-server session ${sessionKey} has no steerable active turn`);
    }
    return session;
  }
}
