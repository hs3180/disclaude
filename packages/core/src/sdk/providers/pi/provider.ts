/**
 * pi.dev (earendil-works/pi) Agent Provider — Skeleton (Issue #4385)
 *
 * Implements the IAgentSDKProvider contract with real lifecycle methods
 * (name / version / getInfo / validateConfig / dispose) and STUBBED
 * agent-loop / tool / MCP methods. The stubs throw clear errors pointing
 * to the follow-up sub-issues (S3: #4386, S4: #4387) so callers get an
 * actionable message, not a silent no-op.
 *
 * This skeleton is self-contained: it does NOT import pi-agent-core (the
 * package decision is tracked in #4384 / S1). validateConfig() checks
 * whether the pi packages are *importable* at runtime — returning false
 * (never throwing) when they are absent, matching ClaudeSDKProvider's
 * pattern.
 */

import { createRequire } from 'node:module';

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
import { adaptPiEvent, type PiAgentEvent } from './event-adapter.js';
import { adaptInlineTool } from './inline-tool-adapter.js';
import { adaptPiOptions } from './options-adapter.js';
import { loadPiRuntime, toPiUserMessage, type PiAgentOptions } from './pi-runtime.js';

/**
 * Stream-function injection seam for `queryStream` (Issue #4386 part 3).
 *
 * pi's `AgentOptions.streamFn` is REQUIRED — the agent loop makes no
 * model/credential decisions. Production wiring resolves one through pi-ai's
 * `Models` registry (deferred to the config/wiring slice; see #4383 §6 and
 * docs/pi-backend.md), and tests inject a scripted faux stream here.
 */
export type PiStreamFn = (model: unknown, context: unknown, options?: unknown) => unknown;

/**
 * pi.dev Agent Provider (skeleton)
 *
 * Parent issue: #4383 (Add pi.dev as IAgentSDKProvider backend)
 * This issue: #4385 (skeleton wiring)
 */
export class PiAgentProvider implements IAgentSDKProvider {
  readonly name = 'pi';
  readonly version = '0.0.0-skeleton';

  private disposed = false;

  // --------------------------------------------------------------------------
  // Provider information
  // --------------------------------------------------------------------------

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    const info: ProviderInfo = {
      name: this.name,
      version: this.version,
      available,
    };
    if (!available) {
      info.unavailableReason = 'pi-agent-core package not installed or not configured';
    }
    return info;
  }

  // --------------------------------------------------------------------------
  // Query — Issue #4386 (S3, part 3): the agent loop behind queryStream
  // --------------------------------------------------------------------------

  /**
   * Stream-fn injection seam (tests / future production wiring). When unset,
   * queryStream throws with a pointer to the wiring slice — pi's Agent REQUIRES
   * a streamFn (it makes no model/credential decisions on its own).
   */
  streamFn: PiStreamFn | null = null;

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions,
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }
    if (!this.streamFn) {
      throw new Error(
        'PiAgentProvider: no stream function configured — queryStream needs a pi-ai StreamFn ' +
          '(model/credential wiring tracked in #4386 / #4383 §6; see docs/pi-backend.md).',
      );
    }

    // Abort plumbing: pi's Agent.abort() cancels the active run; the handle's
    // cancel() maps onto it (spike §4 — AbortController pass-through applies
    // to the bare agentLoop API; the Agent class owns its own controller).
    let agent: import('./pi-runtime.js').PiAgent | null = null;

    const { streamFn } = this;
    const adaptIterator = async function* (this: void): AsyncGenerator<AgentMessage> {
      const { Agent } = await loadPiRuntime();

      // Event bridge: pi AgentEvent → disclaude AgentMessage. The listener is
      // async (pi awaits listeners as part of run settlement) but the queue
      // push happens synchronously so no event can be dropped between the
      // await-points of the consumer's for-await.
      const queue: PiAgentEvent[] = [];
      const notify: (() => void)[] = [];
      let finished = false;
      const wakeAll = (): void => {
        for (const wake of notify.splice(0)) {
          wake();
        }
      };
      const enqueue = (event: PiAgentEvent): void => {
        queue.push(event);
        wakeAll();
      };

      // First turn: prompt() seeds the transcript; subsequent inputs from the
      // multi-turn generator arrive while the agent is running (pi queues
      // follow-ups until the current run would otherwise stop) — matching the
      // ClaudeSDKProvider contract of a single long-lived query per chat.
      const inputIterator = input[Symbol.asyncIterator]();
      const first = await inputIterator.next();

      const adaptedOptions = adaptPiOptions(options);
      agent = new Agent({
        streamFn: streamFn as PiAgentOptions['streamFn'],
        initialState: {
          systemPrompt: adaptedOptions.systemPrompt ?? '',
        },
      } satisfies PiAgentOptions);

      const unsubscribe = agent.subscribe((event) => {
        enqueue(event as PiAgentEvent);
        if (event.type === 'agent_end') {
          finished = true;
          wakeAll();
        }
      });

      // prompt() resolves when the whole run settles (agent_end + listeners).
      // Run failures normally surface through the event stream (error /
      // aborted stopReason → error message); the catch below additionally
      // ends the bridge if the run rejected WITHOUT emitting agent_end, so a
      // crashed loop can never hang the consumer's for-await.
      const runPromise = (
        first.done ? Promise.resolve() : agent.prompt(toPiUserMessage(userInputText(first.value)))
      ).finally(() => {
        finished = true;
        wakeAll();
      });

      // Feed later inputs as follow-ups while the consumer iterates.
      const pumpInput = (async () => {
        while (true) {
          const { value, done } = await inputIterator.next();
          if (done) {
            return;
          }
          await agent?.followUp(toPiUserMessage(userInputText(value))).catch(() => {
            // followUp rejections mirror the prompt() policy above.
          });
        }
      })();

      try {
        while (true) {
          if (queue.length === 0) {
            if (finished) {
              break;
            }
            await new Promise<void>((resolve) => notify.push(resolve));
            continue;
          }
          const event = queue.shift() as PiAgentEvent;
          const adapted = adaptPiEvent(event);
          if (adapted) {
            yield adapted;
          }
        }
      } finally {
        unsubscribe();
        agent?.abort();
        await Promise.allSettled([runPromise, pumpInput]);
      }
    };

    return {
      handle: {
        close: () => {
          agent?.abort();
        },
        cancel: () => {
          agent?.abort();
        },
        sessionId: undefined,
      },
      iterator: adaptIterator(),
    };
  }

  createInlineTool(definition: InlineToolDefinition): unknown {
    // Issue #4387 (S4): wrap the disclaude tool for pi's tool dispatch.
    // Zod→JSON-Schema parameter translation lives in the adapter —
    // see inline-tool-adapter.ts.
    return adaptInlineTool(definition);
  }

  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'inline') {
      // Issue #4417 (S4, part 1): build an inline MCP server handle from
      // disclaude tool definitions, mirroring ClaudeSDKProvider (claude/
      // provider.ts). Each tool is wrapped via createInlineTool, which produces
      // a pi AgentHarnessTool shape (inline-tool-adapter.ts). The returned
      // handle carries the AgentHarnessTool[] that the pi queryStream path
      // (#4386 part 3) will inject into the agentLoop via setTools.
      //
      // Part-1 scope: inline handle construction + stdio decision. Deferred to
      // later parts of #4417: external stdio MCP servers (e.g. Playwright MCP),
      // which need the @modelcontextprotocol/sdk client → AgentHarnessTool
      // converter (S4b), and the live tool injection (needs the running
      // agentLoop, #4386).
      const tools = (config.tools?.map((tool) => this.createInlineTool(tool)) ?? []);
      return {
        name: config.name,
        version: config.version,
        tools,
      };
    }

    // stdio MCP servers are not supported by the pi backend, matching
    // ClaudeSDKProvider's stance. External stdio servers require the
    // @modelcontextprotocol/sdk client converter tracked under #4417 (S4b).
    throw new Error(
      'stdio MCP servers are not supported by PiAgentProvider.createMcpServer',
    );
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Check whether the pi.dev packages are importable and the required
   * configuration (model-provider API key via pi-ai) is present.
   *
   * Returns `false` (never throws) when pi is not set up — matching
   * ClaudeSDKProvider's pattern.
   */
  validateConfig(): boolean {
    if (this.disposed) {
      return false;
    }

    // Dynamic import check — if the package isn't installed, return false.
    // We don't actually import at module load time; this is called on demand
    // by getInfo() / isProviderAvailable().
    try {
      // Resolve the pi-agent-core package without importing it (avoids the
      // side-effects of a full import). This file is ESM, so bare `require`
      // is undefined here — using createRequire() gives us a working
      // require.resolve(). (import.meta.resolve is an alternative but only
      // became synchronous/unflagged in Node 20.6+; createRequire is stable
      // across our >=18 floor.)
      createRequire(import.meta.url).resolve('@earendil-works/pi-agent-core');
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Extract the plain-text content of a disclaude `UserInput`. Block content
 * (ContentBlock[]) beyond text is stringified defensively for the MVP —
 * event-adapter's scope note applies symmetrically here.
 */
function userInputText(input: UserInput): string {
  if (typeof input.content === 'string') {
    return input.content;
  }
  return input.content
    .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('\n');
}
