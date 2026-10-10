import {
  CodexAppServerTransport,
  type CodexAppServerDynamicToolSpec,
  type CodexAppServerExit,
  type CodexAppServerTransportOptions,
} from './app-server-transport.js';

import type { AgentInputRequest } from '../../user-input.js';
import type { CodexReasoningEffort } from '../../../config/types.js';
import { CodexAsyncUserInput } from './async-user-input.js';
export type CodexAppServerSessionState = 'idle' | 'active' | 'waiting-user' | 'uncertain';

export interface CodexAppServerSessionSnapshot {
  sessionKey: string;
  threadId?: string;
  activeTurnId?: string;
  state: CodexAppServerSessionState;
}

type CodexControlOperation = 'steer' | 'interrupt';

export class CodexNoActiveTurnError extends Error {
  readonly code = 'CODEX_NO_ACTIVE_TURN';
  readonly sessionState: CodexAppServerSessionState;
  readonly threadId: string | undefined;
  readonly activeTurnId: string | undefined;

  constructor(
    readonly operation: CodexControlOperation,
    session: CodexAppServerSessionSnapshot,
  ) {
    const recovery = session.state === 'idle'
      ? 'The previous turn is complete; send a new message to start another turn.'
      : session.state === 'uncertain'
        ? 'The turn state is uncertain; reconcile or reset the session before retrying.'
        : 'Wait until the active turn is confirmed, then retry.';
    super(
      `Cannot ${operation} Codex app-server session ${session.sessionKey}: no steerable active turn ` +
      `(state=${session.state}, threadId=${session.threadId}, activeTurnId=${session.activeTurnId ?? 'none'}). ` +
      `${recovery} No control request was sent.`,
    );
    this.name = 'CodexNoActiveTurnError';
    this.sessionState = session.state;
    this.threadId = session.threadId;
    this.activeTurnId = session.activeTurnId;
  }
}

interface ThreadResponse {
  thread?: { id?: string };
}

interface TurnResponse {
  turn?: { id?: string };
  turnId?: string;
}

interface CodexModelCatalogEntry {
  id?: string;
  model?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}

interface CodexModelListResponse {
  data?: CodexModelCatalogEntry[];
  nextCursor?: string | null;
}

/** Owns app-server thread/turn identity; it never retries an uncertain turn. */
export class CodexAppServerLifecycle {
  private readonly transport: CodexAppServerTransport;
  private readonly sessions = new Map<string, CodexAppServerSessionSnapshot>();
  private readonly threadFlights = new Map<string, Promise<string>>();
  private readonly completedTurns = new Set<string>();
  private readonly interruptFlights = new Map<string, Promise<void>>();
  private readonly turnWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly interruptTimeoutMs: number;
  private initialized = false;
  private initializeFlight?: Promise<void>;
  private readonly pendingInputs = new Set<AgentInputRequest>();
  private readonly asyncInputs: CodexAsyncUserInput;
  private readonly reasoningEffortsByModel = new Map<string, Set<string>>();

  constructor(options: CodexAppServerTransportOptions = {}) {
    this.interruptTimeoutMs = options.requestTimeoutMs ?? 10000;
    const onUserInput = options.onUserInput ? async (request: AgentInputRequest): Promise<void> => {
      this.pendingInputs.add(request);
      request.signal.addEventListener('abort', () => this.pendingInputs.delete(request), { once: true });
      await options.onUserInput?.({ ...request, respond: async answers => {
        await request.respond(answers);
        this.pendingInputs.delete(request);
      } });
    } : undefined;
    this.asyncInputs = new CodexAsyncUserInput(onUserInput, async (threadId, turnId, text) => {
      const response = await this.transport.request('turn/steer', {
        threadId, expectedTurnId: turnId, input: [{ type: 'text', text }],
      }) as TurnResponse;
      if (response.turnId !== turnId) { throw new Error('Async answer did not match its originating turn'); }
    }, options.userInputTimeoutMs);
    this.transport = new CodexAppServerTransport({
      ...options, onUserInput,
      onNotification: (method, params) => {
        this.receive(method, params);
        const handled = method === 'item/completed' && this.asyncInputs.receive(params);
        options.onNotification?.(method, handled ? { ...(params as Record<string, unknown>), agentInputHandled: true } : params);
      },
      onExit: (exit) => {
        this.asyncInputs.close();
        for (const waiter of this.turnWaiters.values()) {
          waiter.reject(new Error('codex app-server exited before interruption completed'));
        }
        this.turnWaiters.clear();
        options.onExit?.(exit);
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
      dynamicTools?: CodexAppServerDynamicToolSpec[];
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
      dynamicTools?: CodexAppServerDynamicToolSpec[];
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
          ...(options.dynamicTools?.length ? { dynamicTools: options.dynamicTools } : {}),
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
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
    } = {},
  ): Promise<string> {
    const session = this.requireSession(sessionKey);
    if (session.state === 'uncertain') {
      throw new Error('previous app-server turn has unknown commit state; refusing automatic replay');
    }
    if (session.activeTurnId) {
      throw new Error(`app-server session already has active turn ${session.activeTurnId}`);
    }
    if (options.reasoningEffort) {
      await this.validateReasoningEffort(options.model, options.reasoningEffort);
    }
    session.state = 'uncertain';
    try {
      const response = (await this.transport.request('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: input }],
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
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

  private async validateReasoningEffort(model: string | undefined, effort: CodexReasoningEffort): Promise<void> {
    const cacheKey = model ?? '<default>';
    let supported = this.reasoningEffortsByModel.get(cacheKey);
    if (!supported) {
      let cursor: string | undefined;
      let selected: CodexModelCatalogEntry | undefined;
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        let page: CodexModelListResponse;
        try {
          page = await this.transport.request('model/list', cursor ? { cursor } : {}) as CodexModelListResponse;
        } catch {
          throw new Error(
            `Cannot verify Codex reasoning effort "${effort}": the app-server model catalog is unavailable. ` +
            'Update the Codex CLI or unset agent.codex.reasoningEffort.'
          );
        }
        const models = Array.isArray(page?.data) ? page.data : [];
        selected = model
          ? models.find(item => item.model === model || item.id === model)
          : models.find(item => item.isDefault);
        if (selected) {
          break;
        }
        cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        if (!cursor) {
          break;
        }
      }
      const selectedModel = selected?.model ?? selected?.id;
      if (!selected || !selectedModel || !Array.isArray(selected.supportedReasoningEfforts)) {
        throw new Error(`Cannot verify Codex reasoning effort "${effort}": model "${model ?? 'Codex CLI default'}" is absent from the app-server model catalog. Choose a listed model or unset agent.codex.reasoningEffort.`);
      }
      supported = new Set(selected.supportedReasoningEfforts
        .map(item => item.reasoningEffort)
        .filter((value): value is string => typeof value === 'string' && value.length > 0));
      this.reasoningEffortsByModel.set(cacheKey, supported);
    }
    if (!supported.has(effort)) {
      throw new Error(`Codex model "${model ?? 'Codex CLI default'}" does not support reasoning effort "${effort}"; supported values: ${[...supported].join(', ') || 'none listed'}.`);
    }
  }

  async interrupt(sessionKey: string): Promise<void> {
    const pending = this.interruptFlights.get(sessionKey);
    if (pending) {return pending;}
    const flight = this.interruptTurn(sessionKey);
    this.interruptFlights.set(sessionKey, flight);
    try { await flight; } finally { this.interruptFlights.delete(sessionKey); }
  }

  private async interruptTurn(sessionKey: string): Promise<void> {
    const session = this.requireActive(sessionKey, 'interrupt');
    const turnId = session.activeTurnId;
    this.asyncInputs.cancel('cancelled', session.threadId, turnId);
    this.transport.cancelUserInputs(session.threadId as string, turnId as string);
    const key = `${session.threadId}:${turnId}`;
    // The RPC ACK only accepts the interrupt. Keep the stream busy until the
    // matching terminal notification makes it safe to start another turn.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      this.turnWaiters.set(key, { resolve, reject });
      timer = setTimeout(() => reject(new Error('codex interruption completion timed out')), this.interruptTimeoutMs);
    });
    try {
      await Promise.all([
        completed,
        this.transport.request('turn/interrupt', { threadId: session.threadId, turnId }).catch((error: unknown) => {
          // A natural completion can win the interrupt RPC. Its matching
          // terminal event, not this error or the ACK, remains the authority.
          if (!(error instanceof Error && error.message.includes('no active turn to interrupt'))) {throw error;}
        }),
      ]);
    } catch (error) {
      if (session.activeTurnId === turnId) {session.state = 'uncertain';}
      throw error;
    } finally {
      if (timer) {clearTimeout(timer);}
      this.turnWaiters.delete(key);
    }
  }

  async steer(sessionKey: string, input: string): Promise<string> {
    const session = this.requireActive(sessionKey, 'steer');
    const turnId = session.activeTurnId as string;
    const response = (await this.transport.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: input }],
    })) as TurnResponse;
    if (response.turnId !== turnId) {
      throw new Error('Steer acknowledgement did not match its targeted turn');
    }
    return turnId;
  }

  snapshot(sessionKey: string): CodexAppServerSessionSnapshot | undefined {
    const session = this.sessions.get(sessionKey);
    return session ? { ...session, state: session.state === 'active' && [...this.pendingInputs].some(input => input.isBlocking
      && input.threadId === session.threadId && input.turnId === session.activeTurnId) ? 'waiting-user' : session.state } : undefined;
  }

  forgetSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session?.threadId) { this.asyncInputs.cancel('closed', session.threadId); }
    this.sessions.delete(sessionKey);
    this.threadFlights.delete(sessionKey);
  }

  close(): Promise<CodexAppServerExit> {
    this.asyncInputs.close();
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
      this.asyncInputs.cancel('turn-ended', threadId, turnId);
      this.completedTurns.add(`${threadId}:${turnId}`);
      this.turnWaiters.get(`${threadId}:${turnId}`)?.resolve();
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

  private requireActive(sessionKey: string, operation: CodexControlOperation): CodexAppServerSessionSnapshot {
    const session = this.requireSession(sessionKey);
    if (session.state !== 'active' || !session.activeTurnId) {
      throw new CodexNoActiveTurnError(operation, session);
    }
    return session;
  }
}
