/**
 * A2A (Agent-to-Agent) messaging type definitions.
 *
 * Enables ChatAgents to delegate tasks to project-bound agents
 * via NonUserMessage routing.
 *
 * Key design:
 * - Anti-recursion: Agent cannot enqueue tasks to its own project
 * - Rate limiting: Configurable max messages per source per time window
 * - Source traceability: originating chatId recorded for audit
 * - Non-blocking: enqueue returns immediately with confirmation
 *
 * @see Issue #3334 (Phase 4: A2A messaging — Agent-to-Agent task delegation)
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline for ChatAgent 0.4.0)
 */

/**
 * Priority level for A2A messages (mirrors NonUserMessagePriority from Issue #3331).
 *
 * Once the NonUserMessage module is merged (PR #3339), this can be
 * replaced with an import from '../non-user-message/types.js'.
 *
 * @see Issue #3331 (Phase 1: NonUserMessage type definition)
 */
export type A2AMessagePriority = 'low' | 'normal' | 'high';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Enqueue Request / Response Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Request to enqueue an A2A task to a project-bound agent.
 *
 * Created by the `enqueue_task` tool when a ChatAgent delegates work.
 */
export interface A2AEnqueueRequest {
  /** Target project key (e.g., 'hs3180/disclaude') */
  projectKey: string;

  /** Task instruction for the target agent */
  payload: string;

  /** Priority level (default: 'normal') */
  priority?: A2AMessagePriority;

  /**
   * Source chatId — the chatId of the enqueuing ChatAgent.
   * Used for anti-recursion check and traceability.
   */
  sourceChatId: string;
}

/**
 * Result of an A2A enqueue operation.
 */
export type A2AEnqueueResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rate Limiter Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Configuration for A2A rate limiting.
 *
 * Rate limiting is per-source: each source chatId has an independent
 * budget of messages per time window.
 */
export interface A2ARateLimitConfig {
  /** Maximum number of A2A messages per source per time window */
  maxMessagesPerWindow: number;

  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
}

/**
 * Internal tracking entry for rate limiting.
 */
export interface RateLimitEntry {
  /** Timestamps of messages sent within the current window */
  timestamps: number[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Service Configuration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Configuration for the A2AEnqueueService.
 */
export interface A2AEnqueueServiceConfig {
  /**
   * Look up the current project key for a given chatId.
   *
   * Used for anti-recursion check: if the source agent's chatId
   * is bound to the same projectKey as the target, the enqueue
   * is rejected to prevent infinite loops.
   *
   * Returns undefined if the chatId has no project binding
   * (i.e., the source agent is in the default workspace).
   */
  getProjectKeyForChatId(chatId: string): string | undefined;

  /**
   * Enqueue a NonUserMessage via the router.
   *
   * The A2A service delegates actual message routing to the
   * NonUserMessageRouter after performing safety checks.
   */
  routeMessage(message: A2ARouteMessage): A2AEnqueueResult;

  /** Rate limiting configuration (optional, uses defaults if omitted) */
  rateLimit?: Partial<A2ARateLimitConfig>;
}

/**
 * Message to be routed by the NonUserMessageRouter.
 *
 * This is the internal representation after an A2AEnqueueRequest
 * passes safety checks and is ready for routing.
 */
export interface A2ARouteMessage {
  /** Unique message identifier */
  id: string;

  /** Source identifier for traceability (e.g., 'chat:oc_xxx') */
  source: string;

  /** Target project key */
  projectKey: string;

  /** Task instruction */
  payload: string;

  /** Priority level */
  priority: A2AMessagePriority;

  /** ISO 8601 timestamp */
  createdAt: string;
}
