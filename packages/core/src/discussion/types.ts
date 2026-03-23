/**
 * Discussion module types.
 *
 * Defines the data structures for managing offline discussions (Issue #631).
 * An offline discussion allows an agent to create a dedicated group chat,
 * spawn a ChatAgent to discuss a topic with users asynchronously,
 * and then execute follow-up actions based on the discussion results.
 *
 * @module core/discussion/types
 */

/**
 * Discussion topic definition.
 */
export interface DiscussionTopic {
  /** Discussion title (also used as group name) */
  title: string;
  /** Detailed description of the topic to discuss */
  description: string;
  /** Optional background context or reference materials */
  context?: string;
  /** Open IDs of users to invite to the discussion */
  participants?: string[];
}

/**
 * Possible follow-up actions after a discussion concludes.
 */
export interface DiscussionAction {
  /** Action type */
  type: 'add_skill' | 'add_schedule' | 'execute_task' | 'custom';
  /** Human-readable description of the action */
  description: string;
  /** Optional parameters for the action */
  params?: Record<string, unknown>;
}

/**
 * Result of a concluded discussion.
 */
export interface DiscussionResult {
  /** Outcome of the discussion */
  outcome: 'action_taken' | 'deferred' | 'cancelled';
  /** Summary of what was discussed and decided */
  summary: string;
  /** Follow-up actions to execute */
  actions?: DiscussionAction[];
}

/**
 * Discussion status lifecycle.
 *
 * ```
 * creating → active → concluded
 *                  → expired
 * ```
 */
export type DiscussionStatus = 'creating' | 'active' | 'concluded' | 'expired';

/**
 * Persistent record of a discussion.
 */
export interface DiscussionRecord {
  /** Unique discussion ID */
  id: string;
  /** Feishu chat ID of the discussion group */
  chatId: string;
  /** Chat ID where the discussion was initiated (source) */
  sourceChatId: string;
  /** Open ID of the user who initiated the discussion */
  creatorOpenId?: string;
  /** Discussion topic */
  topic: DiscussionTopic;
  /** Current status */
  status: DiscussionStatus;
  /** Creation timestamp (epoch ms) */
  createdAt: number;
  /** Last update timestamp (epoch ms) */
  updatedAt: number;
  /** When the discussion was concluded (epoch ms) */
  concludedAt?: number;
  /** Result of the discussion (set when concluded) */
  result?: DiscussionResult;
}

/**
 * Options for creating a new discussion.
 */
export interface CreateDiscussionOptions {
  /** Discussion topic */
  topic: DiscussionTopic;
  /** Chat ID where the discussion is being initiated from */
  sourceChatId: string;
  /** Open ID of the user initiating the discussion */
  creatorOpenId?: string;
  /** Maximum duration in minutes before auto-expiry (default: 1440 = 24h) */
  maxDurationMinutes?: number;
}

/**
 * Options for concluding a discussion.
 */
export interface ConcludeDiscussionOptions {
  /** Discussion chat ID */
  chatId: string;
  /** Discussion result */
  result: DiscussionResult;
}

/**
 * Discussion manager configuration.
 */
export interface DiscussionManagerConfig {
  /** Default max duration in minutes before auto-expiry */
  defaultMaxDurationMinutes?: number;
  /** Persistence file path (optional, disables persistence if not set) */
  persistencePath?: string;
}
