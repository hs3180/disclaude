/**
 * DeepSeek harness provider contract (Issue #4741).
 *
 * Drives the official dsh SDK profile over newline-delimited JSON-RPC.
 */
import { existsSync } from 'node:fs';
import { createLogger } from '../../../utils/logger.js';
import type { IAgentSDKProvider } from '../../interface.js';
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
import type { DshRpcNotification, DshTransportOptions } from './dsh-transport.js';
import { adaptDeepSeekEvent, type DeepSeekSessionEvent } from './event-adapter.js';

const logger = createLogger('DeepSeekHarnessProvider');

export interface DeepSeekHarnessProviderOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  dshHome?: string;
  binary?: string;
  args?: string[];
  requestTimeoutMs?: number;
}

export class DeepSeekHarnessProvider implements IAgentSDKProvider {
  readonly name = 'deepseek';
  readonly version = '0.0.0-harness-preview';
  private readonly env: Record<string, string | undefined>;
  private readonly apiKey?: string;
  private readonly dshHome?: string;
  private disposed = false;
  private readonly queues = new Map<
    string,
    {
      events: AgentMessage[];
      wake: () => void;
      abort: AbortController;
      sawAssistantDelta: boolean;
    }
  >();
  private readonly pool: DshSessionPool;

  constructor(options: DeepSeekHarnessProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.apiKey = options.apiKey ?? this.env.DEEPSEEK_API_KEY;
    this.dshHome = options.dshHome ?? this.env.DSH_HOME;
    const transportOptions: DshTransportOptions = {
      binary: options.binary,
      args: options.args,
      requestTimeoutMs: options.requestTimeoutMs,
      env: { ...process.env, ...this.env, DEEPSEEK_API_KEY: this.apiKey, DSH_HOME: this.dshHome },
      onNotification: (notification) => this.onNotification(notification),
      onProtocolError: (error, line) =>
        logger.warn({ err: error, line }, 'Invalid dsh protocol frame'),
    };
    this.pool = new DshSessionPool(transportOptions);
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
    if (options.mcpServers || options.allowedTools || options.disallowedTools || options.tools) {
      throw new Error(
        'DeepSeek Harness SDK protocol 0.1.2 does not support client tool registration or tool allow/deny filters; configure tools in the dsh sdk profile'
      );
    }
    const sessionId = options.sessionKey ?? `disclaude-${crypto.randomUUID()}`;
    const transport = this.pool.getOrCreate(sessionId);
    const abort = new AbortController();
    let wake: () => void = () => {};
    const state = {
      events: [] as AgentMessage[],
      wake: () => wake(),
      abort,
      sawAssistantDelta: false,
    };
    this.queues.set(sessionId, state);
    let inputDone = false;
    let accepted = 0;
    let terminal = 0;
    let failure: Error | undefined;
    const { signal } = abort;

    const pump = (async () => {
      try {
        await transport.request(
          'initialize',
          {
            cwd: options.cwd ?? process.cwd(),
            provider: 'deepseek-official',
            model: options.model ?? 'deepseek-official',
          },
          signal
        );
        for await (const message of input) {
          const contentBlocks =
            typeof message.content === 'string'
              ? [{ type: 'text', text: message.content }]
              : message.content.map((block) =>
                  block.type === 'text'
                    ? { type: 'text', text: block.text }
                    : { type: 'image', data: block.data, mimeType: block.mimeType }
                );
          await transport.request('session/prompt', { sessionId, contentBlocks }, signal);
          accepted++;
        }
      } catch (error) {
        if (!signal.aborted) {
          const detail = error instanceof Error ? error.message : String(error);
          failure = new Error(`dsh SDK process failed during initialize/prompt: ${detail}`);
        }
      } finally {
        inputDone = true;
        state.wake();
      }
    })();

    const provider = this;
    const iterator = (async function* (): AsyncGenerator<AgentMessage> {
      try {
        for (;;) {
          while (state.events.length) {
            const event = state.events.shift();
            if (!event) {continue;}
            if (event.type === 'result' || event.type === 'error') {
              terminal++;
            }
            yield event;
          }
          if (failure) {
            throw failure;
          }
          if (signal.aborted || (inputDone && terminal >= accepted)) {
            break;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (!signal.aborted) {
          await pump;
        }
      } finally {
        provider.queues.delete(sessionId);
        if (!signal.aborted) {
          await transport.shutdown().catch((error: unknown) => {
            logger.warn({ err: error, sessionId }, 'dsh graceful shutdown failed');
          });
        }
        provider.pool.release(sessionId);
      }
    })();
    const close = (): void => {
      if (!signal.aborted) {
        abort.abort();
      }
      void input.return(undefined);
      state.wake();
      this.pool.release(sessionId);
    };
    return { handle: { close, cancel: close, sessionId }, iterator };
  }

  createInlineTool(_definition: InlineToolDefinition): unknown {
    throw new Error(
      'DeepSeek Harness SDK protocol 0.1.2 has no inline-tool registration method; configure tools in the dsh sdk profile'
    );
  }

  createMcpServer(_config: McpServerConfig): unknown {
    throw new Error('DeepSeekHarnessProvider: MCP mapping is not supported by the preview.');
  }

  validateConfig(): boolean {
    // dsh can read the key from its credentials service; an environment key is
    // optional and is forwarded when supplied.
    return !this.disposed && this.hasDshHome();
  }

  dispose(): void {
    this.disposed = true;
    this.pool.close();
    for (const state of this.queues.values()) {
      state.abort.abort();
      state.wake();
    }
    this.queues.clear();
  }

  forgetSession(sessionKey: string): void {
    this.pool.release(sessionKey);
  }

  private hasDshHome(): boolean {
    return !this.dshHome || existsSync(this.dshHome);
  }

  private diagnose(): string {
    if (this.dshHome && !existsSync(this.dshHome)) {
      return `DSH_HOME does not exist: ${this.dshHome}`;
    }
    return '';
  }

  private onNotification(notification: DshRpcNotification): void {
    if (notification.method !== 'session.event') {
      return;
    }
    const params = notification.params as
      | { sessionId?: unknown; event?: DeepSeekSessionEvent }
      | undefined;
    if (typeof params?.sessionId !== 'string' || !params.event) {
      return;
    }
    const state = this.queues.get(params.sessionId);
    if (!state) {
      return;
    }
    if (params.event.type === 'assistant/chunk') {
      const chunk = params.event.data?.chunk as { type?: unknown } | undefined;
      if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
        state.sawAssistantDelta = true;
      }
    }
    if (params.event.type === 'assistant/message' && state.sawAssistantDelta) {
      return;
    }
    state.events.push(...adaptDeepSeekEvent(params.event));
    if (params.event.type === 'turn/end') {
      state.sawAssistantDelta = false;
    }
    state.wake();
  }
}
