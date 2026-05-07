/**
 * A2AEnqueueService — core service for Agent-to-Agent task delegation.
 *
 * Enables ChatAgents to enqueue tasks for project-bound agents via
 * the NonUserMessage routing layer.
 *
 * Safety features:
 * - **Anti-recursion**: Rejects if source agent's projectKey matches target
 * - **Rate limiting**: Per-source sliding window rate limiting
 * - **Source traceability**: Records originating chatId in message source
 * - **Non-blocking**: Returns immediately with confirmation
 *
 * @see Issue #3334 (Phase 4: A2A messaging — Agent-to-Agent task delegation)
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline for ChatAgent 0.4.0)
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger, type Logger } from '../utils/logger.js';
import type {
  A2AEnqueueRequest,
  A2AEnqueueResult,
  A2AEnqueueServiceConfig,
  A2ARateLimitConfig,
  RateLimitEntry,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Defaults
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Default rate limit: 10 messages per source per minute */
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 10;

/** Default rate limit window: 60 seconds */
const DEFAULT_WINDOW_MS = 60_000;

const defaultLogger = createLogger('A2AEnqueueService');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// A2AEnqueueService
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Service for enqueuing A2A (Agent-to-Agent) tasks.
 *
 * Usage:
 * ```typescript
 * const service = new A2AEnqueueService({
 *   getProjectKeyForChatId: (chatId) => pm.getProjectConfigByChatId(chatId)?.key,
 *   routeMessage: (msg) => router.route(toNonUserMessage(msg)),
 * });
 *
 * const result = service.enqueue({
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'Triage all open issues',
 *   sourceChatId: 'oc_user_chat_123',
 * });
 * ```
 */
export class A2AEnqueueService {
  private readonly getProjectKeyForChatId: (chatId: string) => string | undefined;
  private readonly routeMessage: (message: import('./types.js').A2ARouteMessage) => A2AEnqueueResult;
  private readonly rateLimitConfig: A2ARateLimitConfig;
  private readonly log: Logger;

  /** Rate limit tracking: source chatId → timestamps */
  private readonly rateLimitMap = new Map<string, RateLimitEntry>();

  constructor(config: A2AEnqueueServiceConfig) {
    this.getProjectKeyForChatId = config.getProjectKeyForChatId;
    this.routeMessage = config.routeMessage;
    this.log = defaultLogger;

    this.rateLimitConfig = {
      maxMessagesPerWindow: config.rateLimit?.maxMessagesPerWindow ?? DEFAULT_MAX_MESSAGES_PER_WINDOW,
      windowMs: config.rateLimit?.windowMs ?? DEFAULT_WINDOW_MS,
    };
  }

  /**
   * Enqueue an A2A task for a project-bound agent.
   *
   * Performs safety checks before routing:
   * 1. Anti-recursion: source agent cannot enqueue to its own project
   * 2. Rate limiting: per-source sliding window check
   * 3. Delegates to NonUserMessageRouter for actual routing
   *
   * @param request - The enqueue request
   * @returns Result with messageId on success, or error on failure
   */
  enqueue(request: A2AEnqueueRequest): A2AEnqueueResult {
    // ── Anti-recursion check ──
    const sourceProjectKey = this.getProjectKeyForChatId(request.sourceChatId);
    if (sourceProjectKey && sourceProjectKey === request.projectKey) {
      this.log.warn(
        { sourceChatId: request.sourceChatId, projectKey: request.projectKey },
        'Anti-recursion: agent attempted to enqueue to its own project',
      );
      return {
        ok: false,
        error: `Anti-recursion: agent for project "${request.projectKey}" cannot enqueue tasks to itself`,
      };
    }

    // ── Rate limiting check ──
    const rateLimitResult = this.checkRateLimit(request.sourceChatId);
    if (!rateLimitResult.allowed) {
      this.log.warn(
        { sourceChatId: request.sourceChatId, projectKey: request.projectKey },
        'Rate limit exceeded for A2A enqueue',
      );
      return {
        ok: false,
        error: `Rate limit exceeded: max ${this.rateLimitConfig.maxMessagesPerWindow} A2A messages per ${this.rateLimitConfig.windowMs / 1000}s from this agent`,
      };
    }

    // ── Build route message ──
    const messageId = uuidv4();
    const routeMessage = {
      id: messageId,
      source: `chat:${request.sourceChatId}`,
      projectKey: request.projectKey,
      payload: request.payload,
      priority: request.priority ?? 'normal',
      createdAt: new Date().toISOString(),
    };

    // ── Route via NonUserMessageRouter ──
    const result = this.routeMessage(routeMessage);

    if (result.ok) {
      // Record the message timestamp for rate limiting
      this.recordMessage(request.sourceChatId);
      this.log.info(
        { messageId, sourceChatId: request.sourceChatId, projectKey: request.projectKey },
        'A2A task enqueued successfully',
      );
      return { ok: true, messageId };
    }

    // Route failed — return the router's error
    return result;
  }

  /**
   * Get the current rate limit usage for a source chatId.
   *
   * Useful for diagnostics and monitoring.
   *
   * @param sourceChatId - The source chat identifier
   * @returns Object with current count and limit info
   */
  getRateLimitStatus(sourceChatId: string): {
    currentCount: number;
    maxPerWindow: number;
    windowMs: number;
    resetsAt: number | undefined;
  } {
    const entry = this.rateLimitMap.get(sourceChatId);
    const now = Date.now();
    const windowStart = now - this.rateLimitConfig.windowMs;

    // Count messages within the current window
    const currentTimestamps = entry
      ? entry.timestamps.filter(ts => ts > windowStart)
      : [];

    const oldestInWindow = currentTimestamps.length > 0
      ? currentTimestamps[0]
      : undefined;

    return {
      currentCount: currentTimestamps.length,
      maxPerWindow: this.rateLimitConfig.maxMessagesPerWindow,
      windowMs: this.rateLimitConfig.windowMs,
      resetsAt: oldestInWindow !== undefined
        ? oldestInWindow + this.rateLimitConfig.windowMs
        : undefined,
    };
  }

  // ───────────────────────────────────────────
  // Internal: Rate Limiting
  // ───────────────────────────────────────────

  /**
   * Check if the source chatId is within rate limits.
   *
   * Uses a sliding window: messages older than `windowMs` are pruned.
   *
   * @param sourceChatId - The source chat identifier
   * @returns Whether the message is allowed
   */
  private checkRateLimit(sourceChatId: string): { allowed: boolean } {
    const entry = this.rateLimitMap.get(sourceChatId);
    const now = Date.now();
    const windowStart = now - this.rateLimitConfig.windowMs;

    if (!entry) {
      return { allowed: true };
    }

    // Prune old timestamps outside the window
    const currentTimestamps = entry.timestamps.filter(ts => ts > windowStart);
    entry.timestamps = currentTimestamps;

    if (currentTimestamps.length >= this.rateLimitConfig.maxMessagesPerWindow) {
      return { allowed: false };
    }

    return { allowed: true };
  }

  /**
   * Record a message timestamp for rate limiting.
   *
   * Called only after successful routing.
   *
   * @param sourceChatId - The source chat identifier
   */
  private recordMessage(sourceChatId: string): void {
    const entry = this.rateLimitMap.get(sourceChatId);
    if (entry) {
      entry.timestamps.push(Date.now());
    } else {
      this.rateLimitMap.set(sourceChatId, { timestamps: [Date.now()] });
    }
  }
}
