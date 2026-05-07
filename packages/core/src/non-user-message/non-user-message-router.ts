/**
 * NonUserMessageRouter — routes system-driven messages to ChatAgent instances.
 *
 * The router is the core of the NonUserMessage pipeline:
 * 1. Receives a NonUserMessage
 * 2. Looks up project config → bound chatId via IProjectRoutingProvider
 * 3. Gets/creates ChatAgent for that chatId via IAgentMessageDelivery
 * 4. Delivers message payload (or queues if agent is busy)
 *
 * Design principles:
 * - No modification to ChatAgent.processMessage() signature
 * - Messages queue when target agent is busy (per-project queue)
 * - Priority ordering within each project's queue
 * - Backpressure: if queue is full, reject with error
 *
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type {
  NonUserMessage,
  NonUserMessagePriority,
  ProjectRoutingConfig,
  RouteResult,
  IProjectRoutingProvider,
  IAgentMessageDelivery,
} from './types.js';

const defaultLogger = createLogger('NonUserMessageRouter');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Priority Ordering
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Numeric priority values for sorting.
 * Higher number = higher priority = processed first.
 */
const PRIORITY_WEIGHT: Record<NonUserMessagePriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * Compare two messages by priority (descending — highest priority first).
 */
function compareByPriority(a: NonUserMessage, b: NonUserMessage): number {
  return PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Per-project Message Queue
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Internal per-project message queue.
 *
 * Maintains priority ordering and tracks processing state.
 * When the agent is busy, messages accumulate in the queue.
 * When the agent becomes available, the highest-priority message
 * is delivered next.
 */
class ProjectMessageQueue {
  private queue: NonUserMessage[] = [];
  private processing = false;

  constructor(
    private readonly projectKey: string,
    private readonly delivery: IAgentMessageDelivery,
    private readonly chatId: string,
    private readonly log: Logger,
  ) {}

  /**
   * Get the number of queued messages (not yet delivered).
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Whether a message is currently being processed.
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Enqueue a message and attempt to process the queue.
   *
   * If not currently processing, starts processing immediately.
   * If already processing, the message will be picked up after
   * the current message completes.
   */
  enqueue(message: NonUserMessage): void {
    this.queue.push(message);
    // Maintain priority ordering
    this.queue.sort(compareByPriority);
    this.log.debug(
      { projectKey: this.projectKey, queueSize: this.queue.length, messageId: message.id },
      'Message enqueued',
    );
    this.processNext();
  }

  /**
   * Process the next message in the queue if not already processing.
   */
  private processNext(): void {
    if (this.processing) {
      return;
    }

    const message = this.queue.shift();
    if (!message) {
      return;
    }

    this.processing = true;
    this.log.info(
      { projectKey: this.projectKey, messageId: message.id, type: message.type },
      'Delivering NonUserMessage to ChatAgent',
    );

    try {
      this.delivery.deliverMessage(this.chatId, message.payload);
    } catch (err) {
      this.log.error(
        { err, projectKey: this.projectKey, messageId: message.id },
        'Failed to deliver NonUserMessage',
      );
    } finally {
      this.processing = false;
      // Process next message in queue (if any)
      this.processNext();
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessageRouter Configuration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Configuration for NonUserMessageRouter.
 */
export interface NonUserMessageRouterConfig {
  /** Provider for looking up project routing configuration */
  projectRoutingProvider: IProjectRoutingProvider;
  /** Delivery mechanism for sending messages to ChatAgents */
  agentMessageDelivery: IAgentMessageDelivery;
  /** Maximum queue size per project (default: 100) */
  maxQueueSize?: number;
  /** Optional logger */
  logger?: Logger;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessageRouter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * NonUserMessageRouter — routes NonUserMessages to the appropriate ChatAgent.
 *
 * Routing flow:
 * ```
 * NonUserMessage → route()
 *   → projectRoutingProvider.getRoutingConfig(projectKey)
 *   → { chatId, workingDir }
 *   → agentMessageDelivery.deliverMessage(chatId, payload)
 * ```
 *
 * If the target ChatAgent is busy processing another message,
 * the new message waits in a per-project priority queue.
 */
export class NonUserMessageRouter {
  private readonly projectRoutingProvider: IProjectRoutingProvider;
  private readonly agentMessageDelivery: IAgentMessageDelivery;
  private readonly maxQueueSize: number;
  private readonly log: Logger;

  /** Per-project message queues (keyed by project key) */
  private readonly queues = new Map<string, ProjectMessageQueue>();

  constructor(config: NonUserMessageRouterConfig) {
    this.projectRoutingProvider = config.projectRoutingProvider;
    this.agentMessageDelivery = config.agentMessageDelivery;
    this.maxQueueSize = config.maxQueueSize ?? 100;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Route a NonUserMessage to the appropriate ChatAgent.
   *
   * Looks up project config → finds bound chatId → delivers message.
   * If the agent is busy, the message is queued for later delivery.
   *
   * @param message - The NonUserMessage to route
   * @returns RouteResult indicating success or failure
   */
  route(message: NonUserMessage): RouteResult {
    this.log.info(
      { messageId: message.id, projectKey: message.projectKey, type: message.type },
      'Routing NonUserMessage',
    );

    // Step 1: Look up project routing configuration
    const routingConfig = this.projectRoutingProvider.getRoutingConfig(message.projectKey);
    if (!routingConfig) {
      this.log.warn(
        { projectKey: message.projectKey, messageId: message.id },
        'Project not found for routing',
      );
      return { ok: false, error: `Project "${message.projectKey}" not found` };
    }

    // Step 2: Validate routing config
    if (!routingConfig.chatId) {
      this.log.warn(
        { projectKey: message.projectKey, messageId: message.id },
        'Project has no bound chatId',
      );
      return { ok: false, error: `Project "${message.projectKey}" has no bound chatId` };
    }

    // Step 3: Enqueue (or deliver immediately via queue)
    return this.enqueueInternal(message, routingConfig);
  }

  /**
   * Enqueue a NonUserMessage for a project without requiring project lookup.
   *
   * Useful when the caller already knows the target project configuration.
   *
   * @param projectKey - Target project key
   * @param message - The NonUserMessage to enqueue
   * @returns RouteResult indicating success or failure
   */
  enqueue(projectKey: string, message: NonUserMessage): RouteResult {
    const routingConfig = this.projectRoutingProvider.getRoutingConfig(projectKey);
    if (!routingConfig) {
      return { ok: false, error: `Project "${projectKey}" not found` };
    }

    return this.enqueueInternal(message, routingConfig);
  }

  /**
   * Get the number of queued messages for a project.
   *
   * @param projectKey - Project key
   * @returns Number of queued messages, or 0 if no queue exists
   */
  getQueueSize(projectKey: string): number {
    return this.queues.get(projectKey)?.size ?? 0;
  }

  /**
   * Get all project keys that have active queues.
   *
   * @returns Array of project keys with pending messages
   */
  getActiveProjectKeys(): string[] {
    return Array.from(this.queues.entries())
      .filter(([, queue]) => queue.size > 0)
      .map(([key]) => key);
  }

  /**
   * Internal enqueue logic.
   *
   * Checks queue size limit, then gets or creates a per-project queue
   * and enqueues the message.
   */
  private enqueueInternal(
    message: NonUserMessage,
    routingConfig: ProjectRoutingConfig,
  ): RouteResult {
    // Note: ProjectRoutingConfig uses `key` not `projectKey`
    const projectKey = routingConfig.key;
    const {chatId} = routingConfig;

    // Get or create queue
    let queue = this.queues.get(projectKey);
    if (!queue) {
      queue = new ProjectMessageQueue(projectKey, this.agentMessageDelivery, chatId, this.log);
      this.queues.set(projectKey, queue);
    }

    // Check queue size limit
    if (queue.size >= this.maxQueueSize) {
      this.log.warn(
        { projectKey, queueSize: queue.size, maxQueueSize: this.maxQueueSize },
        'Queue full, rejecting message',
      );
      return { ok: false, error: `Queue full for project "${projectKey}" (max: ${this.maxQueueSize})` };
    }

    // Enqueue (this triggers processing if not busy)
    queue.enqueue(message);

    const queued = queue.size > 0;
    this.log.info(
      { projectKey, messageId: message.id, queueSize: queue.size, queued },
      'Message routed successfully',
    );

    return { ok: true, queued };
  }
}
