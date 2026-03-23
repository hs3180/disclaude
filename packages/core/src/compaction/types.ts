/**
 * Compaction module type definitions.
 *
 * Defines types for framework-level auto compaction of agent sessions.
 * This provides consistent context management across different SDK providers,
 * independent of SDK-specific compaction behavior.
 *
 * @module compaction/types
 * @see Issue #1336
 */

/**
 * Compaction strategy.
 *
 * - `auto`: Use framework-level compaction based on context usage monitoring.
 *   The framework tracks token usage and triggers compaction when the threshold
 *   is reached, independent of SDK-specific compaction behavior.
 * - `sdk`: Delegate entirely to the SDK's built-in compaction.
 *   The framework only monitors and logs compaction events.
 * - `disabled`: No automatic compaction. Only manual compaction is available.
 */
export type CompactionStrategy = 'auto' | 'sdk' | 'disabled';

/**
 * Compaction configuration.
 *
 * Controls how the framework manages context compaction for active agent sessions.
 * Configured via `disclaude.config.yaml`:
 *
 * ```yaml
 * compaction:
 *   strategy: auto
 *   threshold: 0.85
 *   maxContextTokens: 200000
 * ```
 */
export interface CompactionConfig {
  /**
   * Compaction strategy (default: 'sdk').
   *
   * - `auto`: Framework monitors context and triggers compaction at threshold.
   * - `sdk`: SDK handles compaction; framework only monitors.
   * - `disabled`: No automatic compaction.
   */
  strategy?: CompactionStrategy;

  /**
   * Context usage threshold (0.0 - 1.0) to trigger compaction (default: 0.85).
   *
   * When `inputTokens / maxContextTokens >= threshold`, compaction is triggered.
   * Only used when strategy is 'auto'.
   */
  threshold?: number;

  /**
   * Maximum context tokens for the model (default: 200000).
   *
   * Used to calculate context usage ratio. Should match the model's
   * actual context window size.
   */
  maxContextTokens?: number;
}

/**
 * Resolved compaction configuration with defaults applied.
 */
export interface ResolvedCompactionConfig {
  readonly strategy: CompactionStrategy;
  readonly threshold: number;
  readonly maxContextTokens: number;
}

/**
 * Context usage statistics for a session.
 */
export interface ContextUsage {
  /** Current input token count (total context size) */
  inputTokens: number;
  /** Current output token count */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Estimated context usage ratio (0.0 - 1.0+) */
  usageRatio: number;
  /** Number of conversation turns tracked */
  turnCount: number;
  /** Number of compaction events that have occurred */
  compactionCount: number;
  /** Timestamp of the last compaction (ms since epoch) */
  lastCompactionAt: number | null;
  /** Timestamp of the last token update (ms since epoch) */
  lastUpdatedAt: number;
}

/**
 * Compaction event types.
 */
export type CompactionEventType =
  | 'usage_updated'
  | 'threshold_exceeded'
  | 'compaction_triggered'
  | 'sdk_compaction_detected'
  | 'compaction_completed';

/**
 * Compaction event emitted by CompactionManager.
 */
export interface CompactionEvent {
  /** Event type */
  type: CompactionEventType;
  /** Session identifier (chatId) */
  chatId: string;
  /** Context usage at time of event */
  usage: ContextUsage;
  /** Additional event data */
  data?: Record<string, unknown>;
}

/**
 * Callback for compaction events.
 */
export type CompactionEventCallback = (event: CompactionEvent) => void;

/**
 * Compaction manager configuration.
 */
export interface CompactionManagerConfig {
  /** Resolved compaction configuration */
  config: ResolvedCompactionConfig;
  /** Logger instance */
  logger: import('../utils/logger.js').Logger;
}

/**
 * Default compaction configuration values.
 */
export const DEFAULT_COMPACTION_CONFIG: ResolvedCompactionConfig = {
  strategy: 'sdk',
  threshold: 0.85,
  maxContextTokens: 200000,
} as const;
