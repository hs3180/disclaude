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
import { loadPiRuntime, toPiUserMessage, type PiAgentOptions } from './pi-runtime.js';
import { createPiToolPermissionGate } from './tool-permission-gate.js';

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
        // Issue #4568 (direction 2): track the open-tool-call window so the
        // watchdog can exempt it (see fireStallWatchdog). tool_execution_update
        // deliberately does NOT count as closing — it is progress emitted
        // mid-execution; the tool is still running afterwards.
        if (event.type === 'tool_execution_start') {
          openToolCalls++;
        } else if (event.type === 'tool_execution_end') {
          openToolCalls = Math.max(0, openToolCalls - 1);
        }
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
      // silent run fires), disarmed when the run settles. EXCEPTION (#4568
      // direction 2): while a tool call is open (start seen, end pending) the
      // silence is attributed to the tool, not the stream — the watchdog
      // re-arms instead of firing (see openToolCalls below). Firing aborts the
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
      // Issue #4568 (direction 2): count of tool calls whose tool_execution_start
      // has been enqueued without a matching tool_execution_end. Maintained in
      // enqueue() so it advances in lockstep with the watchdog's own event view.
      // The stall watchdog counts the WHOLE run as its timing window (unlike
      // #3706's message_start→message_stop request window, which structurally
      // excludes tool execution); without an exemption a silently-running tool
      // (long build/test, big file processing — no onUpdate wired yet, cf.
      // direction 1 / PR #4569) exhausts STALL_TIMEOUT_MS and is misjudged as
      // a stall. While openToolCalls > 0 the watchdog re-arms instead of
      // firing. Tool deadlocks stay detectable in principle through the tool's
      // own abort signal (wired in inline-tool-adapter) — the same residual
      // #3706 accepts for its request-level exemption.
      let openToolCalls = 0;
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
        // Issue #4568 (direction 2): a tool is mid-execution (start seen, end
        // not) — the silence is the tool itself, not the agent stream. Re-arm
        // for another window instead of firing; when tool_execution_end (or
        // any other event) lands, enqueue's touch re-arms as usual.
        if (openToolCalls > 0) {
          stallWatchdog = armStallTimer(fireStallWatchdog, STALL_TIMEOUT_MS);
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
      // Issue #4389 (S6, part 1): disclaude is the sole permission authority
      // on the pi path (pi has no built-in perms). The gate rides pi's native
      // pre-tool-call deny hook — invoked in-loop after argument validation,
      // before EVERY tool execution — so no tool (inline is the only path
      // since MCP was dropped) reaches its handler ungated. `null` when
      // `disallowedTools` is absent/empty → hook omitted, behavior unchanged.
      const toolPermissionGate = createPiToolPermissionGate(options);
      agent = new Agent({
        streamFn: streamFn as PiAgentOptions['streamFn'],
        initialState: {
          systemPrompt: adaptedOptions.systemPrompt ?? '',
          tools: collectInlineTools(options),
        },
        ...(toolPermissionGate
          ? { beforeToolCall: toolPermissionGate satisfies PiAgentOptions['beforeToolCall'] }
          : {}),
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
          // Issue #4386 (part 5, review): the watchdog fired and the run has
          // settled — abort() WORKED (real pi 0.82.1 semantics: abort() trips
          // the run's AbortController, runLoop exits with stopReason
          // 'aborted', prompt() resolves, runInput's finally clears the
          // force-close timer). Without this break the loop parks forever:
          // `aborted` is still false (only the force-close path flips it) and
          // ChatAgent keeps the input channel open (inputDone false) — the
          // stall result below would never be synthesized.
          if (stalled && (aborted || !runActive)) {
            break;
          }
          if (queue.length === 0) {
            if (aborted || (inputDone && !runActive)) {
              break;
            }
            await new Promise<void>((resolve) => notify.push(resolve));
            continue;
          }
          const event = queue.shift() as PiAgentEvent;
          // Issue #4386 (part 5, review): once the watchdog has fired, events
          // emitted by the aborting run (real pi synthesizes message_start /
          // message_end / turn_end / agent_end for an aborted run) must not
          // reach the consumer — ChatAgent would treat the empty agent_end
          // `result` as a normal turn completion (recordSuccess / ✅ Complete /
          // empty-turn retry) ahead of the stall terminator. Drop everything
          // after the stall; the synthesized result below is the sole
          // terminator.
          if (stalled) {
            continue;
          }
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
    // see inline-tool-adapter.ts. Permission enforcement is NOT here:
    // #4389 lives in queryStream's beforeToolCall hook (per-query Agent
    // instance), which gates every tool call the loop makes — inline tools
    // included — without per-provider mutable state.
    return adaptInlineTool(definition);
  }

  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'inline') {
      // Issue #4417 (S4, part 1): build an inline MCP server handle from
      // disclaude tool definitions, mirroring ClaudeSDKProvider (claude/
      // provider.ts). Each tool is wrapped via createInlineTool, which produces
      // a pi AgentHarnessTool shape (inline-tool-adapter.ts). The returned
      // handle carries the AgentHarnessTool[] that the pi queryStream path
      // (#4386 part 4) seeds into the Agent via initialState.tools —
      // collectInlineTools duck-types this handle shape (see below).
      //
      // Part-1 scope: inline handle construction + stdio decision. Deferred to
      // later parts of #4417: external stdio MCP servers (e.g. Playwright MCP),
      // which need the @modelcontextprotocol/sdk client → AgentHarnessTool
      // converter (S4b).
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

/**
 * Extract the session's live tool registry from `AgentQueryOptions.mcpServers`
 * (Issue #4386 part 4 — the inline-tool round-trip acceptance item).
 *
 * Per the 2026-08-07 decision (pi backend does NOT support MCP, #4461), the
 * inline `channel-mcp` server is the pi backend's ONLY tool source: each of
 * its `InlineToolDefinition`s is adapted into a pi `AgentHarnessTool` via
 * `createInlineTool` (#4387 — Zod→JSON-Schema parameters + execute wrapper)
 * and seeded into the Agent's `initialState.tools`, where it is live for
 * every run of the session (pi 0.82.1: `createMutableAgentState` copies
 * `initialState.tools` into the state registry at construction).
 *
 * TWO server shapes reach `mcpServers` on this path (matching what
 * ClaudeSDKProvider's `adaptMcpServers` handles):
 *
 * 1. **config shape** — `{ type: 'inline', tools: InlineToolDefinition[] }`
 *    (types.ts `InlineMcpServerConfig`): raw Zod definitions; each tool is
 *    adapted here via `adaptInlineTool`.
 * 2. **handle shape** — the object `PiAgentProvider.createMcpServer` returns
 *    (`{ name, version, tools }` with NO `type` field, tools ALREADY adapted
 *    to AgentHarnessTool shapes). This is the PRODUCTION shape: chat-agent's
 *    `buildMcpServers()` populates `mcpServers['channel-mcp']` with
 *    `createChannelMcpServer()` = `getProvider().createMcpServer(...)`, which
 *    flows into `AgentQueryOptions.mcpServers` verbatim (base-agent.ts:202).
 *    Duck-typed on `Array.isArray(tools) && tools.every(t => typeof t?.execute
 *    === 'function')` (cf. Claude's `isSdkInlineMcpServer`) and passed through
 *    WITHOUT re-adapting — re-adapting an AgentHarnessTool would wrap an
 *    already-wrapped execute and Zod-parse a JSON-Schema object.
 *
 * stdio servers are skipped here: pi rejects them at `createMcpServer`, and
 * a stdio entry in `mcpServers` on the pi backend is a config error surfaced
 * there (throwing in the iterator would instead surface as a hung/dead
 * stream — worse). The return is always an array (possibly empty) so
 * `initialState.tools` stays a stable shape.
 */
function collectInlineTools(options: AgentQueryOptions): unknown[] {
  const tools: unknown[] = [];
  for (const server of Object.values(options.mcpServers ?? {})) {
    if (server.type === 'inline') {
      // Config shape: adapt each raw InlineToolDefinition for pi.
      for (const tool of server.tools ?? []) {
        tools.push(adaptInlineTool(tool));
      }
    } else if (isAdaptedToolHandle((server as unknown as { tools?: unknown }).tools)) {
      // Handle shape from createMcpServer (the production path) — no `type`
      // field, tools ALREADY AgentHarnessTools; pass them through as-is.
      // (The production mcpServers record is cast into McpServerConfig by
      // base-agent.ts:202 without a real conversion, hence the unknown hop.)
      tools.push(...((server as unknown as { tools: Array<{ execute: unknown }> }).tools));
    }
  }
  return tools;
}

/**
 * Duck-type a `createMcpServer` inline handle's tool list: every entry must
 * already be an adapted `AgentHarnessTool` (has an `execute` function).
 * Mirrors ClaudeSDKProvider's `isSdkInlineMcpServer` approach — the handle
 * carries no `type` field, so shape detection is the only signal.
 */
function isAdaptedToolHandle(tools: unknown): tools is Array<{ execute: unknown }> {
  return (
    Array.isArray(tools) &&
    tools.every((tool) => typeof (tool as { execute?: unknown })?.execute === 'function')
  );
}
