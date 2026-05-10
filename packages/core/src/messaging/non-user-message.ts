/**
 * NonUserMessage — System-driven message type for routing to ChatAgent instances.
 *
 * NonUserMessage represents messages originating from non-user sources:
 * - Scheduled tasks (cron, interval)
 * - Agent-to-Agent (A2A) delegation
 * - Webhook callbacks
 * - System control messages
 *
 * Key design: NonUserMessage carries no `chatId`. The chatId is bound to
 * the ChatAgent at initialization time (see Issue #3332).
 * The NonUserMessageRouter resolves projectKey → chatId → ChatAgent.
 *
 * @see Issue #3331 (NonUserMessage type definition and routing layer)
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 */

// ============================================================================
// NonUserMessage Type
// ============================================================================

/**
 * The source type of a NonUserMessage.
 *
 * - `scheduled`: Triggered by the scheduler (cron, interval, one-shot)
 * - `a2a`: Agent-to-Agent task delegation
 * - `webhook`: External webhook callback
 * - `system`: System-level control or status message
 */
export type NonUserMessageType = 'scheduled' | 'a2a' | 'webhook' | 'system';

/**
 * Priority level for NonUserMessage routing.
 *
 * Higher priority messages may preempt queued lower-priority messages.
 */
export type NonUserMessagePriority = 'low' | 'normal' | 'high';

/**
 * NonUserMessage — a message from a non-user source routed to a ChatAgent.
 *
 * Unlike user messages (IncomingMessage), NonUserMessage does not carry a chatId.
 * The routing layer resolves projectKey → chatId → ChatAgent.
 *
 * @example
 * ```typescript
 * const msg: NonUserMessage = {
 *   id: 'sched-1234567890',
 *   type: 'scheduled',
 *   source: 'scheduler:daily-sync',
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'Run daily issue triage for this project',
 *   priority: 'normal',
 *   createdAt: new Date().toISOString(),
 * };
 * ```
 */
export interface NonUserMessage {
  /** Unique message identifier (e.g., 'sched-1234567890', 'a2a-uuid-xxx') */
  id: string;

  /** Source type of the message */
  type: NonUserMessageType;

  /**
   * Origin identifier (e.g., 'scheduler:daily-sync', 'chat:oc_xxx', 'webhook:github').
   * Used for logging and debugging.
   */
  source: string;

  /**
   * Target project key (e.g., 'hs3180/disclaude').
   * The router resolves this to a chatId via project configuration.
   */
  projectKey: string;

  /**
   * Free-form instruction or structured data payload.
   * This becomes the text input to ChatAgent.processMessage().
   */
  payload: string;

  /** Priority level for routing and queue ordering */
  priority: NonUserMessagePriority;

  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ============================================================================
// Routing Result Types
// ============================================================================

/**
 * Result of a routing attempt.
 */
export type RouteResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

/**
 * Route error reasons for structured error handling.
 */
export enum RouteError {
  /** Project not found in configuration */
  PROJECT_NOT_FOUND = 'project_not_found',
  /** ChatAgent is busy and message was queued */
  QUEUED = 'queued',
  /** Router has been disposed */
  DISPOSED = 'disposed',
}
