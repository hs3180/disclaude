/**
 * NonUserMessage type definition for Agent-to-Agent (A2A) task delegation.
 *
 * NonUserMessage represents a message not originating from a human user,
 * but from another agent, the scheduler, or a system process.
 *
 * @see Issue #3334 (A2A messaging — Agent-to-Agent task delegation)
 * @see Issue #3331 (NonUserMessage type definition and routing layer)
 */

// ============================================================================
// NonUserMessage Type
// ============================================================================

/**
 * Discriminator for the source of a NonUserMessage.
 */
export type NonUserMessageType = 'a2a' | 'scheduler' | 'system';

/**
 * Priority levels for NonUserMessage processing.
 */
export type NonUserMessagePriority = 'low' | 'normal' | 'high';

/**
 * A message not originating from a human user.
 *
 * Used for Agent-to-Agent task delegation, scheduler-triggered prompts,
 * and system notifications.
 */
export interface NonUserMessage {
  /** Unique message identifier */
  id: string;
  /** Discriminator for message source type */
  type: NonUserMessageType;
  /** Source identifier (e.g., 'chat:oc_xxx' for A2A, 'scheduler:task-123') */
  source: string;
  /** Target project key (e.g., 'hs3180/disclaude') */
  projectKey: string;
  /** Task instruction / message payload */
  payload: string;
  /** Processing priority */
  priority: NonUserMessagePriority;
  /** ISO 8601 timestamp */
  createdAt: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate a unique ID for a NonUserMessage */
export function generateNonUserMessageId(): string {
  return `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create an A2A NonUserMessage */
export function createA2AMessage(options: {
  source: string;
  projectKey: string;
  payload: string;
  priority?: NonUserMessagePriority;
}): NonUserMessage {
  return {
    id: generateNonUserMessageId(),
    type: 'a2a',
    source: options.source,
    projectKey: options.projectKey,
    payload: options.payload,
    priority: options.priority ?? 'normal',
    createdAt: new Date().toISOString(),
  };
}
