/**
 * NonUserMessageRouter — Routes system-driven messages to ChatAgent instances.
 *
 * The router resolves projectKey → chatId via project configuration lookup,
 * then gets/creates a ChatAgent via AgentPool and delivers the message payload.
 *
 * Key behaviors:
 * - Messages queue when the target ChatAgent is busy (taskComplete not settled)
 * - Per-project message queue with FIFO ordering
 * - Automatic delivery of queued messages when agent becomes idle
 * - No modification to ChatAgent.processMessage() signature
 *
 * @see Issue #3331 (NonUserMessage type definition and routing layer)
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type { ChatAgent } from '../agents/types.js';
import type { AgentPool } from '../agents/agent-pool.js';
import type { NonUserMessage, RouteResult } from './non-user-message.js';

const defaultLogger = createLogger('NonUserMessageRouter');

// ============================================================================
// Project Resolver Interface
// ============================================================================

/**
 * Resolves a projectKey to a chatId.
 *
 * Initially backed by simple config lookup (e.g., disclaude.config.yaml).
 * Extended by ProjectManager in Phase 2 (Issue #3332).
 */
export interface ProjectResolver {
  /**
   * Resolve a projectKey to its bound chatId.
   *
   * @param projectKey - The project key (e.g., 'hs3180/disclaude')
   * @returns The chatId, or undefined if not found
   */
  resolve(projectKey: string): string | undefined;
}

/**
 * Simple static config-backed ProjectResolver.
 * Maps projectKey → chatId from a plain object.
 */
export class StaticProjectResolver implements ProjectResolver {
  private readonly mapping: Map<string, string>;

  constructor(config: Record<string, string>) {
    this.mapping = new Map(Object.entries(config));
  }

  resolve(projectKey: string): string | undefined {
    return this.mapping.get(projectKey);
  }
}

// ============================================================================
// Queued Message Entry
// ============================================================================

interface QueuedMessage {
  message: NonUserMessage;
  resolve: (result: RouteResult) => void;
}

// ============================================================================
// NonUserMessageRouter
// ============================================================================

/**
 * Configuration for NonUserMessageRouter.
 */
export interface NonUserMessageRouterConfig {
  /** Resolves projectKey → chatId */
  projectResolver: ProjectResolver;
  /** Agent pool for getting/creating ChatAgents */
  agentPool: AgentPool;
  /** Optional logger */
  logger?: Logger;
}

/**
 * NonUserMessageRouter — Routes NonUserMessages to appropriate ChatAgent instances.
 *
 * Routing flow:
 * 1. Resolve projectKey → chatId via ProjectResolver
 * 2. Get/create ChatAgent for chatId via AgentPool
 * 3. If agent is idle → deliver immediately via processMessage()
 * 4. If agent is busy → enqueue and deliver when taskComplete resolves
 *
 * @example
 * ```typescript
 * const router = new NonUserMessageRouter({
 *   projectResolver: new StaticProjectResolver({
 *     'hs3180/disclaude': 'oc_3d14c151cc209fd7ac1176a2b7ecbc30',
 *   }),
 *   agentPool: myAgentPool,
 * });
 *
 * const result = await router.route({
 *   id: 'sched-123',
 *   type: 'scheduled',
 *   source: 'scheduler:daily-sync',
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'Run daily triage',
 *   priority: 'normal',
 *   createdAt: new Date().toISOString(),
 * });
 * ```
 */
export class NonUserMessageRouter {
  private readonly projectResolver: ProjectResolver;
  private readonly agentPool: AgentPool;
  private readonly log: Logger;

  /** Per-project message queues (projectKey → queued messages) */
  private readonly queues = new Map<string, QueuedMessage[]>();

  /** Track if a drain loop is active for a projectKey */
  private readonly draining = new Set<string>();

  /** Whether the router has been disposed */
  private disposed = false;

  constructor(config: NonUserMessageRouterConfig) {
    this.projectResolver = config.projectResolver;
    this.agentPool = config.agentPool;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Route a NonUserMessage to the appropriate ChatAgent.
   *
   * Resolves projectKey → chatId → ChatAgent, then delivers the message.
   * If the ChatAgent is busy, the message is queued and delivered when idle.
   *
   * @param message - The NonUserMessage to route
   * @returns RouteResult indicating success or failure
   */
  route(message: NonUserMessage): Promise<RouteResult> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, error: 'Router has been disposed' });
    }

    // Step 1: Resolve projectKey → chatId
    const chatId = this.projectResolver.resolve(message.projectKey);
    if (!chatId) {
      this.log.warn(
        { projectKey: message.projectKey, messageId: message.id },
        'No chatId found for projectKey',
      );
      return Promise.resolve({ ok: false, error: `Project not found: ${message.projectKey}` });
    }

    // Step 2: Get or create ChatAgent
    const agent = this.agentPool.getOrCreateChatAgent(chatId);

    // Step 3: Check if agent is busy (has an active taskComplete promise)
    if (this.isAgentBusy(agent)) {
      this.log.info(
        { projectKey: message.projectKey, chatId, messageId: message.id },
        'Agent busy, queueing message',
      );
      return new Promise<RouteResult>((resolve) => {
        this.enqueue(message.projectKey, { message, resolve });
      });
    }

    // Step 4: Deliver immediately
    this.log.info(
      { projectKey: message.projectKey, chatId, messageId: message.id },
      'Delivering message to agent',
    );
    this.deliver(agent, chatId, message);
    return Promise.resolve({ ok: true, chatId });
  }

  /**
   * Enqueue a message for later delivery.
   * Starts a drain loop to deliver queued messages when the agent becomes idle.
   */
  private enqueue(projectKey: string, entry: QueuedMessage): void {
    let queue = this.queues.get(projectKey);
    if (!queue) {
      queue = [];
      this.queues.set(projectKey, queue);
    }
    queue.push(entry);
    this.log.debug(
      { projectKey, queueLength: queue.length },
      'Message enqueued',
    );

    // Start drain loop if not already running
    this.startDrain(projectKey);
  }

  /**
   * Start a drain loop for a projectKey.
   * Polls the agent's busy state and delivers queued messages when idle.
   */
  private startDrain(projectKey: string): void {
    if (this.draining.has(projectKey) || this.disposed) {
      return;
    }
    this.draining.add(projectKey);

    const drainLoop = async (): Promise<void> => {
      while (!this.disposed) {
        const queue = this.queues.get(projectKey);
        if (!queue || queue.length === 0) {
          break;
        }

        const chatId = this.projectResolver.resolve(projectKey);
        if (!chatId) {
          // Project removed — reject all queued messages
          for (const entry of queue) {
            entry.resolve({ ok: false, error: `Project not found: ${projectKey}` });
          }
          this.queues.delete(projectKey);
          break;
        }

        const agent = this.agentPool.get(chatId);
        if (!agent) {
          // Agent was disposed — reject remaining
          for (const entry of queue) {
            entry.resolve({ ok: false, error: `Agent not found for chatId: ${chatId}` });
          }
          this.queues.delete(projectKey);
          break;
        }

        if (this.isAgentBusy(agent)) {
          // Wait for taskComplete to settle, then retry
          try {
            await agent.taskComplete;
          } catch {
            // Task failed, but agent should be idle now
          }
          continue;
        }

        // Agent is idle — deliver next message
        const entry = queue.shift();
        if (entry) {
          this.deliver(agent, chatId, entry.message);
          entry.resolve({ ok: true, chatId });
        }
      }

      this.draining.delete(projectKey);
    };

    drainLoop().catch((err) => {
      this.log.error({ err, projectKey }, 'Drain loop error');
      this.draining.delete(projectKey);
    });
  }

  /**
   * Deliver a message to a ChatAgent via processMessage().
   *
   * Does not modify the ChatAgent.processMessage() signature —
   * the payload is passed as the text parameter.
   */
  private deliver(agent: ChatAgent, chatId: string, message: NonUserMessage): void {
    agent.processMessage(chatId, message.payload, message.id);
  }

  /**
   * Check if an agent is currently busy processing a task.
   *
   * An agent is considered busy if it has an unsettled taskComplete promise.
   */
  private isAgentBusy(agent: ChatAgent): boolean {
    if (!agent.taskComplete) {
      return false;
    }

    // Check if the promise is settled by inspecting a flag
    // Since we can't synchronously inspect Promise state,
    // we use a race-based approach with a settled flag
    return !isPromiseSettled(agent.taskComplete);
  }

  /**
   * Get the number of queued messages for a projectKey.
   * Useful for testing and monitoring.
   *
   * @param projectKey - The project key
   * @returns Number of queued messages
   */
  getQueueSize(projectKey: string): number {
    return this.queues.get(projectKey)?.length ?? 0;
  }

  /**
   * Get all project keys that have queued messages.
   * Useful for testing and monitoring.
   *
   * @returns Array of project keys with pending messages
   */
  getQueuedProjectKeys(): string[] {
    return Array.from(this.queues.entries())
      .filter(([, queue]) => queue.length > 0)
      .map(([key]) => key);
  }

  /**
   * Dispose the router. Rejects all queued messages.
   */
  dispose(): void {
    this.disposed = true;

    // Reject all queued messages
    for (const [, queue] of this.queues.entries()) {
      for (const entry of queue) {
        entry.resolve({ ok: false, error: 'Router has been disposed' });
      }
    }
    this.queues.clear();
    this.draining.clear();

    this.log.info('NonUserMessageRouter disposed');
  }
}

// ============================================================================
// Promise State Utility
// ============================================================================

/**
 * Track settlement state of agent taskComplete promises.
 * Maps agent instance → settled flag.
 */
const settledPromises = new WeakMap<Promise<unknown>, boolean>();

/**
 * Check if a promise has settled (resolved or rejected).
 */
function isPromiseSettled(promise: Promise<unknown>): boolean {
  const settled = settledPromises.get(promise);
  if (settled) {
    return true;
  }

  // Attach a then/catch to detect settlement
  promise.then(
    () => settledPromises.set(promise, true),
    () => settledPromises.set(promise, true),
  );

  return false;
}
