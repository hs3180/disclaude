/**
 * NonUserMessageRouter — routes system-driven messages to ChatAgent instances.
 *
 * Resolves the target ChatAgent via projectKey lookup, then delivers the
 * message payload. When the target agent is busy, messages are enqueued
 * per-chatId and processed sequentially.
 *
 * Routing flow:
 * ```
 * NonUserMessage → router.route()
 *   → projectLookup(projectKey) → { chatId, workingDir }
 *   → agentFactory(chatId) → ChatAgent
 *   → agent.processMessage(chatId, payload, 'system:{id}')
 *   → await agent.taskComplete  (if agent is processing)
 *   → drain queue for chatId
 * ```
 *
 * @see Issue #3331 (NonUserMessage type definition and routing layer)
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type { ChatAgent } from '../agents/types.js';
import type {
  NonUserMessage,
  NonUserMessageRouteResult,
  ProjectBinding,
} from '../types/non-user-message.js';

const defaultLogger = createLogger('NonUserMessageRouter');

// ============================================================================
// Dependency Interfaces
// ============================================================================

/**
 * Project lookup function — resolves projectKey to a binding.
 *
 * Can be backed by ProjectManager, a simple Map, or any async source.
 */
export type ProjectLookupFn = (projectKey: string) => ProjectBinding | null | Promise<ProjectBinding | null>;

/**
 * Agent factory — creates or retrieves a ChatAgent for a given chatId.
 */
export type AgentFactoryFn = (chatId: string) => ChatAgent;

/**
 * Error notification callback — called when routing fails.
 */
export type ErrorNotifierFn = (chatId: string, message: string) => Promise<void>;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for NonUserMessageRouter.
 */
export interface NonUserMessageRouterOptions {
  /** Resolves projectKey → { chatId, workingDir } */
  projectLookup: ProjectLookupFn;

  /** Creates or retrieves a ChatAgent for a chatId */
  agentFactory: AgentFactoryFn;

  /** Sends error notifications (optional — failures are logged if not provided) */
  errorNotifier?: ErrorNotifierFn;

  /** Custom logger */
  logger?: Logger;
}

// ============================================================================
// Internal Types
// ============================================================================

/** Priority ordering for queue processing. */
const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

// ============================================================================
// NonUserMessageRouter
// ============================================================================

/**
 * Routes NonUserMessages to the appropriate ChatAgent via project config lookup.
 *
 * Features:
 * - Project-based routing: resolves projectKey to chatId
 * - Message queuing: per-chatId FIFO with priority ordering
 * - Sequential processing: one message per chatId at a time
 * - Error handling: logs failures and optionally notifies
 *
 * Design: `route()` returns immediately after marking the chatId as "processing".
 * The actual delivery happens asynchronously — the router awaits the agent's
 * `taskComplete` promise before draining the queue for that chatId. This ensures
 * messages for the same chatId are processed sequentially without blocking the
 * caller.
 *
 * @example
 * ```typescript
 * const router = new NonUserMessageRouter({
 *   projectLookup: (key) => projectBindings.get(key) ?? null,
 *   agentFactory: (chatId) => agentPool.getOrCreateChatAgent(chatId),
 *   errorNotifier: async (chatId, msg) => channel.sendText(chatId, msg),
 * });
 *
 * // Register project bindings externally
 * projectBindings.set('hs3180/disclaude', { chatId: 'oc_xxx', workingDir: '/repo' });
 *
 * // Route a message
 * await router.route({
 *   id: 'msg-1',
 *   type: 'scheduled',
 *   source: 'scheduler:daily-sync',
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'Run daily sync',
 *   priority: 'normal',
 *   createdAt: new Date().toISOString(),
 * });
 * ```
 */
export class NonUserMessageRouter {
  private readonly projectLookup: ProjectLookupFn;
  private readonly agentFactory: AgentFactoryFn;
  private readonly errorNotifier?: ErrorNotifierFn;
  private readonly log: Logger;

  /** Per-chatId message queues */
  private readonly queues = new Map<string, NonUserMessage[]>();

  /** ChatIds currently being processed */
  private readonly processing = new Set<string>();

  constructor(options: NonUserMessageRouterOptions) {
    this.projectLookup = options.projectLookup;
    this.agentFactory = options.agentFactory;
    this.errorNotifier = options.errorNotifier;
    this.log = options.logger ?? defaultLogger;
  }

  // ───────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────

  /**
   * Route a NonUserMessage to the appropriate ChatAgent.
   *
   * 1. Resolves projectKey → chatId via projectLookup
   * 2. If agent is busy (processing set), enqueues the message
   * 3. If agent is free, starts async delivery and returns immediately
   *
   * Returns as soon as the routing decision is made — the actual delivery
   * happens asynchronously in the background.
   *
   * @param message - The NonUserMessage to route
   * @returns RouteResult indicating success or failure
   */
  async route(message: NonUserMessage): Promise<NonUserMessageRouteResult> {
    // Step 1: Resolve projectKey to chatId
    const binding = await this.projectLookup(message.projectKey);
    if (!binding) {
      const error = `No project binding found for projectKey: ${message.projectKey}`;
      this.log.warn({ projectKey: message.projectKey, messageId: message.id }, error);
      return { ok: false, error };
    }

    const { chatId } = binding;
    this.log.info(
      { messageId: message.id, projectKey: message.projectKey, chatId, type: message.type },
      'Routing NonUserMessage'
    );

    // Step 2: If agent is busy, enqueue
    if (this.processing.has(chatId)) {
      this.enqueueMessage(chatId, message);
      this.log.debug({ chatId, messageId: message.id }, 'Agent busy — message enqueued');
      return { ok: true, chatId };
    }

    // Step 3: Mark as processing and start async delivery
    this.processing.add(chatId);
    this.deliverAndDrain(chatId, message).catch((err) => {
      // Safety net — errors are handled inside deliverAndDrain
      this.log.error({ err, chatId }, 'Unexpected error in delivery chain');
    });

    return { ok: true, chatId };
  }

  /**
   * Enqueue a message for a projectKey without immediate delivery attempt.
   *
   * Useful for batch scheduling where messages should wait for explicit processing.
   *
   * @param projectKey - Target project key
   * @param message - The NonUserMessage to enqueue
   * @returns true if the project binding was found, false otherwise
   */
  async enqueue(projectKey: string, message: NonUserMessage): Promise<boolean> {
    const binding = await this.projectLookup(projectKey);
    if (!binding) {
      this.log.warn({ projectKey, messageId: message.id }, 'Cannot enqueue — no project binding');
      return false;
    }

    this.enqueueMessage(binding.chatId, message);
    this.log.debug({ chatId: binding.chatId, messageId: message.id }, 'Message enqueued');
    return true;
  }

  /**
   * Process all queued messages for a chatId.
   *
   * Called internally after each message delivery to drain the queue.
   * Can also be called externally to trigger queue processing.
   *
   * @param chatId - Chat ID to process
   */
  async processQueue(chatId: string): Promise<void> {
    if (this.processing.has(chatId)) {
      return; // Already processing
    }

    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) {
      return;
    }

    // Sort by priority before processing
    queue.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));

    // Process one message: dequeue, mark processing, deliver async
    const message = queue.shift();
    if (!message) {
      this.queues.delete(chatId);
      return;
    }

    this.processing.add(chatId);
    await this.deliverAndDrain(chatId, message);
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * Check if a chatId currently has a message being processed.
   */
  isProcessing(chatId: string): boolean {
    return this.processing.has(chatId);
  }

  /**
   * Get the number of queued messages for a chatId.
   */
  getQueueSize(chatId: string): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  /**
   * Get all chatIds that have queued messages.
   */
  getQueuedChatIds(): string[] {
    return Array.from(this.queues.entries())
      .filter(([, queue]) => queue.length > 0)
      .map(([chatId]) => chatId);
  }

  /**
   * Clear all queued messages (for shutdown or testing).
   */
  clearQueues(): void {
    this.queues.clear();
  }

  // ───────────────────────────────────────────
  // Internal Methods
  // ───────────────────────────────────────────

  /**
   * Add a message to the per-chatId queue.
   */
  private enqueueMessage(chatId: string, message: NonUserMessage): void {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = [];
      this.queues.set(chatId, queue);
    }
    queue.push(message);
  }

  /**
   * Deliver a message to a ChatAgent and drain the queue afterwards.
   *
   * This is the core delivery loop:
   * 1. Call `agent.processMessage()` (fire-and-forget, returns void)
   * 2. Wait for `agent.taskComplete` to resolve (agent finishes processing)
   * 3. Remove from processing set
   * 4. Drain the queue for this chatId
   */
  private async deliverAndDrain(chatId: string, message: NonUserMessage): Promise<void> {
    try {
      const agent = this.agentFactory(chatId);
      agent.processMessage(chatId, message.payload, `system:${message.id}`);
      this.log.info({ chatId, messageId: message.id }, 'NonUserMessage delivered to ChatAgent');

      // Wait for agent to finish processing before delivering next message
      if (agent.taskComplete) {
        await agent.taskComplete;
      }
    } catch (err) {
      this.log.error({ err, chatId, messageId: message.id }, 'Failed to deliver NonUserMessage');

      // Notify via error callback if available
      if (this.errorNotifier) {
        try {
          await this.errorNotifier(
            chatId,
            `Failed to deliver system message: ${err instanceof Error ? err.message : String(err)}`
          );
        } catch (notifyErr) {
          this.log.error({ err: notifyErr }, 'Error notifier failed');
        }
      }
    } finally {
      this.processing.delete(chatId);

      // Drain the queue for this chatId
      await this.drainQueue(chatId);
    }
  }

  /**
   * Drain all queued messages for a chatId sequentially.
   */
  private async drainQueue(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) {
      this.queues.delete(chatId);
      return;
    }

    // Sort by priority
    queue.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));

    // Process messages one at a time
    while (queue.length > 0) {
      const message = queue.shift();
      if (!message) {break;}
      await this.deliverAndDrain(chatId, message);
    }

    this.queues.delete(chatId);
  }
}
