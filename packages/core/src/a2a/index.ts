/**
 * A2A (Agent-to-Agent) messaging module — task delegation between ChatAgents.
 *
 * This module provides:
 * - `A2AEnqueueService` — core service for enqueuing A2A tasks
 * - Type definitions for A2A requests, results, and rate limiting
 *
 * Safety features:
 * - Anti-recursion: agent cannot enqueue to its own project
 * - Rate limiting: per-source sliding window
 * - Source traceability: originating chatId recorded in message source
 * - Non-blocking: enqueue returns immediately
 *
 * @see Issue #3334 (Phase 4: A2A messaging — Agent-to-Agent task delegation)
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline for ChatAgent 0.4.0)
 */

export type {
  A2AEnqueueRequest,
  A2AEnqueueResult,
  A2AEnqueueServiceConfig,
  A2ARateLimitConfig,
  A2ARouteMessage,
  RateLimitEntry,
} from './types.js';

export {
  A2AEnqueueService,
} from './a2a-enqueue-service.js';
