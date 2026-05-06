/**
 * NonUserMessage type definitions for system-driven task pipeline.
 *
 * Introduces NonUserMessage — a new input type that allows ChatAgent to receive
 * and process tasks from system sources (scheduled triggers, A2A events,
 * webhook callbacks) in addition to user messages.
 *
 * Key Design:
 * - NonUserMessage carries NO chatId — the chatId is bound to the ChatAgent
 *   at initialization time via project config.
 * - The router resolves projectKey → bound chatId → AgentPool.getOrCreate()
 * - ChatAgent processes NonUserMessage identically to user messages via
 *   processMessage(chatId, payload, 'system')
 *
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessage Source Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Origin type of a NonUserMessage.
 *
 * - `scheduled`: Triggered by ScheduleManager (cron-based)
 * - `a2a`: Delegated from another ChatAgent instance
 * - `webhook`: Triggered by external webhook callback (future)
 * - `system`: Internal system event (startup, config change, etc.)
 */
export type NonUserMessageSource = 'scheduled' | 'a2a' | 'webhook' | 'system';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessage Priority
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Priority level for NonUserMessage routing.
 *
 * - `low`: Routine maintenance, reports, non-urgent tasks
 * - `normal`: Standard task execution
 * - `high`: Urgent tasks that should preempt lower-priority messages
 */
export type NonUserMessagePriority = 'low' | 'normal' | 'high';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessage Interface
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A message that originates from the system rather than a user.
 *
 * NonUserMessage carries no chatId. The chatId is bound to the ChatAgent
 * at initialization time from the project configuration. All agent output
 * (progress, results, notifications) flows to the bound chatId via the
 * existing message routing — just like user-driven messages.
 *
 * @example
 * ```typescript
 * // From scheduler
 * const msg: NonUserMessage = {
 *   id: 'msg_abc123',
 *   type: 'scheduled',
 *   source: 'scheduler:daily-sync',
 *   projectKey: 'hs3180/disclaude',
 *   payload: 'Daily sync and triage. Read .disclaude/project-state.json...',
 *   priority: 'low',
 *   createdAt: new Date().toISOString(),
 * };
 * ```
 */
export interface NonUserMessage {
  /** Unique message identifier */
  id: string;

  /** Origin type of this message */
  type: NonUserMessageSource;

  /**
   * Source identifier for traceability.
   * e.g., 'scheduler:daily-sync', 'chat:oc_xxx', 'webhook:github/issues'
   */
  source: string;

  /**
   * Project key this message is destined for.
   * Used by NonUserMessageRouter to look up the bound chatId.
   * e.g., 'hs3180/disclaude'
   */
  projectKey: string;

  /** Free-form instruction or structured data (passed to ChatAgent as text) */
  payload: string;

  /** Message priority for queue ordering */
  priority: NonUserMessagePriority;

  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Project Configuration (for chatId binding)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Configuration for a project that can receive NonUserMessages.
 *
 * Extends the existing ProjectContextConfig with a chatId binding,
 * allowing the NonUserMessageRouter to deliver messages to the
 * correct ChatAgent instance.
 */
export interface NonUserProjectConfig {
  /** Project key (e.g., 'hs3180/disclaude') */
  key: string;

  /** Project working directory (Agent discovers CLAUDE.md here) */
  workingDir: string;

  /**
   * Bound chat ID — agent replies go here.
   * This is a real chat (e.g., a Feishu group for project maintenance).
   */
  chatId: string;

  /** Default model tier for scheduled tasks (optional) */
  modelTier?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessageRouter Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Result of routing a NonUserMessage.
 */
export type NonUserMessageRouteResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

/**
 * Handler function type for processing a routed NonUserMessage.
 *
 * Receives the resolved chatId and the message payload.
 * The handler is responsible for delivering the message to ChatAgent
 * via processMessage(chatId, payload, 'system').
 */
export type NonUserMessageHandler = (
  chatId: string,
  message: NonUserMessage
) => Promise<void>;

/**
 * Logger interface for NonUserMessageRouter.
 */
export interface NonUserMessageRouterLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Configuration for NonUserMessageRouter.
 */
export interface NonUserMessageRouterConfig {
  /** Handler function called when a message is routed successfully */
  handler: NonUserMessageHandler;

  /** Optional logger */
  logger?: NonUserMessageRouterLogger;
}
