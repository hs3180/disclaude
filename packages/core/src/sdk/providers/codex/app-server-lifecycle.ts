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
  private readonly threadFlights = new Map<string, Promise<string>>();
  private readonly completedTurns = new Set<string>();
  private initialized = false;
  private initializeFlight?: Promise<void>;

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
    if (this.initialized) {
      return;
    }
    this.initializeFlight ??= this.transport.initialize().then(() => {
      this.initialized = true;
    });
    await this.initializeFlight;
  }

  async ensureThread(
    sessionKey: string,
    options: {
      threadId?: string;
      cwd?: string;
      model?: string;
      sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    } = {},
  ): Promise<string> {
    await this.initialize();
    const current = this.sessions.get(sessionKey);
    if (current?.threadId) {
      return current.threadId;
    }
    const existingFlight = this.threadFlights.get(sessionKey);
    if (existingFlight) {
      return existingFlight;
    }
    const flight = this.createThread(sessionKey, options);
    this.threadFlights.set(sessionKey, flight);
    try {
      return await flight;
    } finally {
      this.threadFlights.delete(sessionKey);
    }
  }

  private async createThread(
    sessionKey: string,
    options: {
      threadId?: string;
      cwd?: string;
      model?: string;
      sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    },
  ): Promise<string> {
    const sandbox = options.sandbox ?? 'read-only';
    const response = options.threadId
      ? await this.transport.request('thread/resume', {
          threadId: options.threadId,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.model ? { model: options.model } : {}),
          sandbox,
          approvalPolicy: 'never',
        })
      : await this.transport.request('thread/start', {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.model ? { model: options.model } : {}),
          approvalPolicy: 'never',
          sandbox,
        });
    const threadId = (response as ThreadResponse).thread?.id;
    if (!threadId) {
      throw new Error('codex app-server thread response omitted thread.id');
    }
    this.sessions.set(sessionKey, { sessionKey, threadId, state: 'idle' });
    return threadId;
  }

  async startTurn(
    sessionKey: string,
    input: string,
    options: {
      sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
      networkAccess?: boolean;
      cwd?: string;
    } = {},
  ): Promise<string> {
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
        sandboxPolicy: options.sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' }
          : options.sandbox === 'workspace-write'
            ? {
                type: 'workspaceWrite',
                networkAccess: options.networkAccess ?? false,
                writableRoots: options.cwd ? [options.cwd] : [],
                excludeSlashTmp: true,
                excludeTmpdirEnvVar: true,
              }
            : { type: 'readOnly', networkAccess: options.networkAccess ?? false },
      })) as TurnResponse;
      const turnId = response.turn?.id ?? response.turnId;
      if (!turnId) {
        throw new Error('codex app-server turn response omitted turn id');
      }
      session.activeTurnId = turnId;
      const completionKey = `${session.threadId}:${turnId}`;
      if (this.completedTurns.delete(completionKey)) {
        session.activeTurnId = undefined;
        session.state = 'idle';
      } else {
        session.state = 'active';
      }
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

  forgetSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.threadFlights.delete(sessionKey);
  }

  close(): Promise<CodexAppServerExit> {
    return this.transport.close();
  }

  private receive(method: string, params: unknown): void {
    if (method !== 'turn/completed') {
      return;
    }
    const event = params as { threadId?: string; turn?: { id?: string } };
    const { threadId } = event;
    const turnId = event.turn?.id;
    if (threadId && turnId) {
      this.completedTurns.add(`${threadId}:${turnId}`);
    }
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId && session.activeTurnId === turnId) {
        this.completedTurns.delete(`${threadId}:${turnId}`);
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
