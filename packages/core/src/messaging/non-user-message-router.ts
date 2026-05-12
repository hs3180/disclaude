/**
 * NonUserMessageRouter — Routes system-driven messages to project-bound ChatAgents.
 *
 * When a NonUserMessage is routed:
 * 1. Project binding is looked up via injected ProjectLookupFn
 * 2. ChatAgent is obtained via injected AgentFactoryFn
 * 3. Message payload is delivered to the agent via processMessage()
 * 4. If the agent is busy, message is enqueued per-chatId with priority ordering
 *
 * Issue #3331: NonUserMessage type definition and routing layer.
 * Issue #3333: Scheduler integration with NonUserMessage.
 *
 * @module @disclaude/core/messaging
 */

import { createLogger } from '../utils/logger.js';
import type {
  NonUserMessage,
  NonUserMessageRouteResult,
  ProjectLookupFn,
  NonUserMessagePriority,
} from '../types/non-user-message.js';
import type { ChatAgent } from '../agents/types.js';
import type { SchedulerCallbacks } from '../scheduling/scheduler.js';

const logger = createLogger('NonUserMessageRouter');

/**
 * Function type for creating or obtaining ChatAgent instances.
 *
 * @param chatId - Chat ID for the target agent
 * @param callbacks - Callbacks for sending messages
 * @returns A ChatAgent instance (caller must NOT dispose — router manages lifecycle)
 */
export type AgentFactoryFn = (
  chatId: string,
  callbacks: SchedulerCallbacks,
) => ChatAgent;

/**
 * Optional callback when routing fails.
 */
export type RouteErrorNotifier = (
  message: NonUserMessage,
  error: string,
) => Promise<void>;

/**
 * NonUserMessageRouter options.
 */
export interface NonUserMessageRouterOptions {
  /** Function to look up project bindings by project key */
  projectLookup: ProjectLookupFn;
  /** Factory to create or obtain ChatAgent instances */
  agentFactory: AgentFactoryFn;
  /** Callbacks for sending messages */
  callbacks: SchedulerCallbacks;
  /** Optional callback when routing fails */
  onError?: RouteErrorNotifier;
}

/**
 * Queued message entry with priority ordering.
 */
interface QueuedMessage {
  message: NonUserMessage;
  enqueuedAt: number;
}

/** Priority sort order: high > normal > low */
const PRIORITY_ORDER: Record<NonUserMessagePriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * NonUserMessageRouter — Routes system-driven messages to ChatAgents.
 *
 * Design:
 * - Dependency injection for project lookup and agent creation
 * - Per-chatId message queue with priority ordering
 * - Async fire-and-forget delivery: `route()` returns immediately
 * - Queue is drained automatically when the current delivery completes
 */
export class NonUserMessageRouter {
  private projectLookup: ProjectLookupFn;
  private agentFactory: AgentFactoryFn;
  private callbacks: SchedulerCallbacks;
  private onError?: RouteErrorNotifier;

  /** Per-chatId message queues */
  private queues: Map<string, QueuedMessage[]> = new Map();
  /** Set of chatIds currently processing a message */
  private processing: Set<string> = new Set();

  constructor(options: NonUserMessageRouterOptions) {
    this.projectLookup = options.projectLookup;
    this.agentFactory = options.agentFactory;
    this.callbacks = options.callbacks;
    this.onError = options.onError;

    logger.info('NonUserMessageRouter initialized');
  }

  /**
   * Route a NonUserMessage to the appropriate ChatAgent.
   *
   * Returns immediately after validation and queuing.
   * Actual delivery happens asynchronously.
   */
  async route(message: NonUserMessage): Promise<NonUserMessageRouteResult> {
    // Look up project binding
    let binding;
    try {
      binding = await this.projectLookup(message.projectKey);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, projectKey: message.projectKey }, 'Project lookup failed');
      const result: NonUserMessageRouteResult = { routed: false, error: errMsg };
      await this.notifyError(message, errMsg);
      return result;
    }

    if (!binding) {
      const errMsg = `No project binding found for key: ${message.projectKey}`;
      logger.warn({ projectKey: message.projectKey }, errMsg);
      const result: NonUserMessageRouteResult = { routed: false, error: errMsg };
      await this.notifyError(message, errMsg);
      return result;
    }

    const { chatId } = binding;

    // If agent for this chatId is busy, enqueue the message
    if (this.processing.has(chatId)) {
      this.enqueue(chatId, message);
      logger.info(
        { chatId, messageId: message.id, queueSize: this.queues.get(chatId)?.length ?? 0 },
        'Agent busy, message enqueued',
      );
      return { routed: true, chatId };
    }

    // Deliver immediately
    this.processing.add(chatId);
    // Fire-and-forget: don't await delivery
    void this.deliver(chatId, message);

    return { routed: true, chatId };
  }

  /**
   * Get the queue size for a chatId.
   */
  getQueueSize(chatId: string): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  /**
   * Clear all queued messages for a chatId.
   */
  clearQueue(chatId: string): void {
    this.queues.delete(chatId);
  }

  /**
   * Get all chatIds that have active queues.
   */
  getQueuedChatIds(): string[] {
    return Array.from(this.queues.keys()).filter(id => (this.queues.get(id)?.length ?? 0) > 0);
  }

  /**
   * Enqueue a message for a chatId.
   * Messages are sorted by priority (high > normal > low).
   */
  private enqueue(chatId: string, message: NonUserMessage): void {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, []);
    }
    const queue = this.queues.get(chatId);
    if (!queue) { return; }
    queue.push({ message, enqueuedAt: Date.now() });
    queue.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.message.priority];
      const pb = PRIORITY_ORDER[b.message.priority];
      if (pa !== pb) { return pb - pa; }
      return a.enqueuedAt - b.enqueuedAt;
    });
  }

  /**
   * Deliver a message to a ChatAgent and drain the queue afterward.
   */
  private async deliver(chatId: string, message: NonUserMessage): Promise<void> {
    try {
      const agent = this.agentFactory(chatId, this.callbacks);
      const messageId = `system:${message.id}`;

      logger.info(
        { chatId, messageId: message.id, source: message.source },
        'Delivering NonUserMessage to agent',
      );

      await agent.runOnce(chatId, message.payload, messageId);
    } catch (error) {
      logger.error(
        { err: error, chatId, messageId: message.id },
        'Failed to deliver NonUserMessage',
      );
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.notifyError(message, errMsg);
    } finally {
      this.processing.delete(chatId);
      // Drain queue for this chatId
      await this.drainQueue(chatId);
    }
  }

  /**
   * Drain the next queued message for a chatId.
   */
  private async drainQueue(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) {
      this.queues.delete(chatId);
      return;
    }

    const entry = queue.shift();
    if (!entry) { return; }
    if (queue.length === 0) {
      this.queues.delete(chatId);
    }

    this.processing.add(chatId);
    await this.deliver(chatId, entry.message);
  }

  /**
   * Notify error via onError callback.
   */
  private async notifyError(message: NonUserMessage, error: string): Promise<void> {
    if (this.onError) {
      try {
        await this.onError(message, error);
      } catch (err) {
        logger.error({ err }, 'Error notifier failed');
      }
    }
  }
}
