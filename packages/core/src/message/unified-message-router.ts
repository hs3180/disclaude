/**
 * UnifiedMessageRouter — RFC #3329 Phase 1.
 *
 * Routes all three Message types (UserMessage, SystemMessage, AgentMessage)
 * to the appropriate ChatAgent instance.
 *
 * Routing logic:
 * - UserMessage: chatId from message → AgentPool.getOrCreate(chatId)
 * - SystemMessage: projectKey → ProjectConfigResolver → chatId → AgentPool
 * - AgentMessage: projectKey → ProjectConfigResolver → chatId → AgentPool
 *
 * When the target agent is busy processing another message, incoming messages
 * are queued per chatId and delivered sequentially.
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 */

import type {
  Message,
  UserMessage,
  SystemMessage,
  AgentMessage,
} from '../types/unified-message.js';
import { isUserMessage, isSystemMessage, isAgentMessage } from '../types/unified-message.js';
import { createLogger, type Logger } from '../utils/logger.js';

const defaultLogger = createLogger('UnifiedMessageRouter');

// ============================================================================
// Dependency Interfaces
// ============================================================================

/**
 * Minimal interface for ChatAgent that the router needs.
 *
 * This decouples the router from the concrete ChatAgent implementation.
 * The router does NOT modify the ChatAgent.processMessage() signature.
 */
export interface RouteableAgent {
  /** Process a message (delegates to ChatAgent.processMessage) */
  processMessage(chatId: string, text: string, messageId: string): Promise<void>;
}

/**
 * Minimal interface for AgentPool that the router needs.
 *
 * Allows creating or retrieving agents by chatId with optional cwd.
 */
export interface RouteableAgentPool {
  /**
   * Get or create an agent for the given chatId.
   * @param chatId - Target chat identifier
   * @param options - Optional creation parameters (e.g., cwd override)
   */
  getOrCreate(chatId: string, options?: { cwd?: string }): Promise<RouteableAgent>;

  /**
   * Check if an agent is currently processing a message.
   * @param chatId - Target chat identifier
   */
  isBusy(chatId: string): boolean;
}

/**
 * Resolves project configuration to routing info.
 *
 * Implemented by ProjectManager (or a wrapper) to look up
 * which chatId and workingDir are bound to a given projectKey.
 */
export interface ProjectConfigResolver {
  /**
   * Resolve a projectKey to its routing information.
   * @param projectKey - Project identifier (e.g., 'owner/repo')
   * @returns Routing info with chatId and workingDir, or undefined if not found
   */
  resolve(projectKey: string): Promise<ProjectRoutingInfo | undefined>;
}

/**
 * Project routing information returned by ProjectConfigResolver.
 */
export interface ProjectRoutingInfo {
  /** Bound chat identifier */
  chatId: string;
  /** Project working directory (Agent's cwd) */
  workingDir: string;
}

// ============================================================================
// Router Configuration
// ============================================================================

/**
 * Configuration for UnifiedMessageRouter.
 */
export interface UnifiedMessageRouterConfig {
  /** Agent pool for creating/retrieving ChatAgent instances */
  agentPool: RouteableAgentPool;
  /** Project config resolver for SystemMessage/AgentMessage routing */
  projectResolver: ProjectConfigResolver;
  /** Optional logger */
  logger?: Logger;
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Queued message awaiting delivery.
 */
interface QueuedMessage {
  message: Message;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Result of a route operation.
 */
export interface RouteResult {
  /** Whether the message was routed successfully */
  ok: boolean;
  /** Target chatId where the message was routed */
  chatId?: string;
  /** Error message if routing failed */
  error?: string;
}

// ============================================================================
// UnifiedMessageRouter
// ============================================================================

/**
 * UnifiedMessageRouter — Routes all Message types to ChatAgent instances.
 *
 * Key design:
 * - UserMessage: chatId from message itself
 * - SystemMessage/AgentMessage: chatId resolved from project config
 * - Per-chatId message queue ensures sequential delivery
 * - Zero modification to ChatAgent.processMessage() signature
 */
export class UnifiedMessageRouter {
  private readonly agentPool: RouteableAgentPool;
  private readonly projectResolver: ProjectConfigResolver;
  private readonly log: Logger;

  /** Per-chatId message queue for sequential delivery */
  private readonly queues = new Map<string, QueuedMessage[]>();

  /** Track which chatIds are currently being processed */
  private readonly processing = new Set<string>();

  constructor(config: UnifiedMessageRouterConfig) {
    this.agentPool = config.agentPool;
    this.projectResolver = config.projectResolver;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Route a message to the appropriate ChatAgent.
   *
   * - UserMessage: uses chatId from message
   * - SystemMessage: resolves chatId from project config via projectKey
   * - AgentMessage: resolves chatId from project config via projectKey
   *
   * @param message - The message to route
   * @returns Route result with chatId and status
   */
  async route(message: Message): Promise<RouteResult> {
    if (isUserMessage(message)) {
      return this.routeUserMessage(message);
    }

    if (isSystemMessage(message)) {
      return this.routeSystemMessage(message);
    }

    if (isAgentMessage(message)) {
      return this.routeAgentMessage(message);
    }

    return { ok: false, error: `Unknown message source: ${(message as Message).source}` };
  }

  /**
   * Enqueue a message for a project-bound agent.
   *
   * Unlike route(), this method resolves the projectKey to a chatId
   * and queues the message for sequential delivery. If the target
   * agent is not busy, the message is delivered immediately.
   *
   * @param projectKey - Target project identifier
   * @param message - The message to enqueue
   */
  async enqueue(projectKey: string, message: SystemMessage | AgentMessage): Promise<RouteResult> {
    const routingInfo = await this.projectResolver.resolve(projectKey);
    if (!routingInfo) {
      const error = `Project not found: ${projectKey}`;
      this.log.warn({ projectKey }, error);
      return { ok: false, error };
    }

    return this.deliverToChat(routingInfo.chatId, routingInfo.workingDir, message);
  }

  // ───────────────────────────────────────────
  // Private: Per-Source Routing
  // ───────────────────────────────────────────

  /**
   * Route a UserMessage — chatId comes from the message itself.
   */
  private async routeUserMessage(message: UserMessage): Promise<RouteResult> {
    this.log.debug(
      { chatId: message.chatId, messageId: message.messageId },
      'Routing UserMessage'
    );
    return this.deliverToChat(message.chatId, undefined, message);
  }

  /**
   * Route a SystemMessage — chatId resolved from project config.
   * Falls back to error if no projectKey is set.
   */
  private async routeSystemMessage(message: SystemMessage): Promise<RouteResult> {
    if (!message.projectKey) {
      const error = 'SystemMessage has no projectKey — cannot resolve chatId';
      this.log.warn({ messageId: message.id }, error);
      return { ok: false, error };
    }

    this.log.debug(
      { projectKey: message.projectKey, trigger: message.trigger },
      'Routing SystemMessage via project config'
    );

    const routingInfo = await this.projectResolver.resolve(message.projectKey);
    if (!routingInfo) {
      const error = `Project not found for key: ${message.projectKey}`;
      this.log.warn({ projectKey: message.projectKey }, error);
      return { ok: false, error };
    }

    return this.deliverToChat(routingInfo.chatId, routingInfo.workingDir, message);
  }

  /**
   * Route an AgentMessage — chatId resolved from project config.
   * Falls back to error if no projectKey is set.
   */
  private async routeAgentMessage(message: AgentMessage): Promise<RouteResult> {
    if (!message.projectKey) {
      const error = 'AgentMessage has no projectKey — cannot resolve chatId';
      this.log.warn({ messageId: message.id, fromChatId: message.fromChatId }, error);
      return { ok: false, error };
    }

    this.log.debug(
      { projectKey: message.projectKey, fromChatId: message.fromChatId },
      'Routing AgentMessage via project config'
    );

    const routingInfo = await this.projectResolver.resolve(message.projectKey);
    if (!routingInfo) {
      const error = `Project not found for key: ${message.projectKey}`;
      this.log.warn({ projectKey: message.projectKey }, error);
      return { ok: false, error };
    }

    return this.deliverToChat(routingInfo.chatId, routingInfo.workingDir, message);
  }

  // ───────────────────────────────────────────
  // Private: Delivery & Queue
  // ───────────────────────────────────────────

  /**
   * Deliver a message to a specific chatId.
   *
   * If the agent is busy, the message is queued and will be
   * delivered when the current processing completes.
   */
  private async deliverToChat(
    chatId: string,
    workingDir: string | undefined,
    message: Message
  ): Promise<RouteResult> {
    // If currently processing for this chatId, queue the message
    if (this.processing.has(chatId)) {
      this.log.debug(
        { chatId, messageId: message.id },
        'Agent busy — queueing message'
      );

      return new Promise<RouteResult>((resolve) => {
        const queue = this.getOrCreateQueue(chatId);
        queue.push({
          message,
          resolve: () => resolve({ ok: true, chatId }),
          reject: (error: Error) => resolve({ ok: false, error: error.message }),
        });
      });
    }

    // Mark as processing and deliver
    this.processing.add(chatId);

    try {
      const agent = await this.agentPool.getOrCreate(chatId, workingDir ? { cwd: workingDir } : undefined);
      await agent.processMessage(chatId, message.payload, message.id);
      return { ok: true, chatId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error({ chatId, messageId: message.id, err }, 'Failed to deliver message');
      return { ok: false, error: errorMsg };
    } finally {
      this.processing.delete(chatId);
      // Drain queue — deliver the next queued message
      await this.drainQueue(chatId);
    }
  }

  /**
   * Drain the message queue for a chatId.
   *
   * Processes messages one at a time in FIFO order.
   */
  private async drainQueue(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) {
      this.queues.delete(chatId);
      return;
    }

    // Take the first message from the queue
    const item = queue.shift();
    if (!item) return;

    // Clean up empty queue
    if (queue.length === 0) {
      this.queues.delete(chatId);
    }

    this.log.debug({ chatId }, 'Draining queued message');

    try {
      await this.deliverToChat(chatId, undefined, item.message);
      item.resolve();
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Get or create the message queue for a chatId.
   */
  private getOrCreateQueue(chatId: string): QueuedMessage[] {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = [];
      this.queues.set(chatId, queue);
    }
    return queue;
  }

  // ───────────────────────────────────────────
  // Public: Status & Management
  // ───────────────────────────────────────────

  /**
   * Get the number of queued messages for a chatId.
   */
  getQueueSize(chatId: string): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  /**
   * Check if the router is currently processing a message for a chatId.
   */
  isProcessing(chatId: string): boolean {
    return this.processing.has(chatId);
  }

  /**
   * Clear all queued messages (used during shutdown).
   */
  clearQueues(): void {
    for (const [_chatId, queue] of this.queues) {
      for (const item of queue) {
        item.reject(new Error('Router shutting down'));
      }
    }
    this.queues.clear();
    this.processing.clear();
    this.log.info('All message queues cleared');
  }
}
