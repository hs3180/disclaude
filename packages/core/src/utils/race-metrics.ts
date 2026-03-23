/**
 * Race Metrics Collector - Lightweight agent execution metrics logging.
 *
 * Collects performance metrics during agent execution and outputs a
 * structured log entry with the `race-metrics` keyword for easy filtering.
 *
 * This enables post-hoc analysis of agent framework performance across
 * different providers, models, and task types without adding complex
 * benchmarking infrastructure.
 *
 * Usage:
 * ```typescript
 * const collector = new RaceMetricsCollector({
 *   agentType: 'skillAgent',
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-20250514',
 *   taskType: 'coding',
 * });
 *
 * for (const message of agentStream) {
 *   collector.recordMessage(message);
 *   // ... process message
 * }
 *
 * collector.finalize(); // Logs the race-metrics summary
 * ```
 *
 * @module utils/race-metrics
 */

import { createLogger, type Logger } from './logger.js';
import type { AgentMessageMetadata } from '../sdk/types.js';

/**
 * Structured race metrics output.
 */
export interface RaceMetrics {
  /** Log keyword for filtering */
  keyword: 'race-metrics';
  /** Agent type (e.g., 'skillAgent', 'chatAgent', 'scheduleAgent') */
  agentType: string;
  /** Provider name (e.g., 'anthropic', 'openai') */
  provider: string;
  /** Model identifier (e.g., 'claude-sonnet-4-20250514') */
  model: string;
  /** Task category (e.g., 'coding', 'analysis', 'discussion') */
  taskType: string;
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens generated */
  outputTokens: number;
  /** Total cost in USD */
  costUsd: number;
  /** Number of tool calls made during execution */
  toolCalls: number;
  /** Whether the execution completed successfully */
  success: boolean;
  /** ISO timestamp of the metrics snapshot */
  timestamp: string;
}

/**
 * Configuration for RaceMetricsCollector.
 */
export interface RaceMetricsCollectorOptions {
  /** Agent type identifier */
  agentType: string;
  /** Provider name */
  provider: string;
  /** Model identifier */
  model: string;
  /** Task category */
  taskType: string;
  /** Optional custom logger instance */
  logger?: Logger;
}

/**
 * Collects and aggregates agent execution metrics.
 *
 * Designed to be lightweight — just accumulate numbers from message metadata
 * and log a single structured summary when execution completes.
 */
export class RaceMetricsCollector {
  private readonly options: RaceMetricsCollectorOptions;
  private readonly logger: Logger;

  private totalElapsedMs = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private toolCallCount = 0;
  private hasError = false;
  private finalized = false;

  constructor(options: RaceMetricsCollectorOptions) {
    this.options = options;
    this.logger = options.logger ?? createLogger('RaceMetrics');
  }

  /**
   * Record metrics from a single agent message.
   *
   * Should be called for every message yielded by the agent during execution.
   * Accumulates token counts, costs, and timing from message metadata.
   * Counts tool_use messages as tool calls.
   *
   * @param metadata - Message metadata containing execution metrics
   * @param messageType - The message type (used to count tool calls and detect errors)
   */
  recordMessage(metadata: AgentMessageMetadata | undefined, messageType?: string): void {
    if (!metadata) return;

    if (metadata.elapsedMs !== undefined) {
      this.totalElapsedMs += metadata.elapsedMs;
    }
    if (metadata.inputTokens !== undefined) {
      this.totalInputTokens += metadata.inputTokens;
    }
    if (metadata.outputTokens !== undefined) {
      this.totalOutputTokens += metadata.outputTokens;
    }
    if (metadata.costUsd !== undefined) {
      this.totalCostUsd += metadata.costUsd;
    }

    // Count tool calls from tool_use messages
    if (messageType === 'tool_use') {
      this.toolCallCount++;
    }

    // Track errors
    if (messageType === 'error') {
      this.hasError = true;
    }
  }

  /**
   * Record a tool call (alternative to counting from message types).
   */
  recordToolCall(): void {
    this.toolCallCount++;
  }

  /**
   * Mark the execution as failed.
   */
  markFailed(): void {
    this.hasError = true;
  }

  /**
   * Finalize collection and log the race-metrics summary.
   *
   * Outputs a structured log entry at 'info' level with the `race-metrics`
   * keyword for easy filtering in log aggregation systems.
   *
   * @returns The collected race metrics
   */
  finalize(): RaceMetrics {
    if (this.finalized) {
      return this.buildMetrics();
    }

    this.finalized = true;

    const metrics = this.buildMetrics();

    this.logger.info(metrics, 'Agent execution metrics');

    return metrics;
  }

  /**
   * Build the RaceMetrics object from accumulated data.
   */
  private buildMetrics(): RaceMetrics {
    return {
      keyword: 'race-metrics',
      agentType: this.options.agentType,
      provider: this.options.provider,
      model: this.options.model,
      taskType: this.options.taskType,
      elapsedMs: this.totalElapsedMs,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      costUsd: Math.round(this.totalCostUsd * 1e6) / 1e6, // Round to 6 decimal places
      toolCalls: this.toolCallCount,
      success: !this.hasError,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get the current accumulated metrics without finalizing.
   */
  getSnapshot(): Omit<RaceMetrics, 'keyword' | 'timestamp'> {
    return {
      agentType: this.options.agentType,
      provider: this.options.provider,
      model: this.options.model,
      taskType: this.options.taskType,
      elapsedMs: this.totalElapsedMs,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      costUsd: Math.round(this.totalCostUsd * 1e6) / 1e6,
      toolCalls: this.toolCallCount,
      success: !this.hasError,
    };
  }
}
