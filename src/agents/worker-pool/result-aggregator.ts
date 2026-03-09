/**
 * Result Aggregator - Aggregates results from multiple worker tasks.
 *
 * Issue #897 Phase 2: Master-Workers multi-agent collaboration pattern.
 *
 * Features:
 * - Multiple aggregation strategies
 * - Result deduplication
 * - Progress tracking
 * - Summary generation
 *
 * @module agents/worker-pool/result-aggregator
 */

import { createLogger } from '../../utils/logger.js';
import type { TaskResult, TaskStatus } from './types.js';

const logger = createLogger('ResultAggregator');

// ============================================================================
// Aggregation Types
// ============================================================================

/**
 * Strategy for aggregating results.
 */
export type AggregationStrategy =
  | 'concat'      // Concatenate all outputs
  | 'summarize'   // Generate a summary
  | 'merge'       // Merge structured data
  | 'best';       // Select the best result

/**
 * Options for result aggregation.
 */
export interface AggregationOptions {
  /** Aggregation strategy */
  strategy?: AggregationStrategy;
  /** Maximum output length (for concat) */
  maxLength?: number;
  /** Include failed tasks in output */
  includeFailed?: boolean;
  /** Sort results by task ID */
  sortByTaskId?: boolean;
  /** Custom separator for concatenation */
  separator?: string;
  /** Selector for best result (for 'best' strategy) */
  bestSelector?: (results: TaskResult[]) => TaskResult;
}

/**
 * Aggregated result from multiple tasks.
 */
export interface AggregatedResult {
  /** Aggregated output */
  output: string;
  /** Source task results */
  sources: TaskResult[];
  /** Aggregation metadata */
  metadata: {
    strategy: AggregationStrategy;
    totalTasks: number;
    successfulTasks: number;
    failedTasks: number;
    aggregationTime: number;
  };
  /** Success status */
  success: boolean;
  /** Errors from failed tasks */
  errors?: string[];
}

/**
 * Progress information for aggregation.
 */
export interface AggregationProgress {
  /** Number of results collected */
  collected: number;
  /** Total expected results */
  total: number;
  /** Current partial result (if available) */
  partialResult?: string;
  /** Is aggregation complete */
  isComplete: boolean;
}

/**
 * Callback for aggregation progress.
 */
export type AggregationProgressCallback = (progress: AggregationProgress) => void;

// ============================================================================
// Result Aggregator Implementation
// ============================================================================

/**
 * Aggregates results from multiple worker tasks.
 *
 * @example
 * ```typescript
 * const aggregator = new ResultAggregator();
 *
 * // Aggregate results with concatenation
 * const result = aggregator.aggregate(results, {
 *   strategy: 'concat',
 *   separator: '\n\n---\n\n',
 * });
 *
 * console.log(result.output);
 * ```
 */
export class ResultAggregator {
  private results: Map<string, TaskResult> = new Map();
  private expectedTotal: number = 0;
  private progressCallbacks: Set<AggregationProgressCallback> = new Set();

  /**
   * Set expected number of results.
   *
   * @param total - Expected total results
   */
  setExpectedTotal(total: number): void {
    this.expectedTotal = total;
    this.notifyProgress();
  }

  /**
   * Add a result to the aggregator.
   *
   * @param result - Task result to add
   */
  addResult(result: TaskResult): void {
    this.results.set(result.taskId, result);
    this.notifyProgress();
    logger.debug({ taskId: result.taskId, status: result.status }, 'Result added');
  }

  /**
   * Add multiple results.
   *
   * @param results - Task results to add
   */
  addResults(results: TaskResult[]): void {
    for (const result of results) {
      this.results.set(result.taskId, result);
    }
    this.notifyProgress();
    logger.debug({ count: results.length }, 'Results added');
  }

  /**
   * Get current aggregation progress.
   *
   * @returns Progress information
   */
  getProgress(): AggregationProgress {
    return {
      collected: this.results.size,
      total: this.expectedTotal,
      isComplete: this.results.size >= this.expectedTotal,
    };
  }

  /**
   * Subscribe to progress updates.
   *
   * @param callback - Progress callback
   * @returns Unsubscribe function
   */
  onProgress(callback: AggregationProgressCallback): () => void {
    this.progressCallbacks.add(callback);
    return () => this.progressCallbacks.delete(callback);
  }

  /**
   * Aggregate all collected results.
   *
   * @param options - Aggregation options
   * @returns Aggregated result
   */
  aggregate(options: AggregationOptions = {}): AggregatedResult {
    const startTime = Date.now();
    const strategy = options.strategy ?? 'concat';

    // Get all results
    let results = Array.from(this.results.values());

    // Sort by task ID if requested
    if (options.sortByTaskId) {
      results = results.sort((a, b) => a.taskId.localeCompare(b.taskId));
    }

    // Filter failed tasks if not including them
    const successfulResults = results.filter(r => r.status === 'completed');
    const failedResults = results.filter(r => r.status !== 'completed');

    // Aggregate based on strategy
    let output: string;
    switch (strategy) {
      case 'concat':
        output = this.concatenateResults(successfulResults, options);
        break;
      case 'summarize':
        // Summarize includes all results (success and failed)
        output = this.summarizeResults(results);
        break;
      case 'merge':
        output = this.mergeResults(successfulResults);
        break;
      case 'best':
        output = this.selectBestResult(successfulResults, options);
        break;
      default:
        output = this.concatenateResults(successfulResults, options);
    }

    const aggregationTime = Date.now() - startTime;

    logger.info({
      strategy,
      total: results.length,
      successful: successfulResults.length,
      failed: failedResults.length,
      time: aggregationTime,
    }, 'Results aggregated');

    return {
      output,
      sources: results,
      metadata: {
        strategy,
        totalTasks: results.length,
        successfulTasks: successfulResults.length,
        failedTasks: failedResults.length,
        aggregationTime,
      },
      success: failedResults.length === 0,
      errors: failedResults.length > 0
        ? failedResults.map(r => r.error ?? `Task ${r.taskId} failed with status ${r.status}`)
        : undefined,
    };
  }

  /**
   * Aggregate results directly (without collecting first).
   *
   * @param results - Results to aggregate
   * @param options - Aggregation options
   * @returns Aggregated result
   */
  aggregateDirect(
    results: TaskResult[],
    options: AggregationOptions = {}
  ): AggregatedResult {
    this.results.clear();
    this.addResults(results);
    this.expectedTotal = results.length;
    return this.aggregate(options);
  }

  /**
   * Clear all collected results.
   */
  clear(): void {
    this.results.clear();
    this.expectedTotal = 0;
    logger.debug('Aggregator cleared');
  }

  // --------------------------------------------------------------------------
  // Aggregation Strategies
  // --------------------------------------------------------------------------

  /**
   * Concatenate all results.
   */
  private concatenateResults(
    results: TaskResult[],
    options: AggregationOptions
  ): string {
    const separator = options.separator ?? '\n\n';
    const maxLength = options.maxLength ?? 50000;

    const outputs = results
      .filter(r => r.output)
      .map(r => `## ${r.taskId}\n\n${r.output}`);

    let combined = outputs.join(separator);

    // Truncate if needed
    if (combined.length > maxLength) {
      combined = `${combined.slice(0, maxLength)  }\n\n... (truncated)`;
    }

    return combined;
  }

  /**
   * Summarize results.
   */
  private summarizeResults(results: TaskResult[]): string {
    const summaries: string[] = [];

    // Group by status
    const byStatus = new Map<TaskStatus, TaskResult[]>();
    for (const result of results) {
      const {status} = result;
      let statusResults = byStatus.get(status);
      if (!statusResults) {
        statusResults = [];
        byStatus.set(status, statusResults);
      }
      statusResults.push(result);
    }

    // Build summary
    summaries.push('# Aggregated Results Summary\n');
    summaries.push(`Total tasks: ${results.length}\n`);

    for (const [status, statusResults] of byStatus) {
      summaries.push(`\n## ${status.toUpperCase()} (${statusResults.length})\n`);

      for (const result of statusResults) {
        const duration = result.duration
          ? ` (${(result.duration / 1000).toFixed(2)}s)`
          : '';
        summaries.push(`- **${result.taskId}**${duration}`);

        if (result.output) {
          // Add first 200 chars of output
          const preview = result.output.slice(0, 200);
          const ellipsis = result.output.length > 200 ? '...' : '';
          summaries.push(`  > ${preview}${ellipsis}`);
        }
      }
    }

    return summaries.join('\n');
  }

  /**
   * Merge results (for structured data).
   */
  private mergeResults(results: TaskResult[]): string {
    const merged: Record<string, unknown> = {};

    for (const result of results) {
      if (!result.output) {continue;}

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(result.output);
        if (typeof parsed === 'object' && parsed !== null) {
          Object.assign(merged, parsed);
        } else {
          // Not an object, store under task ID
          merged[result.taskId] = parsed;
        }
      } catch {
        // Not valid JSON, store as string
        merged[result.taskId] = result.output;
      }
    }

    return JSON.stringify(merged, null, 2);
  }

  /**
   * Select the best result.
   */
  private selectBestResult(
    results: TaskResult[],
    options: AggregationOptions
  ): string {
    if (results.length === 0) {
      return 'No successful results to select from';
    }

    let best: TaskResult;

    if (options.bestSelector) {
      best = options.bestSelector(results);
    } else {
      // Default: select the result with the longest output
      best = results.reduce((a, b) =>
        (a.output?.length ?? 0) > (b.output?.length ?? 0) ? a : b
      );
    }

    return `## Selected Result from ${best.taskId}\n\n${best.output ?? 'No output'}`;
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  /**
   * Notify progress callbacks.
   */
  private notifyProgress(): void {
    const progress = this.getProgress();
    for (const callback of this.progressCallbacks) {
      try {
        callback(progress);
      } catch (error) {
        logger.error({ err: error }, 'Error in progress callback');
      }
    }
  }
}
