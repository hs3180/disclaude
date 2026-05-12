/**
 * NonUserMessage type definition.
 *
 * System-driven messages that are not initiated by users.
 * Used by scheduler, A2A messaging, and other automated flows
 * to deliver tasks to project-bound ChatAgents.
 *
 * Issue #3331: NonUserMessage type definition and routing layer.
 * Issue #3333: Scheduler integration with NonUserMessage.
 *
 * @module @disclaude/core/types
 */

/**
 * Priority levels for NonUserMessage routing.
 */
export type NonUserMessagePriority = 'high' | 'normal' | 'low';

/**
 * NonUserMessage — a message not initiated by a user.
 *
 * Routed through NonUserMessageRouter to a project-bound ChatAgent
 * based on the `projectKey` field.
 */
export interface NonUserMessage {
  /** Unique message ID */
  id: string;
  /** Message type discriminator (e.g., 'scheduled', 'a2a') */
  type: string;
  /** Source identifier (e.g., 'scheduler:Daily Report') */
  source: string;
  /** Project key for routing to a project-bound agent */
  projectKey: string;
  /** Message payload (prompt text) */
  payload: string;
  /** Priority for queue ordering */
  priority: NonUserMessagePriority;
  /** ISO timestamp of message creation */
  createdAt: string;
}

/**
 * Result of routing a NonUserMessage.
 */
export interface NonUserMessageRouteResult {
  /** Whether routing succeeded */
  routed: boolean;
  /** Chat ID the message was routed to */
  chatId?: string;
  /** Error message if routing failed */
  error?: string;
}

/**
 * Project binding information returned by project lookup.
 */
export interface ProjectBinding {
  /** Chat ID bound to this project */
  chatId: string;
  /** Working directory for the project */
  workingDir: string;
}

/**
 * Function type for looking up project bindings by project key.
 *
 * Uses dependency injection to decouple the router from ProjectManager.
 */
export type ProjectLookupFn = (projectKey: string) => Promise<ProjectBinding | undefined>;
