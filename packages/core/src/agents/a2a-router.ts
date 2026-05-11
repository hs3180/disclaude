/**
 * A2ARouter — Agent-to-Agent task delegation with safety mechanisms (Issue #3334).
 *
 * Provides the routing layer for ChatAgent-to-ChatAgent task delegation:
 * - Anti-recursion: Agent cannot enqueue tasks to its own project (same chatId)
 * - Rate limiting: Max N A2A messages per agent per time window
 * - Source traceability: fromChatId recorded in A2AMessage for audit
 * - Non-blocking: enqueue returns immediately with confirmation
 *
 * Built on top of MessageRouter (Issue #3331) which handles queue behavior
 * and priority ordering.
 *
 * @see Issue #3334 (Phase 4: A2A & Signal)
 * @see RFC #3329 (Message — Unified Agent Input Abstraction)
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type {
  A2AMessage,
  MessagePriority,
  ProjectLookup,
} from '../types/unified-message.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for A2ARouter.
 */
export interface A2ARouterConfig {
  /** Maximum A2A messages per source chatId within the rate limit window */
  maxMessagesPerWindow: number;
  /** Rate limit window in milliseconds */
  windowMs: number;
  /** Optional logger */
  logger?: Logger;
}

/**
 * Default rate limit: 10 messages per 60 seconds per source agent.
 */
const DEFAULT_RATE_LIMIT: Pick<A2ARouterConfig, 'maxMessagesPerWindow' | 'windowMs'> = {
  maxMessagesPerWindow: 10,
  windowMs: 60_000, // 1 minute
};

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Rate limit tracking entry per source chatId.
 */
interface RateLimitEntry {
  /** Timestamps of recent enqueue attempts (within the window) */
  timestamps: number[];
}

/**
 * Callback for enqueuing A2A messages via the MessageRouter.
 *
 * Decoupled from the concrete MessageRouter class to allow A2ARouter
 * to be tested independently and wired during application initialization.
 */
export type A2AEnqueueCallback = (projectKey: string, message: A2AMessage) => Promise<void>;

// ============================================================================
// A2ARouter
// ============================================================================

const defaultLogger = createLogger('A2ARouter');

/**
 * A2ARouter — Safety layer for Agent-to-Agent task delegation.
 *
 * Wraps the MessageRouter.enqueue() with:
 * 1. **Anti-recursion**: Prevents an agent from delegating tasks to itself
 *    by checking if the target project's bound chatId matches the source chatId.
 * 2. **Rate limiting**: Limits the number of A2A messages per source agent
 *    within a configurable time window to prevent abuse.
 *
 * Usage:
 * ```typescript
 * const router = new A2ARouter({ projectLookup, enqueue: messageRouter.enqueue.bind(messageRouter) });
 * const result = await router.enqueueTask({
 *   fromChatId: 'oc_agent_chat',
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'Triage all open issues',
 *   priority: 'high',
 * });
 * ```
 */
export class A2ARouter {
  private readonly config: Required<Pick<A2ARouterConfig, 'maxMessagesPerWindow' | 'windowMs'>>;
  private readonly log: Logger;
  private readonly projectLookup: ProjectLookup | null;
  private readonly enqueueCallback: A2AEnqueueCallback | null;
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  constructor(config?: Partial<A2ARouterConfig> & {
    /** Project lookup for anti-recursion check */
    projectLookup?: ProjectLookup;
    /** Callback to enqueue messages via MessageRouter */
    enqueue?: A2AEnqueueCallback;
  }) {
    this.config = {
      maxMessagesPerWindow: config?.maxMessagesPerWindow ?? DEFAULT_RATE_LIMIT.maxMessagesPerWindow,
      windowMs: config?.windowMs ?? DEFAULT_RATE_LIMIT.windowMs,
    };
    this.log = config?.logger ?? defaultLogger;
    this.projectLookup = config?.projectLookup ?? null;
    this.enqueueCallback = config?.enqueue ?? null;
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Enqueue a task for a project-bound agent (A2A delegation).
   *
   * This is the core method called by the `enqueue_task` tool.
   * It performs safety checks before delegating to the MessageRouter.
   *
   * @param params - Task delegation parameters
   * @param params.fromChatId - Source agent's chatId (for traceability & anti-recursion)
   * @param params.projectKey - Target project key
   * @param params.payload - Task instruction text
   * @param params.priority - Message priority (default: 'normal')
   * @returns Result with success status and message
   */
  async enqueueTask(params: {
    fromChatId: string;
    projectKey: string;
    payload: string;
    priority?: MessagePriority;
  }): Promise<{ success: boolean; message: string }> {
    const { fromChatId, projectKey, payload, priority = 'normal' } = params;

    // Validate required fields
    if (!fromChatId) {
      return { success: false, message: 'Missing required parameter: fromChatId' };
    }
    if (!projectKey) {
      return { success: false, message: 'Missing required parameter: projectKey' };
    }
    if (!payload) {
      return { success: false, message: 'Missing required parameter: payload' };
    }

    // Check if enqueue callback is available
    if (!this.enqueueCallback) {
      return { success: false, message: 'A2A messaging is not available: router not initialized' };
    }

    // Anti-recursion: check if agent is trying to enqueue to itself
    const recursionCheck = this.checkAntiRecursion(fromChatId, projectKey);
    if (!recursionCheck.allowed) {
      this.log.warn(
        { fromChatId, projectKey },
        'Anti-recursion: agent attempted to enqueue to own project'
      );
      return { success: false, message: recursionCheck.reason ?? 'Anti-recursion check failed' };
    }

    // Rate limiting
    const rateLimitCheck = this.checkRateLimit(fromChatId);
    if (!rateLimitCheck.allowed) {
      this.log.warn(
        { fromChatId, projectKey, remaining: rateLimitCheck.remaining },
        'Rate limit exceeded for A2A delegation'
      );
      return {
        success: false,
        message: `Rate limit exceeded: max ${this.config.maxMessagesPerWindow} A2A messages per ${this.config.windowMs / 1000}s. Please try again later.`,
      };
    }

    // Create A2AMessage
    const message: A2AMessage = {
      id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'agent',
      fromChatId,
      projectKey,
      priority,
      payload,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.enqueueCallback(projectKey, message);
      this.log.info(
        { fromChatId, projectKey, messageId: message.id, priority },
        'A2A task enqueued successfully'
      );
      return {
        success: true,
        message: `Task enqueued for project "${projectKey}" (priority: ${priority}, id: ${message.id}). The target agent will process it asynchronously.`,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error, fromChatId, projectKey },
        'Failed to enqueue A2A task'
      );
      return { success: false, message: `Failed to enqueue task: ${errMsg}` };
    }
  }

  /**
   * Get current rate limit status for a source chatId.
   *
   * @param fromChatId - Source agent's chatId
   * @returns Number of remaining messages in the current window
   */
  getRemainingQuota(fromChatId: string): number {
    const entry = this.rateLimits.get(fromChatId);
    if (!entry) {
      return this.config.maxMessagesPerWindow;
    }
    this.pruneExpiredTimestamps(entry);
    return Math.max(0, this.config.maxMessagesPerWindow - entry.timestamps.length);
  }

  /**
   * Clear all rate limit state. Useful for testing.
   */
  clearRateLimits(): void {
    this.rateLimits.clear();
  }

  // ──────────────────────────────────────────────
  // Private: Anti-Recursion
  // ──────────────────────────────────────────────

  private checkAntiRecursion(fromChatId: string, projectKey: string): { allowed: boolean; reason?: string } {
    if (!this.projectLookup) {
      // No project lookup available — cannot check recursion, allow by default
      return { allowed: true };
    }

    const targetProject = this.projectLookup.lookup(projectKey);
    if (targetProject && targetProject.chatId === fromChatId) {
      return {
        allowed: false,
        reason: `Anti-recursion: cannot delegate a task to your own project (projectKey: "${projectKey}", chatId: "${fromChatId}"). The target agent is the same as the source agent.`,
      };
    }

    return { allowed: true };
  }

  // ──────────────────────────────────────────────
  // Private: Rate Limiting
  // ──────────────────────────────────────────────

  private checkRateLimit(fromChatId: string): { allowed: boolean; remaining: number } {
    let entry = this.rateLimits.get(fromChatId);

    if (!entry) {
      entry = { timestamps: [] };
      this.rateLimits.set(fromChatId, entry);
    }

    // Remove expired timestamps
    this.pruneExpiredTimestamps(entry);

    const remaining = this.config.maxMessagesPerWindow - entry.timestamps.length;
    if (remaining <= 0) {
      return { allowed: false, remaining: 0 };
    }

    // Record this request
    entry.timestamps.push(Date.now());
    return { allowed: true, remaining: remaining - 1 };
  }

  private pruneExpiredTimestamps(entry: RateLimitEntry): void {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    entry.timestamps = entry.timestamps.filter(ts => ts >= cutoff);
  }
}
