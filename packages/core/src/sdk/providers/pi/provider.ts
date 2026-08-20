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
import { createLogger } from '../../../utils/logger.js';
import { adaptPiEvent, type PiAgentEvent } from './event-adapter.js';
import { adaptInlineTool } from './inline-tool-adapter.js';
import { adaptPiOptions } from './options-adapter.js';
import {
  ALLOW_ALL_GATE,
  createDenylistGate,
  type PiPermissionGate,
} from './permission-gate.js';
import { loadPiRuntime, toPiUserMessage, type PiAgentOptions } from './pi-runtime.js';

const logger = createLogger('PiAgentProvider');

// Issue #4386 (part 5): terminal notice synthesized when the no-content-progress
// watchdog fires — same shape/wording as the Claude provider's #3706 notice so
// the two backends read identically in chat and in logs.
const STALL_TERMINATE_NOTICE =
  '⚠️ 上游模型响应超时（疑似 stall），已自动取消本次响应。请稍后重试。';

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

  /**
   * Permission gate consulted by every inline tool this provider adapts
   * (#4389, S6 part 1). pi has no built-in permission system, so disclaude
   * must be the sole permission authority on the pi path — `createInlineTool`
   * wraps every tool's `execute` through this gate. Defaults to allow-all
   * (pre-#4389 behavior); `queryStream` installs a denylist gate per query
   * from `options.disallowedTools` so each session's tools are enforced. A
   * future policy paradigm (the C1/C2/C3 selection of #4432) replaces the
   * installed gate here — the enforcement seam stays stable.
   *
   * `createInlineTool` consults this field INDIRECTLY (it forwards to
   * `this.permissionGate` at execute time, not the value present at adapt
   * time) — tools adapted before a queryStream (channelSdkTools at module
   * load, buildMcpServers() during processMessage) must pick up the gate the
   * query installs, not the allow-all default they were adapted under.
   *
   * ⚠️ Single-active-query assumption: the provider is a process-wide cached
   * instance (factory.ts providerCache), so a queryStream call REPLACES the
   * previous gate — two interleaved queries on the same provider would
   * overwrite each other's denylist. The ClaudeSDKProvider contract is one
   * long-lived query per chat, but nothing here enforces that; per-query
   * gate scoping is deferred to the p1 beforeToolCall-hook layer (#4542),
   * which installs the gate on the per-query Agent constructor instead.
   */
  permissionGate: PiPermissionGate = ALLOW_ALL_GATE;

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

    // #4389: enforce this query's disallowedTools at execution time. The
    // options-adapter's activeToolNames filters which tools the model is
    // OFFERED; this gate is the defense-in-depth layer at `execute` — a tool
    // that reaches execution anyway (e.g. adapted before this query via
    // createInlineTool) is denied here, before its handler runs (the
    // indirection in createInlineTool guarantees the fresh gate is seen).
    this.permissionGate = options.disallowedTools?.length
      ? createDenylistGate(options.disallowedTools)
      : ALLOW_ALL_GATE;

    // Abort plumbing: pi's Agent.abort() cancels the active run; the handle's
    // cancel() maps onto it (spike §4 — AbortController pass-through applies
    // to the bare agentLoop API; the Agent class owns its own controller).
    // The bridge constructs the Agent only after `await loadPiRuntime()`
    // resolves, so cancel()/close() can fire BEFORE the agent exists (the
    // handle is returned synchronously). `cancelRequested` latches that early
    // call; the iterator applies it as soon as the agent is constructed, and
    // skips starting the run entirely — an early cancel is never dropped.
    let agent: import('./pi-runtime.js').PiAgent | null = null;
    let cancelRequested = false;
    // Armed by the iterator once its wake machinery exists, so a cancel()
    // landing mid-stream both aborts the run and unblocks the consumer loop.
    let onAbort: (() => void) | null = null;
    const requestAbort = (): void => {
      if (agent) {
        agent.abort();
      } else {
        cancelRequested = true;
      }
      onAbort?.();
    };

    const { streamFn } = this;
    const adaptIterator = async function* (this: void): AsyncGenerator<AgentMessage> {
      const { Agent } = await loadPiRuntime();

      // Event bridge: pi AgentEvent → disclaude AgentMessage. The listener is
      // async (pi awaits listeners as part of run settlement) but the queue
      // push happens synchronously so no event can be dropped between the
      // await-points of the consumer's for-await.
      const queue: PiAgentEvent[] = [];
      const notify: (() => void)[] = [];
      // Bridge lifecycle: the stream ends only when the input generator is
      // exhausted AND no run is in flight, or when cancel()/close() aborts.
      // A settled run alone does NOT end the stream — the session stays
      // alive between turns (the ClaudeSDKProvider contract: one long-lived
      // query per chat; chat-agent keeps its MessageChannel open across
      // turns and closes it to end the query).
      let inputDone = false;
      let runActive = false;
      let aborted = false;
      const wakeAll = (): void => {
        for (const wake of notify.splice(0)) {
          wake();
        }
      };
      const enqueue = (event: PiAgentEvent): void => {
        queue.push(event);
        // Issue #4386 (part 5): any enqueued event is progress — advance the
        // stall deadline (a no-op re-arm when the run is not active).
        touchStallWatchdog();
        wakeAll();
      };
      onAbort = (): void => {
        aborted = true;
        wakeAll();
      };

      // ── Issue #4386 (part 5): no-content-progress stall watchdog ──
      // The pi bridge gets the same protection the Claude provider has
      // (#3706): a run that stops producing events while still active is a
      // stall (pi keeps the run pending on a hung upstream streamFn — the
      // symmetric case of GLM's zero-content_block_delta SSE stall). The
      // watchdog is armed when a run starts and re-armed on EVERY enqueued
      // event (any progress — text, thinking, tool — counts; only a fully
      // silent run fires), disarmed when the run settles. Firing aborts the
      // agent, wakes the consumer, and synthesizes a terminal result with
      // terminatedReason 'stall' so ChatAgent recordFailure('stall')s like
      // it does for Claude. Timeout is env-tunable per-call
      // (DISCLAUDE_STALL_TIMEOUT_MS) — the same knob #3706 uses — so tests
      // drive it deterministically. Between-turn idle (runActive === false,
      // the input generator parked) is excluded: the watchdog only covers
      // in-flight runs, mirroring #3706's message_start→message_stop arming.
      const STALL_TIMEOUT_MS = (() => {
        const env = Number.parseInt(process.env.DISCLAUDE_STALL_TIMEOUT_MS ?? '', 10);
        return Number.isFinite(env) && env > 0 ? env : 180_000;
      })();
      // Grace after abort() before force-closing the consumer loop, in case
      // abort() alone cannot settle a run parked on a never-resolving
      // streamFn promise (#3706 review — same rationale as force-close there).
      const STALL_FORCE_CLOSE_GRACE_MS = (() => {
        const env = Number.parseInt(process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS ?? '', 10);
        return Number.isFinite(env) && env > 0 ? env : 5_000;
      })();
      let stalled = false;
      let stallWatchdog: ReturnType<typeof setTimeout> | null = null;
      let stallForceCloseTimer: ReturnType<typeof setTimeout> | null = null;
      const armStallTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
        const t = setTimeout(fn, ms);
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      };
      const clearStallWatchdog = (): void => {
        if (stallWatchdog) {
          clearTimeout(stallWatchdog);
          stallWatchdog = null;
        }
      };
      const clearStallTimers = (): void => {
        clearStallWatchdog();
        if (stallForceCloseTimer) {
          clearTimeout(stallForceCloseTimer);
          stallForceCloseTimer = null;
        }
      };
      // Abort through the closure-level `agent` so the watchdog also works
      // in the (impossible-today but structural) window where `piAgent` is
      // not yet assigned to it.
      const piAgentSafeAbort = (): void => {
        agent?.abort();
      };
      const fireStallWatchdog = (): void => {
        stallWatchdog = null;
        if (!runActive || stalled) {
          return;
        }
        stalled = true;
        logger.error(
          { stallTimeoutMs: STALL_TIMEOUT_MS },
          `pi stall: no agent events for ${STALL_TIMEOUT_MS}ms during an active run; ` +
            'aborting the agent (Issue #4386, cf. #3706)',
        );
        // Same escalation order as #3706: abort first; if the run still does
        // not settle (a hung streamFn promise never resolves, so runInput's
        // finally never runs), the bridge's own session-lifetime wait would
        // park forever — force the consumer loop closed after a grace by
        // flipping the abort flag directly.
        piAgentSafeAbort();
        stallForceCloseTimer = armStallTimer(() => {
          stallForceCloseTimer = null;
          onAbort?.();
        }, STALL_FORCE_CLOSE_GRACE_MS);
      };
      const touchStallWatchdog = (): void => {
        if (!runActive || stalled) {
          return;
        }
        clearStallWatchdog();
        stallWatchdog = armStallTimer(fireStallWatchdog, STALL_TIMEOUT_MS);
      };

      const inputIterator = input[Symbol.asyncIterator]();

      const adaptedOptions = adaptPiOptions(options);
      agent = new Agent({
        streamFn: streamFn as PiAgentOptions['streamFn'],
        initialState: {
          systemPrompt: adaptedOptions.systemPrompt ?? '',
        },
      } satisfies PiAgentOptions);
      const piAgent = agent;
      if (cancelRequested) {
        // cancel()/close() arrived while loadPiRuntime() was still pending.
        // Abort immediately and end the bridge without starting a run. No
        // subscribe/pumpInput was set up, so the early-return path has
        // nothing to clean up (the finally block below belongs to the main
        // try that starts after this guard).
        piAgent.abort();
        return;
      }

      const unsubscribe = piAgent.subscribe((event) => {
        enqueue(event as PiAgentEvent);
      });

      // Turn runner. The first input seeds the transcript via prompt();
      // later inputs go through pi's follow-up queue. followUp() only
      // ENQUEUES — the queue is drained at a run's stop checkpoint, so a
      // follow-up arriving after the previous run settled would strand in
      // the queue forever. waitForIdle() + continue() drains it into a new
      // run (continue() throws when the active run already consumed the
      // message at its checkpoint, or when there is nothing to continue
      // from — expected, swallowed below).
      const runInput = async (message: unknown, first: boolean): Promise<void> => {
        runActive = true;
        // Issue #4386 (part 5): arm the stall watchdog for the run's whole
        // lifetime (prompt/continue settle = disarm in the finally below).
        touchStallWatchdog();
        try {
          if (first) {
            await piAgent.prompt(message);
          } else {
            void piAgent.followUp(message);
            await piAgent.waitForIdle();
            await piAgent.continue();
          }
        } catch {
          // Run failures surface through the event stream (error / aborted
          // stopReason → error message); the bridge, not this pump, owns
          // stream termination.
        } finally {
          runActive = false;
          clearStallTimers();
          wakeAll();
        }
      };

      // Input pump: pulls user inputs as they arrive; each becomes a run.
      // Between turns it parks in inputIterator.next() — NOT in aborting the
      // agent: an idle agent stays alive for the next turn. The input
      // generator is the session's lifetime; it ending (chat-agent closes
      // its MessageChannel on /reset, retry, and once-mode completion) is
      // what winds the bridge down.
      let terminated = false;
      void (async () => {
        let first = true;
        try {
          while (true) {
            const { value, done } = await inputIterator.next();
            if (done || terminated) {
              return;
            }
            await runInput(toPiUserMessage(userInputText(value)), first);
            first = false;
          }
        } finally {
          inputDone = true;
          wakeAll();
        }
      })().catch(() => {
        // The input generator may reject (producer error). The session ends
        // the same way (inputDone); swallow so this detached pump never
        // surfaces an unhandled rejection — teardown no longer awaits it.
      });

      try {
        while (true) {
          if (queue.length === 0) {
            if (aborted || (inputDone && !runActive)) {
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
        // Issue #4386 (part 5): watchdog fired during the session → the
        // stream would otherwise end without a terminator. Synthesize the
        // same terminal result the Claude provider's #3706 stall path yields
        // (terminatedReason 'stall'), so ChatAgent's result branch surfaces
        // ⚠️ to the user and recordFailure('stall') runs — instead of the
        // turn completing as if nothing happened.
        if (stalled) {
          yield {
            type: 'result',
            content: STALL_TERMINATE_NOTICE,
            role: 'system',
            metadata: { terminatedReason: 'stall' },
          };
          return;
        }
      } finally {
        // Teardown — the session is over (input exhausted, the consumer
        // broke out of its for-await, or cancel()/close() aborted). Unlike
        // the between-turns park, aborting here is correct: it kills any
        // in-flight run and releases the agent. pumpInput is deliberately
        // NOT awaited: with the input generator still open (chat-agent keeps
        // its MessageChannel open for the whole session) it parks inside
        // inputIterator.next() indefinitely — awaiting it here would hang
        // the consumer's own break (its for-await awaits this generator's
        // return(), Bug A). `terminated` makes any input that arrives later
        // a no-op, so no zombie run starts on the aborted agent.
        terminated = true;
        unsubscribe();
        clearStallTimers();
        piAgent.abort();
      }
    };

    return {
      handle: {
        close: () => {
          requestAbort();
        },
        cancel: () => {
          requestAbort();
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
    // Issue #4389 (S6): every adapted tool consults the provider's
    // permissionGate before its handler runs. The gate is forwarded
    // INDIRECTLY (resolved at execute time, not captured at adapt time):
    // tools are routinely adapted BEFORE queryStream installs the query's
    // denylist (channelSdkTools at module load; buildMcpServers() during
    // processMessage), and capturing the then-current value would freeze
    // them on ALLOW_ALL_GATE forever.
    return adaptInlineTool(definition, {
      decide: (request) => this.permissionGate.decide(request),
    });
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
