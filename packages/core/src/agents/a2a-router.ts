/**
 * A2A Router - Agent-to-Agent task delegation with safety mechanisms.
 *
 * Issue #3334: Enables ChatAgents to delegate tasks to project-bound agents
 * via A2A messaging. Provides anti-recursion, rate limiting, and source traceability.
 *
 * Architecture:
 * ```
 * ChatAgent calls enqueue_task(fromChatId, projectKey, payload, priority)
 *   → A2ARouter.enqueueTask()
 *     → Anti-recursion check (same chatId)
 *     → Rate limit check (per fromChatId sliding window)
 *     → Create A2AMessage
 *     → messageRouter(projectKey, message)
 *       → Resolve project → chatId + agent
 *       → agent.processMessage(chatId, payload)
 * ```
 *
 * @module agents/a2a-router
 */

import { createLogger } from '../utils/index.js';

const logger = createLogger('A2ARouter');

// ============================================================================
// Types
// ============================================================================

/**
 * Priority levels for A2A messages.
 */
export type A2AMessagePriority = 'low' | 'normal' | 'high';

/**
 * An A2A (Agent-to-Agent) message representing a delegated task.
 */
export interface A2AMessage {
  /** Unique message identifier */
  id: string;
  /** Message type discriminator */
  type: 'a2a';
  /** The chatId of the agent that enqueued this task */
  fromChatId: string;
  /** Target project key */
  projectKey: string;
  /** Task instruction payload */
  payload: string;
  /** Message priority */
  priority: A2AMessagePriority;
  /** ISO timestamp when the message was created */
  createdAt: string;
}

/**
 * Function to look up a project's chatId by projectKey.
 * Returns undefined if the project is not found.
 */
export type ProjectLookupFn = (projectKey: string) => Promise<{ chatId: string; workingDir: string } | undefined>;

/**
 * Function to route a message to a project-bound agent.
 * Returns true if the message was successfully enqueued.
 */
export type MessageRouterFn = (projectKey: string, message: A2AMessage) => Promise<boolean>;

/**
 * Configuration for the A2A router.
 */
export interface A2ARouterConfig {
  /** Maximum number of A2A messages per source agent per time window (default: 10) */
  maxMessagesPerWindow?: number;
  /** Time window in milliseconds for rate limiting (default: 60000 = 1 minute) */
  rateLimitWindowMs?: number;
  /** Function to look up a project's chatId by projectKey */
  projectLookup: ProjectLookupFn;
  /** Function to route a message to a project-bound agent */
  messageRouter: MessageRouterFn;
}

// ============================================================================
// Rate Limiter (sliding window per source chatId)
// ============================================================================

interface RateLimitEntry {
  timestamps: number[];
}

/**
 * Sliding window rate limiter keyed by source chatId.
 */
class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxMessages: number;
  private readonly windowMs: number;

  constructor(maxMessages: number, windowMs: number) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
  }

  /**
   * Check if a source chatId is allowed to send a message.
   * If allowed, records the timestamp.
   */
  check(chatId: string): boolean {
    const now = Date.now();
    let entry = this.entries.get(chatId);

    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(chatId, entry);
    }

    // Remove expired timestamps
    const cutoff = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter(ts => ts > cutoff);

    if (entry.timestamps.length >= this.maxMessages) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /**
   * Get the current count of messages in the window for a chatId.
   */
  getCount(chatId: string): number {
    const entry = this.entries.get(chatId);
    if (!entry) {
      return 0;
    }

    const cutoff = Date.now() - this.windowMs;
    return entry.timestamps.filter(ts => ts > cutoff).length;
  }
}

// ============================================================================
// A2A Router
// ============================================================================

/**
 * A2ARouter - Manages Agent-to-Agent task delegation with safety mechanisms.
 *
 * Features:
 * - **Anti-recursion**: Prevents agents from delegating tasks to themselves
 * - **Rate limiting**: Sliding window per source chatId
 * - **Source traceability**: Records originating chatId in every message
 * - **Non-blocking**: enqueueTask returns immediately after validation
 */
export class A2ARouter {
  private readonly config: Required<Pick<A2ARouterConfig, 'maxMessagesPerWindow' | 'rateLimitWindowMs'>> &
    Pick<A2ARouterConfig, 'projectLookup' | 'messageRouter'>;
  private readonly rateLimiter: RateLimiter;

  constructor(config: A2ARouterConfig) {
    this.config = {
      maxMessagesPerWindow: config.maxMessagesPerWindow ?? 10,
      rateLimitWindowMs: config.rateLimitWindowMs ?? 60_000,
      projectLookup: config.projectLookup,
      messageRouter: config.messageRouter,
    };
    this.rateLimiter = new RateLimiter(
      this.config.maxMessagesPerWindow,
      this.config.rateLimitWindowMs,
    );
  }

  /**
   * Enqueue a task for a project-bound agent.
   *
   * Safety checks:
   * 1. Anti-recursion: Cannot enqueue to own project (same chatId)
   * 2. Rate limiting: Max N messages per window per source
   *
   * @param fromChatId - The chatId of the enqueuing agent
   * @param projectKey - Target project key
   * @param payload - Task instruction
   * @param priority - Optional priority (default: 'normal')
   * @returns Result indicating success or failure with reason
   */
  async enqueueTask(
    fromChatId: string,
    projectKey: string,
    payload: string,
    priority: A2AMessagePriority = 'normal',
  ): Promise<{ success: boolean; message: string; messageId?: string }> {
    // Validate inputs
    if (!fromChatId || !projectKey || !payload) {
      return { success: false, message: 'Missing required parameters: fromChatId, projectKey, payload' };
    }

    // Look up the target project
    const project = await this.config.projectLookup(projectKey);
    if (!project) {
      return { success: false, message: `Project not found: ${projectKey}` };
    }

    // Anti-recursion: prevent self-delegation
    if (project.chatId === fromChatId) {
      logger.warn({ fromChatId, projectKey }, 'A2A anti-recursion: self-delegation blocked');
      return { success: false, message: `Cannot enqueue task to own project (same chatId: ${fromChatId})` };
    }

    // Rate limiting
    if (!this.rateLimiter.check(fromChatId)) {
      const count = this.rateLimiter.getCount(fromChatId);
      logger.warn(
        { fromChatId, count, limit: this.config.maxMessagesPerWindow },
        'A2A rate limit exceeded',
      );
      return {
        success: false,
        message: `Rate limit exceeded: ${count} messages in window (max ${this.config.maxMessagesPerWindow})`,
      };
    }

    // Create A2A message
    const messageId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const a2aMessage: A2AMessage = {
      id: messageId,
      type: 'a2a',
      fromChatId,
      projectKey,
      payload,
      priority,
      createdAt: new Date().toISOString(),
    };

    // Route the message
    try {
      const routed = await this.config.messageRouter(projectKey, a2aMessage);
      if (!routed) {
        return { success: false, message: `Failed to route message to project: ${projectKey}` };
      }

      logger.info(
        { messageId, fromChatId, projectKey, priority },
        'A2A task enqueued successfully',
      );

      return {
        success: true,
        message: `Task enqueued for ${projectKey}. The project agent will process it and reply to its bound chat.`,
        messageId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMsg, fromChatId, projectKey }, 'A2A enqueue failed');
      return { success: false, message: `Failed to enqueue task: ${errorMsg}` };
    }
  }

  /**
   * Get the current rate limit usage for a chatId.
   */
  getRateLimitUsage(chatId: string): { count: number; limit: number } {
    return {
      count: this.rateLimiter.getCount(chatId),
      limit: this.config.maxMessagesPerWindow,
    };
  }
}
