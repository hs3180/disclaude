/**
 * Polling module type definitions.
 *
 * Defines types for lightweight poll/survey functionality.
 * Implements "方案 C: 内置轻量调查" from Issue #2191.
 *
 * @module core/polling/types
 */

/**
 * A single option within a poll.
 */
export interface PollOption {
  /** Unique option identifier (e.g., "option_a", "option_b") */
  id: string;
  /** Display text for the option */
  text: string;
}

/**
 * A recorded vote from a participant.
 */
export interface PollVote {
  /** Voter identifier (open_id or anonymous hash) */
  voterId: string;
  /** ID of the chosen option */
  optionId: string;
  /** ISO timestamp when the vote was cast */
  votedAt: string;
}

/**
 * A poll with its question, options, and recorded votes.
 */
export interface Poll {
  /** Unique poll identifier */
  id: string;
  /** The poll question */
  question: string;
  /** Available options */
  options: PollOption[];
  /** All recorded votes */
  votes: PollVote[];
  /** Chat ID where the poll was created */
  chatId: string;
  /** ISO timestamp when the poll was created */
  createdAt: string;
  /** Optional ISO timestamp when the poll expires */
  expiresAt?: string;
  /** Whether the poll is anonymous (voter IDs are hashed) */
  anonymous: boolean;
  /** Whether the poll is closed (no more votes accepted) */
  closed: boolean;
  /** Optional creator identifier */
  creatorId?: string;
  /** Optional poll description/context */
  description?: string;
}

/**
 * Aggregated result for a single option.
 */
export interface PollOptionResult {
  /** Option ID */
  id: string;
  /** Option text */
  text: string;
  /** Number of votes */
  voteCount: number;
  /** Percentage of total votes (0-100, 1 decimal) */
  percentage: number;
}

/**
 * Complete poll results with aggregated data.
 */
export interface PollResults {
  /** Poll ID */
  pollId: string;
  /** Poll question */
  question: string;
  /** Results for each option */
  results: PollOptionResult[];
  /** Total number of votes */
  totalVotes: number;
  /** Whether the poll is closed */
  closed: boolean;
  /** Whether the poll is expired */
  expired: boolean;
}

/**
 * Options for creating a new poll.
 */
export interface CreatePollOptions {
  /** The poll question */
  question: string;
  /** Poll options (at least 2 required) */
  options: Array<{ text: string }>;
  /** Target chat ID */
  chatId: string;
  /** Optional ISO timestamp when the poll expires */
  expiresAt?: string;
  /** Whether the poll is anonymous (default: true) */
  anonymous?: boolean;
  /** Optional creator identifier */
  creatorId?: string;
  /** Optional poll description */
  description?: string;
}

/**
 * Options for recording a vote.
 */
export interface RecordVoteOptions {
  /** Poll ID */
  pollId: string;
  /** ID of the chosen option */
  optionId: string;
  /** Voter identifier */
  voterId: string;
}

/**
 * Validation result for poll operations.
 */
export interface PollValidationError {
  valid: false;
  error: string;
}
