/**
 * ChatSessionPool - Agent pool for disclaude service.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/service to create ChatAgent instances.
 *
 * Issue #1499: Accepts optional MessageBuilderOptions for channel-specific
 * message building (e.g., Feishu sections). This decouples Feishu-specific
 * logic from the core agent runtime.
 *
 * @see Issue #1040 - Separate disclaude service code to @disclaude/service
 */

import { type MessageBuilderOptions, type CwdProvider, type CwdResolution, type AgentPreset, type AgentSessionOptions, type AgentPresets, buildSessionKey, chatIdOfSessionKey, createLogger, getProvider, Config, resolveAgentPreset } from '@disclaude/core';
import { statSync } from 'node:fs';
import { AgentFactory } from './agents/factory.js';
import type { ChatAgentCallbacks } from './agents/types.js';
import type { ChatAgent } from './agents/chat-agent.js';
import type { ServiceTurnRecoveryStore } from './service-turn-recovery.js';

/**
 * Options for ChatSessionPool initialization.
 *
 * Issue #1499: Allows injecting channel-specific MessageBuilderOptions
 * at pool creation time.
 */
export interface ChatSessionPoolOptions {
  /** Named runtime presets. Defaults to Config.getAgentPresets(). */
  agentPresets?: AgentPresets;
  /** Backend availability probe; injectable for deterministic tests. */
  validatePresetBackend?: (backend: AgentPreset['agentBackend']) =>
    { available: boolean; unavailableReason?: string };
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

  /** Durable journal for interrupted turns caused by a service restart. */
  turnRecovery?: ServiceTurnRecoveryStore;

  /**
   * Issue #4644: provider-session forgetter invoked by reset() — clears the
   * SDK provider's per-chat session state (codex: governor registration +
   * evicted-thread stash) so a /reset cannot be undone by the eviction-resume
   * mechanism. Injectable for tests; default resolves the process-wide cached
   * provider (the same singleton BaseAgent agents use) and no-ops on
   * providers without the optional capability (claude/pi).
   */
  forgetProviderSession?: (chatId: string) => void;
}

const logger = createLogger('ChatSessionPool');

/** Issue #4169: Default idle timeout before an inactive agent is evicted. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Issue #4169: Default idle-sweep interval. */
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Re-export so existing `./chat-session-pool.js` importers keep working; the
// implementation now lives in core next to buildSessionKey (PR #4590 review N4
// — the `::` separator had been hardcoded here and in the pool test mock).
export { chatIdOfSessionKey };

/**
 * Issue #4256 (part 2): structured pool-state snapshot for leak diagnostics.
 *
 * Returned by `ChatSessionPool.getPoolStats()` and surfaced on the REST
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

export interface ActiveAgentPreset {
  name: string;
  agentBackend: AgentPreset['agentBackend'];
  model: string;
}

export type AgentPresetSwitchResult =
  | { ok: true; active: ActiveAgentPreset; sessionBoundary: 'new-session' }
  | { ok: false; error: string };

/**
 * ChatSessionPool - Manages ChatAgent instances for disclaude service.
 *
 * Each chatId gets its own ChatAgent instance with full MessageBuilder
 * support for enhanced prompts with context.
 *
 * Issue #4587 (part 2): topic-group threads get their OWN agent per thread.
 * Internally the pool keys agents on `buildSessionKey(chatId, threadRootId)`
 * (`chatId` for p2p/plain chats, `chatId::threadRoot` inside topic groups), so
 * each thread's context stays isolated. Everything user-facing — the agent's
 * `boundChatId` and callbacks — still receives the plain
 * `chatId`, so replies route to the chat exactly as before. Lazy migration:
 * messages without a `threadRootId` keep using the chat-scoped key, so
 * existing sessions are unaffected until a thread message starts a new one.
 */
export class ChatSessionPool {
  /** Release a completed temporary scope only if it still owns the pool slot. */
  releaseChatAgent(chatId: string, sessionId: string, agent: ChatAgent): void {
    const key = this.sessionKeyOf(chatId, sessionId);
    if (this.agents.get(key) !== agent) { return; }
    try { agent.reset(); } finally { this.reset(chatId, false, sessionId); }
  }

  /** Keyed by buildSessionKey(chatId, threadRootId) — see class doc (Issue #4587 part 2). */
  private readonly agents = new Map<string, ChatAgent>();
  // Remember persistent topics after idle eviction too, so a Project change
  // forgets their native provider state. Isolated execution scopes pin their
  // own directory and never enter this registry.
  private readonly projectSessions = new Map<string, { chatId: string; threadRootId?: string }>();
  private readonly callbacksBySession = new Map<string, ChatAgentCallbacks>();
  private readonly selectedPresetBySession = new Map<string, string>();
  private readonly presets?: AgentPresets;
  private readonly options: ChatSessionPoolOptions;
  /**
   * Issue #3696: session keys that should skip history loading on next agent
   * creation. Keyed like `agents` (Issue #4587 part 2) — a /reset in a thread
   * only skips history for that thread's next agent.
   */
  private readonly skipHistoryChatIds = new Set<string>();
  /** Issue #4169: Last-used timestamp per session key, for idle eviction. */
  private readonly lastUsedAt = new Map<string, number>();
  /** Issue #4169: Periodic sweep timer (unref'd) for idle eviction. */
  private idleSweepTimer?: ReturnType<typeof setInterval>;
  /** Issue #4256: Peak concurrent agent count since pool start (leak diagnostics). */
  private peakActive = 0;
  /**
   * Issue #4256: Cumulative idle-evictions since pool start (leak diagnostics).
   * Counts ONLY evictions from `evictIdleAgents()`; explicit `reset()` and
   * `disposeAll()` disposals are NOT included.
   */
  private totalEvictions = 0;
  /**
   * Issue #4644: reset() hook into provider-side session state. Defaults to
   * the process-wide cached SDK provider (the same singleton every BaseAgent
   * agent resolves) so pool resets and agent-level resets hit one provider.
   */
  private readonly forgetProviderSession: (chatId: string) => void;
  private isShuttingDown = false;

  constructor(options: ChatSessionPoolOptions = {}) {
    this.options = options;
    this.forgetProviderSession =
      options.forgetProviderSession ??
      ((chatId: string): void => {
        getProvider().forgetSession?.(chatId);
      });
    this.presets = options.agentPresets ?? Config.getAgentPresets();
  }

  listAgentPresets(): ActiveAgentPreset[] {
    return Object.entries(this.presets ?? {}).map(([name, preset]) => ({
      name,
      agentBackend: preset.agentBackend,
      model: preset.model,
    }));
  }

  getActiveAgentPreset(chatId: string, threadRootId?: string): ActiveAgentPreset | undefined {
    if (!this.presets) { return undefined; }
    const sessionKey = this.sessionKeyOf(chatId, threadRootId);
    const resolved = resolveAgentPreset(this.presets, this.selectedPresetBySession.get(sessionKey));
    return resolved.ok
      ? { name: resolved.name, agentBackend: resolved.preset.agentBackend, model: resolved.preset.model }
      : undefined;
  }

  /**
   * Select a preset for one chat/thread. Existing agents are replaced only
   * after the candidate backend and ChatAgent construct successfully.
   */
  switchAgentPreset(
    chatId: string,
    presetName: string,
    threadRootId?: string
  ): AgentPresetSwitchResult {
    if (!this.presets) {
      return { ok: false, error: 'No named agent presets are configured (add an agents: map)' };
    }
    const resolved = resolveAgentPreset(this.presets, presetName);
    if (!resolved.ok) { return resolved; }

    const sessionKey = this.sessionKeyOf(chatId, threadRootId);
    const previous = this.agents.get(sessionKey);
    if (previous?.isBusy) {
      return { ok: false, error: 'The current chat is busy; wait for the response or use /stop before switching presets' };
    }

    let info: { available: boolean; unavailableReason?: string };
    try {
      info = this.options.validatePresetBackend
        ? this.options.validatePresetBackend(resolved.preset.agentBackend)
        : getProvider(resolved.preset.agentBackend).getInfo();
    } catch {
      return { ok: false, error: `Could not validate agent preset "${resolved.name}". Check backend configuration and availability; the current session is unchanged.` };
    }
    if (!info.available) {
      return {
        ok: false,
        error: `Agent preset "${resolved.name}" is unavailable: ${info.unavailableReason ?? 'backend unavailable'}`,
      };
    }

    const callbacks = this.callbacksBySession.get(sessionKey);
    let candidate: ChatAgent | undefined;
    if (callbacks && previous) {
      try {
        candidate = this.createAgent(chatId, callbacks, resolved.preset, true, sessionKey);
      } catch (error) {
        return {
          ok: false,
          error: `Could not activate agent preset "${resolved.name}": ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    if (candidate) {
      // Construction is side-effect free with respect to the native SDK
      // session. Forget the selected backend only after construction succeeds,
      // so a failed switch leaves the currently active session untouched.
      try {
        getProvider(resolved.preset.agentBackend).forgetSession?.(sessionKey);
      } catch (error) {
        candidate.dispose();
        return {
          ok: false,
          error: `Could not start a fresh session for preset "${resolved.name}": ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      this.agents.set(sessionKey, candidate);
      previous?.dispose();
    } else {
      // A command can select a preset before this chat has created an agent.
      // Consume this marker on first use so persisted textual history is not
      // mistaken for cross-backend native-session migration.
      this.skipHistoryChatIds.add(sessionKey);
    }
    this.selectedPresetBySession.set(sessionKey, resolved.name);
    return {
      ok: true,
      active: {
        name: resolved.name,
        agentBackend: resolved.preset.agentBackend,
        model: resolved.preset.model,
      },
      sessionBoundary: 'new-session',
    };
  }

  private createAgent(
    chatId: string,
    callbacks: ChatAgentCallbacks,
    preset?: AgentPreset,
    skipHistory = false,
    sdkSessionKey = chatId,
    modelOverride?: string,
    freezeDirectory = false,
  ): ChatAgent {
    let { cwdProvider, cwdResolver } = this.options;
    if (freezeDirectory) {
      const initial = cwdResolver?.(chatId);
      // Preserve an unavailable bound target too: taking effectiveCwd alone
      // would silently adopt the workspace fallback instead of rejecting it.
      const directory = initial?.boundWorkingDir ?? initial?.effectiveCwd ?? cwdProvider?.(chatId);
      if (directory !== undefined) {
        cwdProvider = () => directory;
        cwdResolver = () => {
          let available = false;
          try { available = statSync(directory).isDirectory(); } catch { /* fail closed */ }
          return { effectiveCwd: directory, boundWorkingDir: directory, reason: available ? 'bound' : 'bound-missing' };
        };
      }
    }
    return AgentFactory.createChatAgent('pilot', chatId, callbacks, {
      messageBuilderOptions: this.options.messageBuilderOptions,
      cwdProvider,
      cwdResolver,
      skipHistory,
      sdkSessionKey,
      turnRecovery: this.options.turnRecovery,
      ...(preset ? {
        agentBackend: preset.agentBackend,
        model: preset.model,
        provider: preset.provider,
        apiBaseUrl: preset.apiBaseUrl,
        permissionMode: preset.permissionMode,
      } : {}),
      ...(modelOverride !== undefined ? { model: modelOverride } : {}),
    });
  }

  /**
   * Issue #4587 (part 2): pool map key for a chat/thread pair.
   * `chatId::threadRoot` for topic-group threads, plain `chatId` otherwise
   * (delegates to the #4305 part-1 primitive).
   */
  private sessionKeyOf(chatId: string, threadRootId?: string): string {
    return buildSessionKey(chatId, threadRootId);
  }

  /**
   * Get the ChatAgent for a chatId without creating one.
   * Issue #3931: Used for internal lookups (e.g., isAgentBusy).
   * Issue #4587 (part 2): `threadRootId` selects a topic-group thread's agent.
   *
   * @param chatId - Chat ID to look up
   * @param threadRootId - Optional thread root (topic groups only)
   * @returns ChatAgent if one exists, undefined otherwise
   */
  get(chatId: string, threadRootId?: string): ChatAgent | undefined {
    return this.agents.get(this.sessionKeyOf(chatId, threadRootId));
  }

  /**
   * Check if the agent for a chatId is currently busy processing.
   * Issue #3931: Encapsulates the busy check so callers don't depend
   * on ChatAgent internals. Uses ChatAgent.isBusy (based on
   * isProcessingMessage flag per Issue #3985) rather than taskComplete
   * to avoid timing windows.
   *
   * Issue #4587 (part 2): with `threadRootId`, checks that thread's agent.
   * Without it, checks the chat-scoped agent (scheduler/loop callers) — a busy
   * thread does NOT make the chat-scoped agent look busy.
   *
   * @param chatId - Chat ID to check
   * @param threadRootId - Optional thread root (topic groups only)
   * @returns true if the agent exists and is busy processing a message
   */
  isAgentBusy(chatId: string, threadRootId?: string): boolean {
    const agent = this.agents.get(this.sessionKeyOf(chatId, threadRootId));
    return agent ? agent.isBusy : false;
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * Issue #3776: When an agent already exists, updates its callbacks to match
   * the current message's channel. This ensures responses are routed correctly
   * when multiple channels (e.g., Feishu and REST) share the same chatId.
   *
   * Issue #4587 (part 2): a topic-group `threadRootId` selects that thread's
   * agent — one agent per thread, so thread contexts stay isolated. The agent
   * itself is still constructed with the plain `chatId` (boundChatId, history,
   * callbacks all stay chat-scoped); only the pool slot is per-thread. Lazy
   * migration: messages without a `threadRootId` use the chat-scoped slot, so
   * pre-existing chat sessions keep their agent untouched.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for the current channel (used for new agents
   *   or to update existing agents)
   * @param threadRootId - Optional thread root; present only for topic-group
   *   messages (part 1 pipeline). Omitted for p2p, plain groups, and
   *   scheduler/loop system messages.
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(
    chatId: string,
    callbacks: ChatAgentCallbacks,
    threadRootId?: string,
    session?: AgentSessionOptions,
  ): ChatAgent {
    if (this.isShuttingDown) {
      throw new Error('Disclaude service is shutting down; the message was not started');
    }
    if (session && (!session.id.trim() || (threadRootId && threadRootId !== session.id))) {
      throw new Error('Agent session must have a nonempty, unambiguous scope');
    }
    const sessionKey = this.sessionKeyOf(chatId, session?.id ?? threadRootId);
    let agent = this.agents.get(sessionKey);
    if (agent && session?.releaseAfterTurn) {
      throw new Error('Temporary session already owns an agent');
    }
    if (!agent) {
      const skipHistory = session?.skipHistory ?? this.skipHistoryChatIds.has(sessionKey);
      const selected = this.presets
        ? resolveAgentPreset(this.presets, this.selectedPresetBySession.get(sessionKey))
        : undefined;
      agent = this.createAgent(
        chatId,
        callbacks,
        selected?.ok ? selected.preset : undefined,
        skipHistory,
        sessionKey,
        session?.model,
        session !== undefined
      );
      this.agents.set(sessionKey, agent);
      // Issue #3696: clear skip-history flag after agent creation
      this.skipHistoryChatIds.delete(sessionKey);
    } else {
      // Issue #3776: Update callbacks so responses route to the correct channel.
      // Without this, REST Channel responses go to Feishu's callbacks (which
      // don't resolve PendingResponse), causing HTTP timeouts.
      //
      // updateCallbacks() handles concurrency: if the agent is busy, the update
      // is deferred until the current query completes.
      agent.updateCallbacks(callbacks);
    }
    // Rejected requests must not replace the delivery owner used by preset switches.
    this.callbacksBySession.set(sessionKey, callbacks);
    if (!session) { this.projectSessions.set(sessionKey, { chatId, threadRootId }); }
    // Issue #4169: Track usage for idle eviction.
    this.lastUsedAt.set(sessionKey, Date.now());
    // Issue #4256: Track peak concurrent agents for leak diagnostics. Each
    // agent holds a query handle and SDK resources (including child processes
    // for explicitly configured external tools), so the active count is
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

  /** Whether any persistent session affected by a Project change still owns work. */
  isProjectBusy(chatId: string): boolean {
    for (const [key, scope] of this.projectSessions) {
      if (scope.chatId !== chatId) { continue; }
      const agent = this.agents.get(key);
      // The pending-work signal also covers history admission and background
      // tasks in runtimes that expose it, beyond the current visible turn.
      if (agent && (agent.isBusy || ('hasPendingWork' in agent && agent.hasPendingWork === true))) { return true; }
    }
    return false;
  }

  /** Refresh the chat-wide binding without resetting directory-pinned executions. */
  resetProjectSessions(chatId: string): void {
    const roots = new Set([undefined, ...[...this.projectSessions.values()]
      .filter(scope => scope.chatId === chatId).map(scope => scope.threadRootId)]);
    for (const threadRootId of roots) {
      this.reset(chatId, undefined, threadRootId);
    }
  }

  /**
   * Reset the ChatAgent for a chatId by disposing the old instance.
   *
   * Issue #3570: Instead of just clearing conversation context on the existing
   * agent, we dispose it completely and remove it from the pool. The next
   * getOrCreateChatAgent() call will create a fresh agent instance.
   *
   * This ensures all resources (SDK connections, event listeners, transports,
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
   * @param threadRootId - Optional thread root (Issue #4587 part 2): reset only
   *   that thread's agent instead of the chat-scoped one. `/reset` inside a
   *   topic-group thread clears that thread's context; other threads and the
   *   chat-scoped agent are untouched. Omitted (scheduler/control commands
   *   today) resets the chat-scoped agent.
   */
  reset(chatId: string, skipContext?: boolean, threadRootId?: string): void {
    const sessionKey = this.sessionKeyOf(chatId, threadRootId);
    this.projectSessions.delete(sessionKey);
    // Callbacks capture channel/request state and are only needed while an
    // agent occupies this slot. Preset selection intentionally survives reset.
    this.callbacksBySession.delete(sessionKey);
    if (skipContext) {
      this.skipHistoryChatIds.add(sessionKey);
    } else {
      // Issue #4206 (review nit): a non-skip reset means "start fresh WITH
      // history next time". Clear any stale skip-history flag left by a prior
      // reset(chatId, true) whose consuming getOrCreate never ran — e.g. a
      // clearContext scheduled task that failed before routing. Without this,
      // that stale flag would leak to the next unrelated message and silently
      // drop its history.
      this.skipHistoryChatIds.delete(sessionKey);
    }
    // Issue #4644: clear provider-side session state BEFORE the agent lookup —
    // it must fire even when no ChatAgent instance exists (the chat may have
    // been idle-evicted from this pool while its codex stash lived on). Keyed
    // by the same scoped native session key used during construction.
    const selected = this.presets
      ? resolveAgentPreset(this.presets, this.selectedPresetBySession.get(sessionKey))
      : undefined;
    if (selected?.ok) {
      getProvider(selected.preset.agentBackend).forgetSession?.(sessionKey);
    } else {
      this.forgetProviderSession(sessionKey);
    }
    const agent = this.agents.get(sessionKey);
    if (agent) {
      this.agents.delete(sessionKey);
      this.lastUsedAt.delete(sessionKey);
      agent.dispose();
    }
  }

  /**
   * Stop the current query for a chatId without resetting the session.
   * Issue #1349: /stop command
   * Issue #4587 (part 2): `threadRootId` stops that thread's agent only.
   *
   * @param chatId - Chat ID to stop
   * @param threadRootId - Optional thread root (topic groups only)
   * @returns true if a query was stopped, false if no active query
   */
  stop(chatId: string, threadRootId?: string): boolean {
    const agent = this.agents.get(this.sessionKeyOf(chatId, threadRootId));
    if (agent) {
      return agent.stop(chatId);
    }
    return false;
  }

  async steer(chatId: string, prompt: string, threadRootId?: string): Promise<
    { ok: true; message: string } | { ok: false; error: string }
  > {
    const agent = this.agents.get(this.sessionKeyOf(chatId, threadRootId));
    if (!agent?.isBusy) {
      return { ok: false, error: 'No active turn to steer. Send the message normally to start or queue a turn.' };
    }
    try {
      const result = await agent.steer(prompt);
      return result.ok
        ? { ok: true, message: `Steer acknowledged for active turn ${result.turnId}.` }
        : result;
    } catch (error) {
      return {
        ok: false,
        error: `Steer failed before acknowledgement: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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
    this.projectSessions.clear();
    this.lastUsedAt.clear();
    this.callbacksBySession.clear();
    this.selectedPresetBySession.clear();
  }

  /**
   * Stop accepting new turns, allow a bounded drain, then persist and report
   * any remaining turns as interrupted before releasing their agents.
   */
  async shutdownForServiceRestart(options: {
    drainTimeoutMs?: number;
    noticeTimeoutMs?: number;
  } = {}): Promise<void> {
    this.isShuttingDown = true;
    this.stopIdleSweep();
    for (const agent of this.agents.values()) { agent.beginServiceShutdown(); }
    const drainTimeoutMs = Math.max(0, options.drainTimeoutMs ?? 10_000);
    const noticeTimeoutMs = Math.max(0, options.noticeTimeoutMs ?? 2_000);
    const deadline = Date.now() + drainTimeoutMs;
    const hasPendingWork = (): boolean => [...this.agents.values()].some(agent => agent.hasPendingWork);

    while (hasPendingWork() && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    }

    const remaining = [...this.agents.entries()].filter(([, agent]) => agent.hasPendingWork);
    if (remaining.length > 0) {
      logger.warn(
        { count: remaining.length, sessionKeys: remaining.map(([sessionKey]) => sessionKey), drainTimeoutMs },
        'Service shutdown drain expired; interrupting remaining agent turns (Issue #5273)'
      );
      await Promise.allSettled(remaining.map(([, agent]) => agent.interruptForServiceRestart(noticeTimeoutMs)));
    }
    this.disposeAll();
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
      // configured tool subprocesses) are not being released — see #4169/#4256.
      this.logPoolSnapshot('idle-sweep');
    }, interval);
    this.idleSweepTimer.unref?.();
  }

  /**
   * Issue #4169: Evict (dispose) agents idle longer than the idle timeout.
   *
   * Active turns, admitted/queued requests, and live background tasks are
   * protected from idle disposal until the work completes or is explicitly
   * stopped. The pool never stops pending work based on elapsed time.
   *
   * @param now - Injectable clock for deterministic testing (defaults to Date.now()).
   * @returns Session keys of the agents that were evicted. Issue #4587 (part 2):
   *   these are `buildSessionKey()` values — plain chatIds for chat-scoped
   *   agents, `chatId::threadRoot` for topic-group thread agents.
   */
  evictIdleAgents(now: number = Date.now()): string[] {
    const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const evicted: string[] = [];
    for (const [sessionKey, agent] of this.agents) {
      // An admitted message or a live background task is work even when the
      // main SDK turn has not started or has already returned its result.
      if (agent.isBusy || agent.hasPendingWork) {
        continue;
      }
      if (timeout <= 0) { continue; }
      const last = Math.max(this.lastUsedAt.get(sessionKey) ?? now, agent.lastActivityAt ?? 0);
      if (now - last >= timeout) {
        logger.info({ sessionKey, isBusy: agent.isBusy, hasPendingWork: agent.hasPendingWork,
          backgroundTaskCount: agent.activeBackgroundTaskCount ?? 0, turnStartedAtMs: agent.turnStartedAtMs,
          lastUsedAt: last, lastActivityAt: agent.lastActivityAt, lastActivityType: agent.lastActivityType,
          idleTimeoutMs: timeout, idleMs: now - last }, 'Evicting inactive agent');
        this.agents.delete(sessionKey);
        this.lastUsedAt.delete(sessionKey);
        // Do not retain channel closures after the owning agent is evicted.
        // selectedPresetBySession remains so the next agent uses the same preset.
        this.callbacksBySession.delete(sessionKey);
        agent.dispose();
        evicted.push(sessionKey);
      }
    }
    // Issue #4256: tally evictions for the leak-diagnostics snapshot.
    this.totalEvictions += evicted.length;
    return evicted;
  }

  /**
   * Issue #4256 (part 2): snapshot of pool state for leak diagnostics.
   *
   * Each active agent holds a query handle, input channel, and SDK resources
   * (including child processes for explicitly configured external tools). The active/peak/eviction counts are the observable per-process
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
