/**
 * PrimaryAgentPool - Agent pool for Primary Node.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/primary-node to create ChatAgent instances.
 *
 * Issue #1499: Accepts optional MessageBuilderOptions for channel-specific
 * message building (e.g., Feishu sections). This decouples Feishu-specific
 * logic from the core agent runtime.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import { type MessageBuilderOptions, type CwdProvider, type CwdResolution, createLogger } from '@disclaude/core';
import { AgentFactory } from './agents/factory.js';
import type { ChatAgentCallbacks } from './agents/types.js';
import type { ChatAgent } from './agents/chat-agent.js';

/**
 * Options for PrimaryAgentPool initialization.
 *
 * Issue #1499: Allows injecting channel-specific MessageBuilderOptions
 * at pool creation time.
 */
export interface PrimaryAgentPoolOptions {
  /**
   * Channel-specific MessageBuilderOptions.
   *
   * When provided, all ChatAgent instances created by this pool will use
   * these options for building enhanced message content (e.g., platform
   * headers, tool sections, attachment extras).
   *
   * Example: createFeishuMessageBuilderOptions() for Feishu channels.
   */
  messageBuilderOptions?: MessageBuilderOptions;

  /**
   * Dynamic cwd provider for project-scoped Agent context switching.
   *
   * When provided, all ChatAgent instances created by this pool will use
   * this provider to resolve their working directory per chatId.
   *
   * @see Issue #1916 (unified ProjectContext system)
   */
  cwdProvider?: CwdProvider;

  /**
   * Structured cwd resolver, injected alongside `cwdProvider` so ChatAgent can
   * surface the bound-missing workspace fallback to the user (Issue #4448
   * direction #1). See ChatAgentConfig.cwdResolver.
   */
  cwdResolver?: (chatId: string) => CwdResolution;

  /**
   * Issue #4169: Idle timeout in ms. Agents inactive for longer than this are
   * evicted (disposed), releasing their resources (query handle, channel, MCP
   * connections, listeners) to bound memory growth. Default: 30 minutes.
   * Set to 0 to disable idle eviction.
   */
  idleTimeoutMs?: number;

  /**
   * Issue #4169: How often to sweep for idle agents. Default: 5 minutes.
   */
  idleSweepIntervalMs?: number;

  /**
   * Issue #4577: Hard cap on a single busy turn, in ms.
   *
   * The busy exemption in `evictIdleAgents()` is correct (never kill a
   * mid-turn agent) but previously had NO upper bound — a 2h10m runaway
   * turn (13,903 SDK messages / $18.90 in the issue's evidence A) kept its
   * full subprocess tree (claude binary + 2 MCP servers + stray LSP)
   * uncollectable for the whole window. When a busy agent's turn exceeds
   * this cap, the sweep stops the query (abort + channel close, same as
   * the /stop command) and notifies the chat instead of silently waiting.
   *
   * Default: 90 minutes. Set to 0 to disable the busy-turn cap.
   */
  busyTurnHardCapMs?: number;

  /**
   * Issue #4577: user-facing notice hook, fired after a busy turn is stopped
   * by the hard cap. Fire-and-forget by contract — a failing notify must not
   * break the sweep for other agents (errors are logged, not thrown).
   *
   * When omitted, only the structured warn log is emitted.
   */
  onBusyCapExceeded?: (chatId: string, busyMinutes: number) => Promise<void> | void;
}

const logger = createLogger('PrimaryAgentPool');

/** Issue #4169: Default idle timeout before an inactive agent is evicted. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Issue #4169: Default idle-sweep interval. */
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Issue #4577: Default hard cap on a single busy turn before the sweep stops
 * the query. The issue's evidence A — a 2h10m turn / 13,903 SDK messages /
 * $18.90 — was judged a runaway loop, not an expected turn, and its P1
 * recommendation caps busy turns at 60~90min; 90min is the lenient end of
 * that band, so normal long research turns pass while the runaway class is
 * bounded.
 */
const DEFAULT_BUSY_TURN_HARD_CAP_MS = 90 * 60 * 1000;

/**
 * Issue #4256 (part 2): structured pool-state snapshot for leak diagnostics.
 *
 * Returned by `PrimaryAgentPool.getPoolStats()` and surfaced on the REST
 * `/api/health` endpoint. `totalEvictions` counts only `evictIdleAgents()`
 * evictions — explicit `reset()` / `disposeAll()` disposals are NOT included.
 */
export interface AgentPoolStats {
  /** Current live agents in the pool. */
  active: number;
  /** Live agents currently processing a turn (`isBusy`). */
  busy: number;
  /** Live agents not currently processing (`active - busy`). */
  idle: number;
  /** High-water mark of concurrent agents since pool start. */
  peakActive: number;
  /** Cumulative idle-evictions since pool start (excludes reset/disposeAll). */
  totalEvictions: number;
}

/**
 * PrimaryAgentPool - Manages ChatAgent instances for Primary Node.
 *
 * Each chatId gets its own ChatAgent instance with full MessageBuilder
 * support for enhanced prompts with context.
 */
export class PrimaryAgentPool {
  private readonly agents = new Map<string, ChatAgent>();
  private readonly options: PrimaryAgentPoolOptions;
  /** Issue #3696: chatIds that should skip history loading on next agent creation */
  private readonly skipHistoryChatIds = new Set<string>();
  /** Issue #4169: Last-used timestamp per chatId, for idle eviction. */
  private readonly lastUsedAt = new Map<string, number>();
  /** Issue #4169: Periodic sweep timer (unref'd) for idle eviction. */
  private idleSweepTimer?: ReturnType<typeof setInterval>;
  /**
   * Issue #4577: When each chat's current busy turn started (ms epoch).
   * Populated by the idle sweep when it first observes `isBusy`; cleared when
   * the agent goes idle again (or is reset/disposed). Bounded by the pool
   * size — one entry per currently-busy chat, deleted on turn end.
   */
  private readonly busySince = new Map<string, number>();
  /** Issue #4256: Peak concurrent agent count since pool start (leak diagnostics). */
  private peakActive = 0;
  /**
   * Issue #4256: Cumulative idle-evictions since pool start (leak diagnostics).
   * Counts ONLY evictions from `evictIdleAgents()`; explicit `reset()` and
   * `disposeAll()` disposals are NOT included.
   */
  private totalEvictions = 0;

  constructor(options: PrimaryAgentPoolOptions = {}) {
    this.options = options;
  }

  /**
   * Get the ChatAgent for a chatId without creating one.
   * Issue #3931: Used for internal lookups (e.g., isAgentBusy).
   *
   * @param chatId - Chat ID to look up
   * @returns ChatAgent if one exists, undefined otherwise
   */
  get(chatId: string): ChatAgent | undefined {
    return this.agents.get(chatId);
  }

  /**
   * Check if the agent for a chatId is currently busy processing.
   * Issue #3931: Encapsulates the busy check so callers don't depend
   * on ChatAgent internals. Uses ChatAgent.isBusy (based on
   * isProcessingMessage flag per Issue #3985) rather than taskComplete
   * to avoid timing windows.
   *
   * @param chatId - Chat ID to check
   * @returns true if the agent exists and is busy processing a message
   */
  isAgentBusy(chatId: string): boolean {
    const agent = this.agents.get(chatId);
    return agent ? agent.isBusy : false;
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * Issue #3776: When an agent already exists, updates its callbacks to match
   * the current message's channel. This ensures responses are routed correctly
   * when multiple channels (e.g., Feishu and REST) share the same chatId.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for the current channel (used for new agents
   *   or to update existing agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: ChatAgentCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      const skipHistory = this.skipHistoryChatIds.has(chatId);
      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
        cwdProvider: this.options.cwdProvider,
        cwdResolver: this.options.cwdResolver,
        skipHistory,
      });
      this.agents.set(chatId, agent);
      // Issue #3696: clear skip-history flag after agent creation
      this.skipHistoryChatIds.delete(chatId);
    } else {
      // Issue #3776: Update callbacks so responses route to the correct channel.
      // Without this, REST Channel responses go to Feishu's callbacks (which
      // don't resolve PendingResponse), causing HTTP timeouts.
      //
      // updateCallbacks() handles concurrency: if the agent is busy, the update
      // is deferred until the current query completes.
      agent.updateCallbacks(callbacks);
    }
    // Issue #4169: Track usage for idle eviction.
    this.lastUsedAt.set(chatId, Date.now());
    // Issue #4256: Track peak concurrent agents for leak diagnostics. Each
    // agent holds a query handle + inline MCP connections (incl. stdio child
    // processes for configured external MCP servers), so the active count is
    // the observable proxy for the per-process resource/subprocess ceiling.
    if (this.agents.size > this.peakActive) {
      this.peakActive = this.agents.size;
      // Issue #4256 (part 2): emit an immediate snapshot on a new high-water
      // mark so a sudden spike is visible without waiting for the next sweep
      // tick (default 5 min). Monotonic (peak only rises), so bounded by the
      // eventual ceiling — not noisy.
      this.logPoolSnapshot('peak');
    }
    return agent;
  }

  /**
   * Reset the ChatAgent for a chatId by disposing the old instance.
   *
   * Issue #3570: Instead of just clearing conversation context on the existing
   * agent, we dispose it completely and remove it from the pool. The next
   * getOrCreateChatAgent() call will create a fresh agent instance.
   *
   * This ensures all resources (MCP connections, event listeners, transports,
   * AbortControllers) are properly released rather than accumulated across
   * multiple /reset operations.
   *
   * @param chatId - Chat ID to reset
   * @param skipContext - If true, the next `getOrCreateChatAgent()` for this
   *   chat creates a fresh agent that SKIPS reloading persisted history (a true
   *   fresh session — used by the schedule `clearContext` option, Issue #4206).
   *   The flag is consumed (deleted) by that next getOrCreate. If false/omitted,
   *   the next agent reloads history normally.
   *
   *   Note the inverted polarity vs `ChatAgent.reset(chatId, keepContext)`:
   *   there `true` means keep context, here `true` means skip it.
   */
  reset(chatId: string, skipContext?: boolean): void {
    if (skipContext) {
      this.skipHistoryChatIds.add(chatId);
    } else {
      // Issue #4206 (review nit): a non-skip reset means "start fresh WITH
      // history next time". Clear any stale skip-history flag left by a prior
      // reset(chatId, true) whose consuming getOrCreate never ran — e.g. a
      // clearContext scheduled task that failed before routing. Without this,
      // that stale flag would leak to the next unrelated message and silently
      // drop its history.
      this.skipHistoryChatIds.delete(chatId);
    }
    const agent = this.agents.get(chatId);
    if (agent) {
      this.agents.delete(chatId);
      this.lastUsedAt.delete(chatId);
      // Issue #4577: clear the busy-turn marker along with the agent.
      this.busySince.delete(chatId);
      agent.dispose();
    }
  }

  /**
   * Stop the current query for a chatId without resetting the session.
   * Issue #1349: /stop command
   *
   * @param chatId - Chat ID to stop
   * @returns true if a query was stopped, false if no active query
   */
  stop(chatId: string): boolean {
    const agent = this.agents.get(chatId);
    if (agent) {
      return agent.stop(chatId);
    }
    return false;
  }

  /**
   * Dispose all agents and clear the pool.
   */
  disposeAll(): void {
    this.stopIdleSweep();
    for (const agent of this.agents.values()) {
      agent.dispose();
    }
    this.agents.clear();
    this.lastUsedAt.clear();
    // Issue #4577: clear busy-turn markers along with the agents.
    this.busySince.clear();
  }

  /**
   * Issue #4169: Start periodic eviction of idle agents.
   *
   * The agent pool is unbounded by default — every chatId gets a persistent
   * ChatAgent that is only released on explicit `/reset` or shutdown. Over long
   * runs this accumulates memory (each agent holds a query handle, channel, MCP
   * connections, listeners). The idle sweep disposes agents that haven't been
   * used for `idleTimeoutMs`, releasing those resources. Busy agents are never
   * evicted mid-turn. The timer is `unref`'d so it never keeps the process alive.
   *
   * Issue #4256 (part 2): the periodic pool-snapshot runs even when idle
   * eviction is disabled (`idleTimeoutMs <= 0`) — `evictIdleAgents()` is a
   * no-op in that case, but the leak-diagnostics snapshot still fires, so
   * monitoring stays live precisely when an unbounded pool is most likely to
   * leak.
   */
  startIdleSweep(): void {
    if (this.idleSweepTimer) { return; }
    const interval = this.options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    this.idleSweepTimer = setInterval(() => {
      const evicted = this.evictIdleAgents();
      if (evicted.length) {
        logger.info({ count: evicted.length }, 'Evicted idle agents (Issue #4169)');
      }
      // Issue #4256 (part 2): periodic pool-state snapshot for leak
      // diagnostics. A monotonic active/peak growth despite eviction, or a
      // busy count that never returns to zero, signals agents (and their
      // inline MCP subprocesses) are not being released — see #4169/#4256.
      this.logPoolSnapshot('idle-sweep');
    }, interval);
    this.idleSweepTimer.unref?.();
  }

  /**
   * Issue #4169: Evict (dispose) agents idle longer than the idle timeout.
   *
   * Issue #4577: busy agents are still never *evicted* mid-turn, but the
   * exemption now has a hard cap — a busy turn running longer than
   * `busyTurnHardCapMs` is stopped (abort + channel close, same path as the
   * /stop command) and the chat is notified, bounding how long a runaway
   * turn (2h10m / 13k SDK messages in the issue's evidence) can hold its
   * subprocess tree uncollectable. The stopped agent itself stays in the
   * pool and is reclaimed by the normal idle path once the turn unwinds.
   *
   * The busy cap runs even when idle eviction is disabled (`idleTimeoutMs`
   * <= 0) — same principle as #4256's always-on snapshot: the
   * memory-bounding control must stay live precisely when the pool is
   * unbounded.
   *
   * @param now - Injectable clock for deterministic testing (defaults to Date.now()).
   * @returns chatIds of the agents that were evicted.
   */
  evictIdleAgents(now: number = Date.now()): string[] {
    const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const evicted: string[] = [];
    for (const [chatId, agent] of this.agents) {
      // Never evict an agent mid-turn...
      if (agent.isBusy) {
        // ...but Issue #4577: cap how long a busy turn can run. Track when
        // this busy turn was first observed; if it exceeds the hard cap,
        // stop the query so the turn unwinds and the agent becomes
        // evictable on a later sweep.
        this.enforceBusyTurnCap(chatId, agent, now);
        continue;
      }
      // Issue #4577: turn over — clear the busy-start marker so the next
      // busy turn starts a fresh cap window.
      this.busySince.delete(chatId);
      if (timeout <= 0) { continue; }
      const last = this.lastUsedAt.get(chatId) ?? now;
      if (now - last >= timeout) {
        this.agents.delete(chatId);
        this.lastUsedAt.delete(chatId);
        agent.dispose();
        evicted.push(chatId);
      }
    }
    // Issue #4256: tally evictions for the leak-diagnostics snapshot.
    this.totalEvictions += evicted.length;
    return evicted;
  }

  /**
   * Issue #4577: enforce the busy-turn hard cap for one busy agent.
   *
   * Records the first-observed busy timestamp (the sweep runs every
   * `idleSweepIntervalMs`, so the effective measurement granularity is one
   * sweep interval — acceptable for a 90-minute cap). When the current busy
   * turn exceeds `busyTurnHardCapMs`, stops the agent's query (same path as
   * the /stop command: abort + channel close, session preserved) and fires
   * the `onBusyCapExceeded` hook (user notice). Notification is
   * fire-and-forget — a failing channel must not break the sweep for other
   * agents.
   */
  private enforceBusyTurnCap(
    chatId: string,
    agent: Pick<ChatAgent, 'isBusy' | 'stop'>,
    now: number
  ): void {
    const cap = this.options.busyTurnHardCapMs ?? DEFAULT_BUSY_TURN_HARD_CAP_MS;
    if (cap <= 0) { return; } // Cap disabled — no tracking, never stop.
    const since = this.busySince.get(chatId);
    if (since === undefined) {
      this.busySince.set(chatId, now);
      return;
    }
    if (now - since < cap) { return; }
    const busyMin = Math.round((now - since) / 60000);
    logger.warn(
      { chatId, busyMinutes: busyMin, capMs: cap },
      'Busy turn exceeded hard cap (Issue #4577) — stopping query'
    );
    agent.stop(chatId);
    // Clear the marker so the next busy turn (if any) gets a fresh window
    // rather than being re-stopped on every sweep tick.
    this.busySince.delete(chatId);
    // Notify the user fire-and-forget: channel failure must not propagate
    // into the sweep loop.
    const notify = this.options.onBusyCapExceeded;
    if (notify) {
      void Promise.resolve(notify(chatId, busyMin)).catch((err) => {
        logger.error({ err, chatId }, 'Failed to send busy-cap notification');
      });
    }
  }

  /**
   * Issue #4256 (part 2): snapshot of pool state for leak diagnostics.
   *
   * Each active agent holds a query handle, channel, and inline MCP
   * connections (including stdio child processes for configured external MCP
   * servers). The active/peak/eviction counts are the observable per-process
   * proxy for that resource footprint, letting operators spot a leak (e.g.
   * active grows monotonically, or busy never returns to zero) without
   * enumerating live subprocesses.
   *
   * Surfaced on the REST `/api/health` endpoint so operators can query live
   * pool state without scraping logs.
   *
   * @returns A structured snapshot of current and cumulative pool state.
   */
  getPoolStats(): AgentPoolStats {
    let busy = 0;
    for (const agent of this.agents.values()) {
      if (agent.isBusy) { busy++; }
    }
    return {
      active: this.agents.size,
      busy,
      idle: this.agents.size - busy,
      peakActive: this.peakActive,
      totalEvictions: this.totalEvictions,
    };
  }

  /**
   * Issue #4256 (part 2): emit a structured pool-state snapshot log. Called on
   * each idle sweep (and available for ad-hoc diagnostics). Pure observability
   * — no behavior change.
   *
   * @param reason - What triggered the snapshot (e.g. 'idle-sweep').
   */
  private logPoolSnapshot(reason: string): void {
    const stats = this.getPoolStats();
    logger.info({ reason, ...stats }, 'Agent pool snapshot (Issue #4256)');
  }

  /**
   * Issue #4169: Stop the idle-eviction sweep timer.
   */
  stopIdleSweep(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
  }
}
