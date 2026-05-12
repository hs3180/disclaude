/**
 * NonUserMessage type definition — system-driven messages for Agent routing.
 *
 * NonUserMessage represents messages that originate from system sources
 * (scheduler, A2A delegation, webhooks, system events) rather than direct
 * user input. The NonUserMessageRouter delivers these to the appropriate
 * ChatAgent based on project configuration.
 *
 * Key design: NonUserMessage carries no `chatId`. The chatId is bound
 * to the ChatAgent at initialization time (see Issue #3332).
 *
 * @see Issue #3331 (NonUserMessage type definition and routing layer)
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 */

// ============================================================================
// NonUserMessage Type
// ============================================================================

/**
 * Discriminator for the source of a NonUserMessage.
 *
 * - `scheduled`: Triggered by the cron-based Scheduler
 * - `a2a`: Agent-to-Agent task delegation
 * - `webhook`: External webhook (e.g., GitHub webhook)
 * - `system`: Internal system event (e.g., startup notification)
 */
export type NonUserMessageType = 'scheduled' | 'a2a' | 'webhook' | 'system';

/**
 * Priority level for NonUserMessage routing.
 *
 * Higher-priority messages may bypass queue or receive preferential treatment.
 * The router processes messages in priority order when dequeuing.
 */
export type NonUserMessagePriority = 'low' | 'normal' | 'high';

/**
 * NonUserMessage — a system-driven message routed to a ChatAgent.
 *
 * Unlike user-originated `IncomingMessage`, NonUserMessage does not carry
 * a `chatId`. Instead, the `projectKey` is used to look up the bound
 * ChatAgent via project configuration.
 *
 * The `payload` field contains the instruction or data that the target
 * ChatAgent should process. It is passed directly to
 * `ChatAgent.processMessage()` as the text argument.
 */
export interface NonUserMessage {
  /** Unique message identifier (UUID recommended) */
  id: string;

  /** Message source discriminator */
  type: NonUserMessageType;

  /**
   * Origin identifier for tracing.
   * Examples: 'scheduler:daily-sync', 'a2a:agent-oc_xxx', 'webhook:github-push'
   */
  source: string;

  /**
   * Project key to resolve the target ChatAgent.
   * Example: 'hs3180/disclaude'
   */
  projectKey: string;

  /** Free-form instruction or structured data for the target agent */
  payload: string;

  /** Priority for routing and queue ordering */
  priority: NonUserMessagePriority;

  /** ISO 8601 timestamp when the message was created */
  createdAt: string;
}

// ============================================================================
// Routing Result Types
// ============================================================================

/**
 * Result of a routing attempt.
 */
export type NonUserMessageRouteResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

// ============================================================================
// Project Binding (for router's project lookup)
// ============================================================================

/**
 * Project binding resolved by the router to deliver messages.
 *
 * Maps a projectKey to a chatId and working directory.
 */
export interface ProjectBinding {
  /** Chat ID bound to this project */
  chatId: string;

  /** Working directory for the project agent */
  workingDir: string;
}
