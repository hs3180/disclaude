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

import { type MessageBuilderOptions, type CwdProvider, createLogger } from '@disclaude/core';
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
}

const logger = createLogger('PrimaryAgentPool');

/** Issue #4169: Default idle timeout before an inactive agent is evicted. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Issue #4169: Default idle-sweep interval. */
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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
   * @param _keepContext - Ignored (kept for API compatibility). Context is not
   *   preserved since the old agent is fully disposed.
   */
  reset(chatId: string, skipContext?: boolean): void {
    if (skipContext) {
      this.skipHistoryChatIds.add(chatId);
    }
    const agent = this.agents.get(chatId);
    if (agent) {
      this.agents.delete(chatId);
      this.lastUsedAt.delete(chatId);
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
   */
  startIdleSweep(): void {
    if (this.idleSweepTimer) { return; }
    const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (timeout <= 0) { return; } // idle eviction disabled
    const interval = this.options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    this.idleSweepTimer = setInterval(() => {
      const evicted = this.evictIdleAgents();
      if (evicted.length) {
        logger.info({ count: evicted.length }, 'Evicted idle agents (Issue #4169)');
      }
    }, interval);
    this.idleSweepTimer.unref?.();
  }

  /**
   * Issue #4169: Evict (dispose) agents idle longer than the idle timeout.
   *
   * @param now - Injectable clock for deterministic testing (defaults to Date.now()).
   * @returns chatIds of the agents that were evicted.
   */
  evictIdleAgents(now: number = Date.now()): string[] {
    const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (timeout <= 0) { return []; }
    const evicted: string[] = [];
    for (const [chatId, agent] of this.agents) {
      // Never evict an agent mid-turn.
      if (agent.isBusy) { continue; }
      const last = this.lastUsedAt.get(chatId) ?? now;
      if (now - last >= timeout) {
        this.agents.delete(chatId);
        this.lastUsedAt.delete(chatId);
        agent.dispose();
        evicted.push(chatId);
      }
    }
    return evicted;
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
