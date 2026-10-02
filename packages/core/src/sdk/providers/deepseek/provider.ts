/** DSH profile integration through native Agent, Session, and tool APIs. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '../../../utils/logger.js';
import type { IAgentSDKProvider } from '../../interface.js';
import type { NativeAgentTool } from '../../native-tools.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';
import { DshSessionPool } from './dsh-session-pool.js';
import type { DshRpcNotification, DshRpcRequest, DshStdioTransport } from './dsh-transport.js';
import { adaptDeepSeekEvent, type DeepSeekSessionEvent } from './event-adapter.js';
import { createDshNativeProfileOverlay } from './native-profile.js';
import { DshSessionBindings } from './session-bindings.js';

const logger = createLogger('DeepSeekHarnessProvider');

export interface DeepSeekHarnessProviderOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  /** Native DSH provider route. Omit to use the selected profile's route. */
  provider?: string;
  mode?: 'minimal' | 'standard';
  dshHome?: string;
  binary?: string;
  args?: string[];
  requestTimeoutMs?: number;
}

interface NativeInvocation {
  abort: AbortController;
  work: Promise<unknown>;
}

interface QueryState {
  runtimeId: string;
  sessionId: string;
  sessionKey?: string;
  cwd: string;
  events: AgentMessage[];
  wake(): void;
  abort: AbortController;
  pendingText: string;
  tools: Map<string, NativeAgentTool>;
  invocations: Map<string, NativeInvocation>;
  receivedInvocations: Set<string>;
  stderr?: (data: string) => void;
  opened: boolean;
  idle: boolean;
  stopping: boolean;
  finalized: boolean;
  failure?: Error;
  stop(): Promise<void>;
}

function dshHome(configured: string | undefined): string {
  const value = configured?.trim() || join(homedir(), '.dsh');
  return resolve(
    value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  );
}

export class DeepSeekHarnessProvider implements IAgentSDKProvider {
  readonly name = 'deepseek';
  readonly version = '0.1.2-native';
  private readonly home: string;
  private readonly configuredHome?: string;
  private readonly route?: string;
  private readonly profile: 'sdk' | 'sdk-minimal';
  private readonly bindings: DshSessionBindings;
  private readonly pool: DshSessionPool;
  private readonly queries = new Map<string, QueryState>();
  private readonly active = new Map<string, QueryState>();
  private overlay?: ReturnType<typeof createDshNativeProfileOverlay>;
  private disposed = false;
  private shutdownFlight?: Promise<void>;

  constructor(options: DeepSeekHarnessProviderOptions = {}) {
    const mode = options.mode ?? 'standard';
    if (mode !== 'minimal' && mode !== 'standard') {
      throw new Error('deepseek.mode must be minimal or standard');
    }
    if (options.mode !== undefined && options.args !== undefined) {
      throw new Error('Explicit dsh mode cannot be combined with custom process args');
    }
    if (options.provider !== undefined && !options.provider.trim()) {
      throw new TypeError('deepseek.provider must be non-empty');
    }
    this.profile = mode === 'minimal' ? 'sdk-minimal' : 'sdk';
    const env = options.env ?? process.env;
    this.configuredHome = options.dshHome ?? env.DSH_HOME;
    this.home = dshHome(this.configuredHome);
    this.route = options.provider;
    this.bindings = new DshSessionBindings(this.home);
    this.pool = new DshSessionPool({
      binary: options.binary,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      env: {
        ...process.env,
        ...env,
        DEEPSEEK_API_KEY: options.apiKey ?? env.DEEPSEEK_API_KEY,
        DSH_HOME: this.home,
      },
      forSession: (runtimeId) => {
        const state = this.queries.get(runtimeId);
        if (!state) {
          throw new Error('Native DSH runtime has no owner');
        }
        this.overlay ??= createDshNativeProfileOverlay();
        return {
          cwd: state.cwd,
          args: [...(options.args ?? ['--profile', this.profile]), '--patch', this.overlay.path],
          onRequest: (request) => this.onRequest(state, request),
          onStderr: (data) => state.stderr?.(data),
          onNotification: (notification) => this.onNotification(state, notification),
          onExit: (error) => {
            if (!state.finalized && !state.stopping) {
              state.failure = error;
            }
            for (const invocation of state.invocations.values()) {
              invocation.abort.abort(error);
            }
            state.wake();
          },
          onProtocolError: (error) =>
            logger.warn({ err: error, sessionId: state.sessionId }, 'Invalid DSH protocol frame'),
        };
      },
    });
  }

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      ...(available ? {} : { unavailableReason: this.diagnose() }),
    };
  }

  queryStream(input: AsyncGenerator<UserInput>, options: AgentQueryOptions): StreamQueryResult {
    if (this.disposed) {
      throw new Error('DeepSeekHarnessProvider has been disposed');
    }
    const reason = this.diagnose();
    if (reason) {
      throw new Error(`DeepSeekHarnessProvider unavailable: ${reason}`);
    }
    if (options.mcpServers || options.tools) {
      throw new Error(
        'DSH uses nativeTools and its profile registry; legacy MCP/inline tool options are unsupported'
      );
    }
    if (options.systemPrompt !== undefined && typeof options.systemPrompt !== 'string') {
      throw new TypeError(
        'DSH systemPrompt must be raw text; Claude Code presets belong to their own adapter'
      );
    }
    const tools = new Map<string, NativeAgentTool>();
    const descriptors = options.nativeTools ?? [];
    const seen = new Set<string>();
    for (const tool of descriptors) {
      if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || seen.has(tool.name)) {
        throw new TypeError('Invalid or duplicate native tool name');
      }
      seen.add(tool.name);
      if (
        (!options.allowedTools || options.allowedTools.includes(tool.name)) &&
        !options.disallowedTools?.includes(tool.name)
      ) {
        tools.set(tool.name, tool);
      }
    }
    const cwd = resolve(options.cwd ?? process.cwd());
    const binding = this.bindings.reserve(options.sessionKey, cwd);
    if (this.active.has(binding.sessionId)) {
      throw new Error('Native DSH conversation already has an active query');
    }
    let wake: () => void = () => {};
    const state: QueryState = {
      runtimeId: randomUUID(),
      sessionId: binding.sessionId,
      sessionKey: options.sessionKey,
      cwd,
      events: [],
      wake: () => wake(),
      abort: new AbortController(),
      pendingText: '',
      tools,
      invocations: new Map(),
      receivedInvocations: new Set(),
      stderr: options.stderr,
      opened: false,
      idle: false,
      stopping: false,
      finalized: false,
      stop: () => Promise.resolve(),
    };
    this.queries.set(state.runtimeId, state);
    this.active.set(state.sessionId, state);
    let transport: DshStdioTransport;
    try {
      transport = this.pool.getOrCreate(state.runtimeId);
    } catch (error) {
      this.queries.delete(state.runtimeId);
      this.active.delete(state.sessionId);
      throw error;
    }
    let ready: () => void = () => {};
    const openingFinished = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let stopFlight: Promise<void> | undefined;
    state.stop = () => {
      if (state.finalized) {
        return Promise.resolve();
      }
      if (stopFlight) {
        return stopFlight;
      }
      state.stopping = true;
      state.abort.abort();
      for (const invocation of state.invocations.values()) {
        invocation.abort.abort();
      }
      void input
        .return(undefined)
        .catch((error) => logger.debug({ err: error }, 'DSH input closed'));
      state.wake();
      stopFlight = (async () => {
        await openingFinished;
        try {
          if (state.opened) {
            const ack = (await transport.request('session/cancel', {
              sessionId: state.sessionId,
            })) as { reasoningStopped?: unknown };
            if (ack?.reasoningStopped !== true) {
              throw new Error('DSH did not confirm Agent cancellation');
            }
          }
        } finally {
          await Promise.allSettled(
            [...state.invocations.values()].map((invocation) => invocation.work)
          );
        }
      })();
      return stopFlight;
    };
    let inputDone = false;
    let accepted = 0;
    let terminal = 0;
    const pump = Promise.resolve().then(async () => {
      try {
        state.abort.signal.throwIfAborted();
        const initialized = (await transport.request(
          'initialize',
          {
            cwd,
            ...(this.route === undefined ? {} : { provider: this.route }),
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort }),
            ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
            ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
            ...(options.disallowedTools === undefined
              ? {}
              : { disallowedTools: options.disallowedTools }),
            nativeTools: descriptors.map(({ name, description, inputSchema, outputSchema }) => ({
              name,
              description,
              inputSchema,
              outputSchema,
            })),
          },
          state.abort.signal
        )) as { capabilities?: { nativeTools?: boolean; resume?: boolean; cancel?: boolean } };
        if (
          !initialized?.capabilities?.nativeTools ||
          !initialized.capabilities.resume ||
          !initialized.capabilities.cancel
        ) {
          throw new Error('Selected DSH profile did not load the native controller');
        }
        state.abort.signal.throwIfAborted();
        this.bindings.opening(binding);
        // Once sent, retain the reply even when cancellation arrives so we can
        // cancel/dispose the exact newly opened Agent instead of abandoning it.
        const opened = await transport.request('session/open', {
          sessionId: state.sessionId,
          resume: binding.resume,
        });
        state.opened = true;
        this.bindings.opened(binding);
        logger.info(
          { sessionId: state.sessionId, resumed: binding.resume, native: opened },
          'DSH native session opened'
        );
      } catch (error) {
        if (!state.stopping) {
          state.failure = new Error(
            `dsh profile ${this.profile} native initialize/open failed: ${
              error instanceof Error ? error.message : String(error)
            }. No profile or fresh-session fallback was attempted.`
          );
        }
      } finally {
        ready();
        state.wake();
      }
      try {
        if (!state.opened || state.stopping) {
          return;
        }
        for await (const message of input) {
          if (state.stopping) {
            break;
          }
          state.idle = false;
          const contentBlocks =
            typeof message.content === 'string'
              ? [{ type: 'text', text: message.content }]
              : message.content.map((block) =>
                  block.type === 'text'
                    ? { type: 'text', text: block.text }
                    : { type: 'image', data: block.data, mimeType: block.mimeType }
                );
          await transport.request('session/prompt', { sessionId: state.sessionId, contentBlocks });
          accepted++;
        }
      } catch (error) {
        if (!state.stopping) {
          state.failure = error instanceof Error ? error : new Error(String(error));
        }
      } finally {
        inputDone = true;
        state.wake();
      }
    });
    const provider = this;
    const iterator = (async function* (): AsyncGenerator<AgentMessage> {
      try {
        for (;;) {
          if (state.stopping) {
            await state.stop();
          }
          while (state.events.length) {
            const event = state.events.shift();
            if (!event) {
              continue;
            }
            if (event.type === 'result' || event.type === 'error') {
              terminal++;
            }
            yield event;
          }
          if (state.failure) {
            throw state.failure;
          }
          // DSH may consume several followups in one turn. Queue acceptance
          // count is not a turn count; only native idle closes that batch.
          if (state.stopping || (inputDone && (accepted === 0 || (state.idle && terminal > 0)))) {
            break;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (!state.stopping) {
          await pump;
        }
      } finally {
        try {
          try {
            if (state.stopping || !inputDone || (accepted > 0 && !state.idle)) {
              await state.stop();
            }
          } finally {
            await transport.shutdown();
          }
        } finally {
          state.finalized = true;
          provider.queries.delete(state.runtimeId);
          if (provider.active.get(state.sessionId) === state) {
            provider.active.delete(state.sessionId);
          }
          provider.pool.release(state.runtimeId);
        }
      }
    })();
    const close = () => {
      void state.stop().catch((error) => {
        state.failure = error instanceof Error ? error : new Error(String(error));
        state.wake();
      });
    };
    return {
      handle: { close, cancel: close, interrupt: state.stop, sessionId: state.sessionId },
      iterator,
    };
  }

  createInlineTool(_definition: InlineToolDefinition): unknown {
    throw new Error(
      'DSH registers canonical nativeTools directly; inline-MCP wrappers are unsupported'
    );
  }

  createMcpServer(_config: McpServerConfig): unknown {
    throw new Error('DSH uses its native profile registry rather than a legacy MCP wrapper');
  }

  validateConfig(): boolean {
    return !this.disposed && !this.diagnose();
  }

  dispose(): void {
    void this.shutdown().catch((error) =>
      logger.warn({ err: error }, 'DSH provider teardown failed')
    );
  }

  shutdown(): Promise<void> {
    if (this.shutdownFlight) {
      return this.shutdownFlight;
    }
    this.disposed = true;
    this.shutdownFlight = (async () => {
      try {
        const results = await Promise.allSettled(
          [...this.queries.values()].map((state) => state.stop())
        );
        await this.pool.shutdown();
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            'DSH cancellation was not confirmed'
          );
        }
      } finally {
        this.pool.close();
        this.overlay?.dispose();
        this.queries.clear();
        this.active.clear();
      }
    })();
    return this.shutdownFlight;
  }

  forgetSession(sessionKey: string): void {
    for (const state of this.queries.values()) {
      if (state.sessionKey === sessionKey) {
        void state
          .stop()
          .catch((error) => logger.warn({ err: error }, 'DSH reset cancellation failed'));
      }
    }
    this.bindings.forget(sessionKey);
  }

  private diagnose(): string {
    return this.configuredHome && !existsSync(this.home)
      ? `DSH_HOME does not exist: ${this.home}`
      : '';
  }

  private async onRequest(state: QueryState, request: DshRpcRequest): Promise<unknown> {
    if (request.method !== 'native_tool.call') {
      throw new Error('Unsupported DSH host request');
    }
    const params = request.params as
      | { sessionId?: unknown; name?: unknown; input?: unknown; invocationId?: unknown }
      | undefined;
    if (
      params?.sessionId !== state.sessionId ||
      this.active.get(state.sessionId) !== state ||
      !state.opened ||
      state.stopping
    ) {
      throw new Error('DSH host call has no active owning session');
    }
    if (
      typeof params.name !== 'string' ||
      typeof params.invocationId !== 'string' ||
      !params.invocationId ||
      !params.input ||
      typeof params.input !== 'object' ||
      Array.isArray(params.input)
    ) {
      throw new TypeError('Invalid DSH host call');
    }
    const tool = state.tools.get(params.name);
    if (!tool) {
      throw new Error('DSH host tool is not authorized');
    }
    if (state.receivedInvocations.has(params.invocationId)) {
      throw new Error('Duplicate DSH host invocation');
    }
    state.receivedInvocations.add(params.invocationId);
    const abort = new AbortController();
    const { invocationId } = params;
    const work = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return tool.execute(params.input as Record<string, unknown>, {
        signal: abort.signal,
        invocationId,
      });
    });
    state.invocations.set(invocationId, { abort, work });
    try {
      return await work;
    } finally {
      state.invocations.delete(invocationId);
    }
  }

  private onNotification(state: QueryState, notification: DshRpcNotification): void {
    const params = notification.params as
      | {
          sessionId?: unknown;
          event?: DeepSeekSessionEvent;
          invocationId?: unknown;
          status?: unknown;
        }
      | undefined;
    if (
      params?.sessionId !== state.sessionId ||
      this.active.get(state.sessionId) !== state ||
      state.finalized
    ) {
      return;
    }
    if (notification.method === 'native_tool.cancel') {
      if (typeof params.invocationId === 'string') {
        state.invocations.get(params.invocationId)?.abort.abort();
      }
      return;
    }
    if (notification.method === 'session.status') {
      state.idle = params.status === 'idle';
      state.wake();
      return;
    }
    if (notification.method !== 'session.event' || !params.event) {
      return;
    }
    if (params.event.type === 'assistant/chunk') {
      const chunk = params.event.data?.chunk as { type?: unknown; text?: unknown } | undefined;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        state.pendingText += chunk.text;
      }
      return;
    }
    if (params.event.type === 'assistant/message') {
      state.pendingText = '';
    }
    if (params.event.type === 'turn/end' && state.pendingText) {
      state.events.push({ type: 'text', content: state.pendingText, role: 'assistant' });
      state.pendingText = '';
    }
    state.events.push(...adaptDeepSeekEvent(params.event));
    state.wake();
  }
}
