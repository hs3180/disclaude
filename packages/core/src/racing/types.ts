/**
 * Agent Framework Racing - Type Definitions
 *
 * Types for benchmarking different Agent SDK Providers
 * against each other on the same task.
 *
 * @module racing/types
 */

import type { AgentMessage, AgentQueryOptions } from '../sdk/index.js';

// ============================================================================
// Race Participant Configuration
// ============================================================================

/**
 * Configuration for a single race participant (provider/model combo).
 */
export interface RaceParticipantConfig {
  /** Unique identifier for this participant */
  id: string;
  /** Human-readable name */
  name: string;
  /** Provider type (e.g., 'claude', 'openai', 'glm') */
  providerType: string;
  /** Model identifier (e.g., 'claude-sonnet-4-20250514') */
  model: string;
  /** Optional API base URL override */
  apiBaseUrl?: string;
  /** Optional API key override */
  apiKey?: string;
  /** Optional: extra query options for this participant */
  queryOptions?: Partial<AgentQueryOptions>;
}

// ============================================================================
// Race Task Configuration
// ============================================================================

/**
 * Race execution mode.
 *
 * - `queryOnce`: Single-shot task execution (SkillAgent pattern)
 * - `queryStream`: Streaming conversation (ChatAgent pattern)
 */
export type RaceMode = 'queryOnce' | 'queryStream';

/**
 * A single race task definition.
 */
export interface RaceTask {
  /** Unique identifier for this task */
  id: string;
  /** Human-readable description */
  description: string;
  /** Task category for grouping (e.g., 'coding', 'reasoning', 'creative') */
  category: string;
  /** Input to send to each participant */
  input: string;
  /** Race execution mode */
  mode: RaceMode;
  /**
   * Expected output or evaluation criteria.
   * If provided, used for automatic quality evaluation.
   * If a string, treated as expected output substring.
   * If a function, called with the actual output for custom evaluation.
   */
  expectedOutput?: string | ((output: string) => boolean | Promise<boolean>);
  /**
   * Maximum execution time per participant in milliseconds.
   * @default 120000 (2 minutes)
   */
  timeout?: number;
}

/**
 * Predefined task categories with suggested inputs.
 */
export interface TaskCategory {
  /** Category identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this category tests */
  description: string;
  /** Suggested sample tasks */
  sampleTasks: Omit<RaceTask, 'id'>[];
}

// ============================================================================
// Race Configuration
// ============================================================================

/**
 * Full race configuration.
 */
export interface RaceConfig {
  /** Unique race identifier */
  id: string;
  /** Human-readable race name */
  name: string;
  /** Race description */
  description?: string;
  /** Participants (providers/models to benchmark) */
  participants: RaceParticipantConfig[];
  /** Tasks to execute */
  tasks: RaceTask[];
  /**
   * Whether to run participants in parallel or sequentially.
   * @default true
   */
  parallel?: boolean;
  /**
   * Maximum concurrent races across all participants and tasks.
   * Only applicable when parallel is true.
   * @default 3
   */
  maxConcurrency?: number;
  /**
   * Common query options applied to all participants.
   * Participant-specific options are merged on top.
   */
  commonQueryOptions?: Partial<AgentQueryOptions>;
  /**
   * Optional callbacks for race lifecycle events.
   */
  callbacks?: RaceCallbacks;
}

// ============================================================================
// Race Execution Results
// ============================================================================

/**
 * Metrics collected from a single participant execution.
 */
export interface RaceParticipantMetrics {
  /** Total execution time in milliseconds */
  totalElapsedMs: number;
  /** Time to first token in milliseconds (TTFB) */
  timeToFirstTokenMs?: number;
  /** Time to last token in milliseconds */
  timeToLastTokenMs?: number;
  /** Total input tokens */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Total cost in USD */
  costUsd: number;
  /** Number of tool calls made */
  toolCallCount: number;
  /** Number of messages produced */
  messageCount: number;
  /** Whether the execution timed out */
  timedOut: boolean;
  /** Whether the execution encountered an error */
  hasError: boolean;
  /** Error message if hasError is true */
  errorMessage?: string;
}

/**
 * Result of evaluating quality against expected output.
 */
export interface QualityEvaluation {
  /** Whether the output passes the quality check */
  passed: boolean;
  /** Optional score from 0 to 1 (1 = perfect) */
  score?: number;
  /** Optional feedback on why it passed/failed */
  feedback?: string;
}

/**
 * Complete result for a single participant on a single task.
 */
export interface RaceParticipantResult {
  /** Participant configuration */
  participant: RaceParticipantConfig;
  /** Task configuration */
  task: RaceTask;
  /** Execution metrics */
  metrics: RaceParticipantMetrics;
  /** Full output text (concatenated from all text messages) */
  outputText: string;
  /** Raw messages received */
  rawMessages: AgentMessage[];
  /** Quality evaluation result (if expectedOutput was provided) */
  quality?: QualityEvaluation;
  /** Timestamp when execution started */
  startedAt: number;
  /** Timestamp when execution completed */
  completedAt: number;
}

/**
 * Result for a single task across all participants.
 */
export interface RaceTaskResult {
  /** Task configuration */
  task: RaceTask;
  /** Results from each participant */
  participantResults: RaceParticipantResult[];
  /** Ranking of participants by score (best first) */
  rankings: RaceRanking[];
}

/**
 * Ranking entry for a participant.
 */
export interface RaceRanking {
  /** Participant ID */
  participantId: string;
  /** Participant name */
  participantName: string;
  /** Rank position (1 = best) */
  rank: number;
  /** Computed score */
  score: number;
  /** Score breakdown by criterion */
  scoreBreakdown: Record<RankingCriterion, number>;
  /** Highlight: why this participant ranked here */
  highlight?: string;
}

/**
 * Scoring criteria for ranking.
 */
export type RankingCriterion = 'speed' | 'cost' | 'quality' | 'tokens';

/**
 * Weight configuration for ranking criteria.
 * All weights should sum to 1.0.
 */
export interface RankingWeights {
  /** Weight for speed score (lower time = higher score) */
  speed: number;
  /** Weight for cost score (lower cost = higher score) */
  cost: number;
  /** Weight for quality score (from expectedOutput evaluation) */
  quality: number;
  /** Weight for token efficiency (lower tokens = higher score) */
  tokens: number;
}

/**
 * Complete race result across all tasks.
 */
export interface RaceResult {
  /** Race configuration */
  config: RaceConfig;
  /** Results for each task */
  taskResults: RaceTaskResult[];
  /** Overall standings across all tasks */
  overallStandings: RaceRanking[];
  /** Timestamp when race started */
  startedAt: number;
  /** Timestamp when race completed */
  completedAt: number;
  /** Total race duration in milliseconds */
  totalDurationMs: number;
}

// ============================================================================
// Race Callbacks
// ============================================================================

/**
 * Callbacks for race lifecycle events.
 */
export interface RaceCallbacks {
  /** Called when a race starts */
  onRaceStart?: (config: RaceConfig) => void | Promise<void>;
  /** Called when a single participant starts a task */
  onParticipantStart?: (participant: RaceParticipantConfig, task: RaceTask) => void | Promise<void>;
  /** Called when a single participant completes a task */
  onParticipantComplete?: (result: RaceParticipantResult) => void | Promise<void>;
  /** Called when a task is fully complete (all participants done) */
  onTaskComplete?: (taskResult: RaceTaskResult) => void | Promise<void>;
  /** Called when the entire race is complete */
  onRaceComplete?: (result: RaceResult) => void | Promise<void>;
  /** Called on any error during race execution */
  onError?: (error: Error, context: { participant?: RaceParticipantConfig; task?: RaceTask }) => void | Promise<void>;
}

// ============================================================================
// Race State
// ============================================================================

/**
 * Current state of a race.
 */
export type RaceState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Progress of a running race.
 */
export interface RaceProgress {
  /** Current race state */
  state: RaceState;
  /** Race configuration */
  config: RaceConfig;
  /** Completed task count */
  completedTasks: number;
  /** Total task count */
  totalTasks: number;
  /** Completed participant executions */
  completedParticipants: number;
  /** Total participant executions (participants × tasks) */
  totalParticipants: number;
  /** Current error if state is 'failed' */
  error?: string;
}
