/**
 * NonUserMessage type definitions — system-driven task pipeline for ChatAgent.
 *
 * NonUserMessage enables ChatAgent to receive tasks from system sources
 * (scheduled triggers, A2A events, webhook callbacks) in addition to
 * user messages. Combined with project-scoped working directories, this
 * enables ChatAgent to autonomously handle repository maintenance, deep
 * tasks, and batch operations.
 *
 * Key design: NonUserMessage carries no `chatId`. The chatId is bound
 * to the ChatAgent at initialization time. All agent output naturally
 * flows to this bound chatId via the existing message routing.
 *
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline for ChatAgent 0.4.0)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NonUserMessage Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * The type of system source that produced this NonUserMessage.
 *
 * - `scheduled`: Triggered by the cron-based scheduler
 * - `a2a`: Delegated by another ChatAgent (Agent-to-Agent)
 * - `webhook`: Triggered by an external HTTP webhook
 * - `system`: Generic system-originated task (e.g., admin command)
 */
export type NonUserMessageType = 'scheduled' | 'a2a' | 'webhook' | 'system';

/**
 * Priority level for NonUserMessage routing.
 *
 * Higher-priority messages are processed before lower-priority ones
 * when an agent is busy and multiple messages are queued.
 */
export type NonUserMessagePriority = 'low' | 'normal' | 'high';

/**
 * NonUserMessage — a message originating from the system rather than a user.
 *
 * This is the core input type for the system-driven task pipeline.
 * ChatAgent processes it identically to user messages — the only difference
 * is the input source and (potentially) the working directory.
 *
 * **NonUserMessage carries no `chatId`.** The chatId is bound to the
 * ChatAgent at initialization time (from project configuration).
 * All agent output (progress, results, notifications) naturally flows
 * to this bound chatId via the existing message routing.
 */
export interface NonUserMessage {
  /** Unique message identifier (UUID or similar) */
  id: string;

  /** Type of system source that produced this message */
  type: NonUserMessageType;

  /**
   * Origin source identifier for traceability.
   * Format depends on type:
   * - scheduled: `'scheduler:{taskName}'`
   * - a2a: `'chat:{chatId}'`
   * - webhook: `'webhook:{routeName}'`
   * - system: `'system:{commandName}'`
   */
  source: string;

  /**
   * Target project key (e.g., 'hs3180/disclaude').
   * The router uses this to look up the project configuration
   * and find the bound chatId for routing.
   */
  projectKey: string;

  /**
   * Free-form instruction or structured data payload.
   * This becomes the `text` parameter to `ChatAgent.processMessage()`.
   */
  payload: string;

  /** Message priority for queue ordering */
  priority: NonUserMessagePriority;

  /** ISO 8601 timestamp when this message was created */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Project Config for Routing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Project configuration for NonUserMessage routing.
 *
 * Defines how to route a NonUserMessage to the correct ChatAgent:
 * 1. Look up project by `projectKey`
 * 2. Find the bound `chatId`
 * 3. Get or create a ChatAgent for that `chatId`
 * 4. Deliver the message payload
 *
 * This interface is provided by the project configuration system
 * (e.g., `disclaude.config.yaml` or ProjectManager extensions).
 */
export interface ProjectRoutingConfig {
  /** Project key (unique identifier, e.g., 'hs3180/disclaude') */
  key: string;

  /** Bound chatId — agent replies go here */
  chatId: string;

  /** Project working directory (agent's cwd) */
  workingDir: string;

  /** Default model tier for this project (optional) */
  modelTier?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Router Result Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Result of a NonUserMessage routing operation.
 */
export type RouteResult =
  | { ok: true; queued: boolean }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Router Dependencies (interfaces for DI)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Interface for looking up project routing configuration.
 *
 * Implemented by ProjectManager (or its extension) to provide
 * project-to-chatId mappings for the NonUserMessageRouter.
 */
export interface IProjectRoutingProvider {
  /**
   * Look up routing configuration for a project.
   *
   * @param projectKey - The project key to look up
   * @returns Project routing config, or undefined if not found
   */
  getRoutingConfig(projectKey: string): ProjectRoutingConfig | undefined;
}

/**
 * Interface for delivering messages to ChatAgent instances.
 *
 * Implemented by AgentPool to provide get-or-create semantics
 * for ChatAgent instances and message delivery.
 */
export interface IAgentMessageDelivery {
  /**
   * Check if an agent is currently processing a message.
   *
   * @param chatId - The chat identifier
   * @returns true if the agent is busy
   */
  isAgentBusy(chatId: string): boolean;

  /**
   * Deliver a message payload to the ChatAgent for the given chatId.
   *
   * @param chatId - The target chat identifier
   * @param payload - The message payload
   */
  deliverMessage(chatId: string, payload: string): void;
}
