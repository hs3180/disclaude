/**
 * MessageRouter — Unified input routing for ChatAgent (RFC #3329, Issue #3331).
 *
 * Routes all Message types (UserMessage, SystemMessage, A2AMessage) to the
 * appropriate ChatAgent instance via AgentPool.
 *
 * Routing Logic:
 * - UserMessage: chatId from message → AgentPool.getOrCreateChatAgent(chatId)
 * - SystemMessage: projectKey → ProjectLookup → chatId → AgentPool
 * - A2AMessage: projectKey → ProjectLookup → chatId → AgentPool
 *
 * Queue Behavior:
 * - When a ChatAgent is busy processing a message, subsequent messages for
 *   the same chatId are queued.
 * - Queued messages are processed in priority order (high → normal → low).
 * - Within the same priority, FIFO order is preserved.
 *
 * Design:
 * - No modification to ChatAgent.processMessage() signature
 * - Pluggable ProjectLookup (decoupled from ProjectManager)
 * - Pluggable AgentPool (uses the existing AgentPool interface)
 *
 * @see RFC #3329 (Message — Unified Agent Input Abstraction)
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 */

import { createLogger, type Logger } from '../utils/logger.js';
import {
  isA2AMessage,
  isSystemMessage,
  isUserMessage,
  type AnyMessage,
  type Message,
  type MessagePriority,
  type NonUserMessage,
  type ProjectLookup,
  type ProjectLookupResult,
  type UserMessage,
} from '../types/unified-message.js';
import type { ChatAgent } from './types.js';

const defaultLogger = createLogger('MessageRouter');

// ============================================================================
// Configuration
// ============================================================================

/**
 * Interface for the agent pool used by MessageRouter.
 *
 * Abstracts the agent pool to decouple MessageRouter from the concrete
 * AgentPool implementation. This allows testing with mocks and future
 * extensions (e.g., distributed agent pools).
 */
export interface MessageRouterAgentPool {
  /**
   * Get or create a ChatAgent for the given chatId.
   */
  getOrCreateChatAgent(chatId: string): ChatAgent;

  /**
   * Check if a ChatAgent exists for the given chatId.
   */
  has(chatId: string): boolean;

  /**
   * Get an existing ChatAgent without creating one.
   */
  get(chatId: string): ChatAgent | undefined;
}

/**
 * Configuration for MessageRouter.
 */
export interface MessageRouterConfig {
  /** Project lookup for resolving projectKey → chatId + workingDir */
  projectLookup: ProjectLookup;
  /** Agent pool for getting/creating ChatAgent instances */
  agentPool: MessageRouterAgentPool;
  /** Optional logger */
  logger?: Logger;
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal queued message with priority for ordering.
 */
interface QueuedMessageEntry {
  message: NonUserMessage;
  /** Enqueue timestamp for FIFO within same priority */
  enqueuedAt: number;
}

/**
 * Per-chatId agent state tracking.
 */
interface AgentRoutingState {
  /** Whether the agent is currently processing a message */
  busy: boolean;
  /** Queue of pending messages (ordered by priority, then FIFO) */
  queue: QueuedMessageEntry[];
}

// ============================================================================
// Priority Ordering
// ============================================================================

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

function getPriority(message: Message): MessagePriority {
  if (isA2AMessage(message)) {
    return message.priority;
  }
  if (isSystemMessage(message)) {
    // System messages default to 'normal' priority
    return 'normal';
  }
  // User messages are always normal priority
  return 'normal';
}

// ============================================================================
// MessageRouter
// ============================================================================

/**
 * MessageRouter — Unified routing for all Message types to ChatAgent.
 *
 * Routes messages from three sources to the appropriate ChatAgent:
 * 1. UserMessage → direct chatId lookup in AgentPool
 * 2. SystemMessage → project config → chatId → AgentPool
 * 3. A2AMessage → project config → chatId → AgentPool
 *
 * For NonUserMessages (SystemMessage, A2AMessage), the router:
 * - Resolves chatId from project configuration via ProjectLookup
 * - Queues messages if the target agent is busy
 * - Processes queued messages when the agent becomes available
 *
 * @example
 * ```typescript
 * const router = new MessageRouter({
 *   projectLookup: myProjectLookup,
 *   agentPool: myAgentPool,
 * });
 *
 * // Route a system message (e.g., from scheduler)
 * await router.route({
 *   id: 'msg-1',
 *   source: 'system',
 *   trigger: 'scheduled',
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'Daily sync and triage...',
 *   createdAt: new Date().toISOString(),
 * });
 *
 * // Route a user message (e.g., from Feishu channel)
 * await router.route({
 *   id: 'msg-2',
 *   source: 'user',
 *   chatId: 'oc_xxx',
 *   messageId: 'msg-2',
 *   payload: 'Hello!',
 *   createdAt: new Date().toISOString(),
 * });
 * ```
 */
export class MessageRouter {
  private readonly projectLookup: ProjectLookup;
  private readonly agentPool: MessageRouterAgentPool;
  private readonly log: Logger;
  private readonly agentStates = new Map<string, AgentRoutingState>();

  constructor(config: MessageRouterConfig) {
    this.projectLookup = config.projectLookup;
    this.agentPool = config.agentPool;
    this.log = config.logger ?? defaultLogger;
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Route any Message to the appropriate ChatAgent.
   *
   * For UserMessage: chatId is taken from the message directly.
   * For SystemMessage/A2AMessage: chatId is resolved from project config.
   *
   * @param message - The message to route
   * @throws Error if projectKey is set but project not found
   */
  route(message: AnyMessage): Promise<void> {
    if (isUserMessage(message)) {
      return this.routeUserMessage(message);
    }
    return this.routeNonUserMessage(message);
  }

  /**
   * Enqueue a NonUserMessage for a project-bound agent.
   *
   * If the target agent is busy, the message waits in queue.
   * If the target agent is not busy, the message is processed immediately.
   *
   * @param projectKey - Target project key
   * @param message - The non-user message to enqueue
   * @throws Error if project not found
   */
  async enqueue(projectKey: string, message: NonUserMessage): Promise<void> {
    const project = this.resolveProject(projectKey);
    const state = this.getOrCreateState(project.chatId);

    if (!state.busy) {
      // Agent is idle — process immediately
      await this.deliverToAgent(project, message);
    } else {
      // Agent is busy — enqueue for later processing
      this.log.info(
        { chatId: project.chatId, projectKey, messageId: message.id, priority: getPriority(message) },
        'Agent busy, enqueuing message'
      );
      state.queue.push({
        message,
        enqueuedAt: Date.now(),
      });
      // Sort by priority (descending), then by enqueue time (ascending)
      state.queue.sort((a, b) => {
        const priorityDiff = PRIORITY_ORDER[getPriority(b.message)] - PRIORITY_ORDER[getPriority(a.message)];
        if (priorityDiff !== 0) {return priorityDiff;}
        return a.enqueuedAt - b.enqueuedAt;
      });
    }
  }

  /**
   * Get the number of queued messages for a chatId.
   *
   * @param chatId - The chat identifier
   * @returns Number of queued messages
   */
  getQueueSize(chatId: string): number {
    return this.agentStates.get(chatId)?.queue.length ?? 0;
  }

  /**
   * Get all chatIds with queued messages.
   *
   * @returns Array of chatIds with pending messages
   */
  getBusyChatIds(): string[] {
    return Array.from(this.agentStates.entries())
      .filter(([, state]) => state.busy || state.queue.length > 0)
      .map(([chatId]) => chatId);
  }

  // ──────────────────────────────────────────────
  // Private: UserMessage Routing
  // ──────────────────────────────────────────────

  private routeUserMessage(message: UserMessage): Promise<void> {
    const { chatId, payload, messageId, senderOpenId, chatHistoryContext } = message;
    this.log.info({ chatId, messageId }, 'Routing UserMessage');

    const agent = this.agentPool.getOrCreateChatAgent(chatId);
    agent.processMessage(chatId, payload, messageId, senderOpenId, undefined, chatHistoryContext);
    return Promise.resolve();
  }

  // ──────────────────────────────────────────────
  // Private: NonUserMessage Routing
  // ──────────────────────────────────────────────

  private routeNonUserMessage(message: NonUserMessage): Promise<void> {
    const {projectKey} = message;
    if (!projectKey) {
      return Promise.reject(
        new Error(
          `NonUserMessage (source: ${message.source}) requires projectKey for routing. ` +
          `Message ID: ${message.id}`
        )
      );
    }

    return this.enqueue(projectKey, message);
  }

  // ──────────────────────────────────────────────
  // Private: Project Resolution
  // ──────────────────────────────────────────────

  private resolveProject(projectKey: string): ProjectLookupResult {
    const project = this.projectLookup.lookup(projectKey);
    if (!project) {
      throw new Error(`Project not found: ${projectKey}`);
    }
    return project;
  }

  // ──────────────────────────────────────────────
  // Private: Agent Delivery & Queue Processing
  // ──────────────────────────────────────────────

  private async deliverToAgent(project: ProjectLookupResult, message: NonUserMessage): Promise<void> {
    const { chatId } = project;
    const state = this.getOrCreateState(chatId);

    state.busy = true;
    this.log.info(
      { chatId, projectKey: message.projectKey, messageId: message.id, source: message.source },
      'Delivering message to agent'
    );

    try {
      const agent = this.agentPool.getOrCreateChatAgent(chatId);
      // Use processMessage() — no modification to ChatAgent.processMessage() signature
      agent.processMessage(chatId, message.payload, message.id);

      // Wait for the agent to finish processing if taskComplete is available
      if (agent.taskComplete) {
        await agent.taskComplete;
      }
    } catch (error) {
      this.log.error(
        { error, chatId, messageId: message.id },
        'Error delivering message to agent'
      );
    } finally {
      state.busy = false;
      // Process next queued message if any
      await this.processQueue(chatId);
    }
  }

  private async processQueue(chatId: string): Promise<void> {
    const state = this.agentStates.get(chatId);
    if (!state || state.busy || state.queue.length === 0) {
      return;
    }

    const entry = state.queue.shift();
    if (!entry) {return;}
    const {message} = entry;

    this.log.info(
      { chatId, messageId: message.id, remainingInQueue: state.queue.length },
      'Processing queued message'
    );

    const {projectKey} = message;
    if (!projectKey) {return;}

    const project = this.resolveProject(projectKey);
    await this.deliverToAgent(project, message);
  }

  // ──────────────────────────────────────────────
  // Private: State Management
  // ──────────────────────────────────────────────

  private getOrCreateState(chatId: string): AgentRoutingState {
    let state = this.agentStates.get(chatId);
    if (!state) {
      state = { busy: false, queue: [] };
      this.agentStates.set(chatId, state);
    }
    return state;
  }
}
