/**
 * MessageRouter — Unified routing for all Message types.
 *
 * Routes UserMessage, SystemMessage, and AgentMessage to ChatAgent instances
 * via project config lookup and AgentPool management.
 *
 * Routing logic:
 * - UserMessage: chatId from message → AgentPool.getOrCreate(chatId)
 * - SystemMessage with projectKey: project config → bound chatId → AgentPool.getOrCreate(chatId)
 * - SystemMessage without projectKey: fallback chatId → AgentPool.getOrCreate(chatId)
 * - AgentMessage: project config → bound chatId → AgentPool.getOrCreate(chatId)
 *
 * Queuing:
 * When the target ChatAgent is busy (processing another message), incoming
 * SystemMessage/AgentMessage are queued per chatId. When the agent finishes,
 * queued messages are delivered in priority order.
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3331 (Phase 1: Type definition and routing layer)
 */

import { createLogger, type Logger } from '../utils/logger.js';
import {
  isUserMessage,
  isSystemMessage,
  isAgentMessage,
  type Message,
  type UserMessage,
  type SystemMessage,
  type AgentMessage,
  type NonUserMessage,
  type MessagePriority,
} from './message-types.js';

const defaultLogger = createLogger('MessageRouter');

// ============================================================================
// Dependencies (Decoupled Interfaces)
// ============================================================================

/**
 * Resolves project configuration by projectKey.
 *
 * Implemented by ProjectManager or a thin adapter in the wiring layer.
 * This interface keeps MessageRouter decoupled from ProjectManager internals.
 */
export interface ProjectResolver {
  /**
   * Resolve a projectKey to its bound chatId and working directory.
   *
   * @param projectKey - The project identifier (e.g., 'hs3180/disclaude')
   * @returns Project resolution result, or null if not found
   */
  resolve(projectKey: string): ProjectResolution | null;
}

/**
 * Result of resolving a projectKey.
 */
export interface ProjectResolution {
  /** Bound chat ID — agent replies go here */
  chatId: string;
  /** Project working directory — agent's cwd */
  workingDir: string;
}

/**
 * Minimal ChatAgent interface needed by the router.
 *
 * Decoupled from the concrete ChatAgent class to keep router testable.
 */
export interface RoutableAgent {
  /**
   * Process a message (non-blocking — starts processing, returns immediately).
   */
  processMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string
  ): void;

  /**
   * Promise that resolves when the current task completes.
   * Used by the router to know when to deliver queued messages.
   */
  readonly taskComplete?: Promise<void>;
}

/**
 * Minimal AgentPool interface needed by the router.
 *
 * Decoupled from the concrete AgentPool class to keep router testable.
 */
export interface RoutableAgentPool {
  /**
   * Get or create an agent for the given chatId.
   */
  getOrCreate(chatId: string): RoutableAgent;

  /**
   * Check if an agent exists for the given chatId.
   */
  has(chatId: string): boolean;
}

// ============================================================================
// Queue Types
// ============================================================================

/**
 * Queued message entry with metadata.
 */
interface QueuedMessage {
  /** The message to deliver */
  message: NonUserMessage;
  /** Fallback chatId (for SystemMessage without projectKey) */
  fallbackChatId?: string;
  /** Enqueue timestamp for ordering */
  enqueuedAt: number;
}

// ============================================================================
// Router Configuration
// ============================================================================

/**
 * Configuration for MessageRouter.
 */
export interface MessageRouterOptions {
  /** Agent pool for getting/creating ChatAgent instances */
  agentPool: RoutableAgentPool;
  /** Project resolver for looking up project config by key */
  projectResolver?: ProjectResolver;
  /** Fallback chatId for SystemMessage without projectKey */
  fallbackChatId?: string;
  /** Logger (optional — uses default if omitted) */
  logger?: Logger;
}

// ============================================================================
// MessageRouter
// ============================================================================

/**
 * MessageRouter — Unified routing for all Message types.
 *
 * Routes messages to ChatAgent instances based on message source:
 * - UserMessage → chatId from message
 * - SystemMessage → chatId from project config (or fallback)
 * - AgentMessage → chatId from project config
 *
 * Implements per-chatId message queuing for SystemMessage/AgentMessage
 * when the target agent is busy processing another message.
 *
 * @example
 * ```typescript
 * const router = new MessageRouter({
 *   agentPool: myAgentPool,
 *   projectResolver: myProjectResolver,
 *   fallbackChatId: 'oc_default',
 * });
 *
 * // Route a user message
 * await router.route(userMessage);
 *
 * // Route a system message (scheduled task)
 * await router.route(systemMessage);
 * ```
 */
export class MessageRouter {
  private readonly agentPool: RoutableAgentPool;
  private readonly projectResolver?: ProjectResolver;
  private readonly fallbackChatId?: string;
  private readonly log: Logger;

  /** Per-chatId message queue for busy agents */
  private readonly messageQueues: Map<string, QueuedMessage[]> = new Map();

  /** Track which chatIds have an active delivery loop */
  private readonly activeDeliveries: Set<string> = new Set();

  constructor(options: MessageRouterOptions) {
    this.agentPool = options.agentPool;
    this.projectResolver = options.projectResolver;
    this.fallbackChatId = options.fallbackChatId;
    this.log = options.logger ?? defaultLogger;
  }

  /**
   * Route a message to the appropriate ChatAgent.
   *
   * For UserMessage: chatId comes from the message itself.
   * For SystemMessage/AgentMessage: chatId is resolved from project config.
   *
   * If the target agent is busy, SystemMessage/AgentMessage are queued
   * and delivered when the agent finishes its current task.
   *
   * @param message - The message to route
   * @throws Error if chatId cannot be resolved
   */
  route(message: Message): Promise<void> {
    try {
      if (isUserMessage(message)) {
        this.routeUserMessage(message);
        return Promise.resolve();
      }

      if (isSystemMessage(message)) {
        this.routeSystemMessage(message);
        return Promise.resolve();
      }

      if (isAgentMessage(message)) {
        this.routeAgentMessage(message);
        return Promise.resolve();
      }

      // Fallback for unknown sources (should be unreachable with exhaustive source types)
      return Promise.reject(new Error(`Unknown message source: ${(message as { source: string }).source}`));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Enqueue a NonUserMessage for a specific project.
   *
   * Convenience method that combines project resolution with routing.
   * If the target agent is busy, the message waits in queue.
   *
   * @param projectKey - Target project identifier
   * @param message - The message to enqueue
   */
  enqueue(projectKey: string, message: NonUserMessage): void {
    const resolution = this.resolveProject(projectKey);
    if (!resolution) {
      this.log.warn({ projectKey }, 'Cannot enqueue — project not found');
      return;
    }

    const queueEntry: QueuedMessage = {
      message,
      enqueuedAt: Date.now(),
    };

    this.enqueueForChatId(resolution.chatId, queueEntry);
  }

  /**
   * Get the number of queued messages for a chatId.
   *
   * @param chatId - Chat identifier
   * @returns Number of queued messages
   */
  getQueueSize(chatId: string): number {
    return this.messageQueues.get(chatId)?.length ?? 0;
  }

  /**
   * Get all chatIds that have queued messages.
   *
   * @returns Array of chatIds with pending messages
   */
  getQueuedChatIds(): string[] {
    return Array.from(this.messageQueues.keys())
      .filter(chatId => (this.messageQueues.get(chatId)?.length ?? 0) > 0);
  }

  // ───────────────────────────────────────────
  // Private: Route by Message Type
  // ───────────────────────────────────────────

  /**
   * Route a UserMessage — chatId from message, always delivered immediately.
   */
  private routeUserMessage(message: UserMessage): void {
    const { chatId } = message;
    this.log.info({ chatId, messageId: message.id }, 'Routing UserMessage');

    const agent = this.agentPool.getOrCreate(chatId);
    agent.processMessage(chatId, message.payload, message.messageId, message.senderOpenId);
  }

  /**
   * Route a SystemMessage — chatId from project config or fallback.
   */
  private routeSystemMessage(message: SystemMessage): void {
    const chatId = this.resolveChatIdForSystemMessage(message);
    if (!chatId) {
      this.log.error(
        { messageId: message.id, trigger: message.trigger, projectKey: message.projectKey },
        'Cannot route SystemMessage — no chatId resolved (no projectKey and no fallback)'
      );
      throw new Error(
        'Cannot route SystemMessage: no projectKey specified and no fallbackChatId configured'
      );
    }

    this.log.info(
      { chatId, messageId: message.id, trigger: message.trigger, projectKey: message.projectKey },
      'Routing SystemMessage'
    );

    this.deliverOrEnqueue(chatId, message);
  }

  /**
   * Route an AgentMessage — chatId from project config.
   */
  private routeAgentMessage(message: AgentMessage): void {
    if (!message.projectKey) {
      this.log.error(
        { messageId: message.id, fromChatId: message.fromChatId },
        'Cannot route AgentMessage — no projectKey specified'
      );
      throw new Error('Cannot route AgentMessage: projectKey is required');
    }

    const resolution = this.resolveProject(message.projectKey);
    if (!resolution) {
      this.log.error(
        { messageId: message.id, projectKey: message.projectKey },
        'Cannot route AgentMessage — project not found'
      );
      throw new Error(`Cannot route AgentMessage: project "${message.projectKey}" not found`);
    }

    this.log.info(
      { chatId: resolution.chatId, messageId: message.id, projectKey: message.projectKey },
      'Routing AgentMessage'
    );

    this.deliverOrEnqueue(resolution.chatId, message);
  }

  // ───────────────────────────────────────────
  // Private: ChatId Resolution
  // ───────────────────────────────────────────

  /**
   * Resolve chatId for a SystemMessage.
   *
   * Priority:
   * 1. projectKey → resolve from project config
   * 2. fallbackChatId (legacy backward compatibility)
   */
  private resolveChatIdForSystemMessage(message: SystemMessage): string | null {
    // Try project resolution first
    if (message.projectKey) {
      const resolution = this.resolveProject(message.projectKey);
      if (resolution) {
        return resolution.chatId;
      }
      this.log.warn(
        { projectKey: message.projectKey },
        'Project not found, falling back to fallbackChatId'
      );
    }

    // Fall back to configured fallback
    if (this.fallbackChatId) {
      return this.fallbackChatId;
    }

    return null;
  }

  /**
   * Resolve a projectKey using the project resolver.
   */
  private resolveProject(projectKey: string): ProjectResolution | null {
    if (!this.projectResolver) {
      this.log.warn('No project resolver configured');
      return null;
    }
    return this.projectResolver.resolve(projectKey);
  }

  // ───────────────────────────────────────────
  // Private: Delivery & Queuing
  // ───────────────────────────────────────────

  /**
   * Deliver a message immediately or enqueue if agent is busy.
   */
  private deliverOrEnqueue(chatId: string, message: NonUserMessage): void {
    const agent = this.agentPool.getOrCreate(chatId);

    // Check if agent is busy (has an active delivery)
    if (this.activeDeliveries.has(chatId)) {
      // Agent is busy — enqueue the message
      this.log.info({ chatId, messageId: message.id }, 'Agent busy — enqueueing message');
      this.enqueueForChatId(chatId, {
        message,
        enqueuedAt: Date.now(),
      });
      return;
    }

    this.deliverToAgent(chatId, agent, message);
  }

  /**
   * Deliver a message to an agent and set up drain handler for queued messages.
   *
   * Non-blocking: calls processMessage() and sets up a .then() handler
   * on taskComplete to drain the queue when the agent finishes.
   */
  private deliverToAgent(
    chatId: string,
    agent: RoutableAgent,
    message: NonUserMessage
  ): void {
    this.activeDeliveries.add(chatId);

    // Deliver the message (non-blocking — processMessage returns void)
    agent.processMessage(chatId, message.payload, message.id);

    // Set up handler to drain queue when agent finishes
    const onDone = (): void => {
      this.activeDeliveries.delete(chatId);
      this.drainQueue(chatId);
    };

    if (agent.taskComplete) {
      // Drain queue when task finishes (success or failure)
      agent.taskComplete.then(onDone, (err: unknown) => {
        this.log.error({ err, chatId }, 'Agent task failed');
        onDone();
      });
    } else {
      // No taskComplete — agent finished immediately
      onDone();
    }
  }

  /**
   * Enqueue a message for a specific chatId.
   *
   * Messages are inserted in priority order (high → normal → low),
   * then by enqueue time (FIFO within same priority).
   */
  private enqueueForChatId(chatId: string, entry: QueuedMessage): void {
    let queue = this.messageQueues.get(chatId);
    if (!queue) {
      queue = [];
      this.messageQueues.set(chatId, queue);
    }

    // Insert in priority order
    const priorityOrder: Record<MessagePriority, number> = {
      high: 0,
      normal: 1,
      low: 2,
    };

    const msgPriority = this.getMessagePriority(entry.message);
    const priorityValue = priorityOrder[msgPriority];

    // Find insertion point (maintain priority + FIFO order)
    let insertIdx = queue.length;
    for (let i = 0; i < queue.length; i++) {
      const existingPriority = priorityOrder[this.getMessagePriority(queue[i].message)];
      if (priorityValue < existingPriority) {
        insertIdx = i;
        break;
      }
    }

    queue.splice(insertIdx, 0, entry);
    this.log.debug(
      { chatId, messageId: entry.message.id, queueSize: queue.length },
      'Message enqueued'
    );
  }

  /**
   * Drain the queue for a chatId — deliver the next queued message.
   */
  private drainQueue(chatId: string): void {
    const queue = this.messageQueues.get(chatId);
    if (!queue || queue.length === 0) {
      this.messageQueues.delete(chatId);
      return;
    }

    // Dequeue the next message (highest priority, FIFO)
    // Safe: queue length checked above
    const next = queue.shift() as QueuedMessage;
    if (queue.length === 0) {
      this.messageQueues.delete(chatId);
    }

    this.log.info(
      { chatId, messageId: next.message.id, remainingQueueSize: queue.length },
      'Draining queued message'
    );

    // Deliver asynchronously — don't block the current delivery
    const agent = this.agentPool.getOrCreate(chatId);
    void this.deliverToAgent(chatId, agent, next.message);
  }

  /**
   * Get the priority of a NonUserMessage.
   */
  private getMessagePriority(message: NonUserMessage): MessagePriority {
    if (isAgentMessage(message)) {
      return message.priority;
    }
    // SystemMessage defaults to 'normal' priority
    return 'normal';
  }
}
