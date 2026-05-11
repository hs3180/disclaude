/**
 * A2A (Agent-to-Agent) messaging types for task delegation.
 *
 * Defines types and configuration for enabling ChatAgents to delegate
 * tasks to project-bound agents via A2A messaging.
 *
 * @see Issue #3334 (A2A messaging — Agent-to-Agent task delegation)
 * @see Issue #3331 (NonUserMessage type definition and routing layer)
 */

import type { NonUserMessagePriority } from './non-user-message.js';
import type { NonUserMessageRouter, ProjectResolver } from './non-user-message-router.js';

// ============================================================================
// A2A Configuration
// ============================================================================

/**
 * Rate limiting configuration for A2A task delegation.
 *
 * Limits how many tasks a single source agent can enqueue within a time window.
 */
export interface A2ARateLimitConfig {
  /** Maximum number of A2A messages per source per window (default: 10) */
  maxMessagesPerWindow: number;
  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
}

/**
 * Configuration for the A2A enqueue tool.
 *
 * Provides all dependencies needed to create and route A2A messages.
 */
export interface A2AConfig {
  /** Resolves projectKey → chatId for anti-recursion checks */
  projectResolver: ProjectResolver;
  /** Routes A2A NonUserMessages to target ChatAgents */
  router: NonUserMessageRouter;
  /** Rate limiting configuration (optional, uses defaults if not provided) */
  rateLimit?: Partial<A2ARateLimitConfig>;
}

/**
 * Result of an A2A enqueue_task call.
 */
export type A2AEnqueueResult =
  | { ok: true; messageId: string; targetProject: string }
  | { ok: false; error: string };

/**
 * Parameters for the enqueue_task tool.
 */
export interface EnqueueTaskParams {
  /** Target project key (e.g., 'hs3180/disclaude') */
  projectKey: string;
  /** Task instruction payload */
  payload: string;
  /** Priority level (default: 'normal') */
  priority?: NonUserMessagePriority;
}

// ============================================================================
// Defaults
// ============================================================================

/** Default rate limit configuration */
export const DEFAULT_A2A_RATE_LIMIT: A2ARateLimitConfig = {
  maxMessagesPerWindow: 10,
  windowMs: 60_000, // 1 minute
};
