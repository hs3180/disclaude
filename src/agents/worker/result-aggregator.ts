/**
 * ResultAggregator - Combines results from multiple task executions.
 *
 * Supports multiple aggregation strategies:
 * - concat: Concatenate all results into an array
 * - merge: Merge results into a single object
 * - first: Return the first successful result
 * - last: Return the last successful result
 * - custom: Use a custom aggregation function
 *
 * @module agents/worker/result-aggregator
 */

import { createLogger } from '../../utils/logger.js';
import type {
  ResultAggregator as IResultAggregator,
  ResultAggregatorConfig,
  AggregationStrategy,
  TaskResult,
} from './types.js';

const logger = createLogger('ResultAggregator');

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<Omit<ResultAggregatorConfig, 'strategy' | 'aggregateFn'>> = {
  filterFailed: false,
};

/**
 * Result Aggregator implementation.
 *
 * Combines results from multiple task executions based on
 * the configured aggregation strategy.
 */
export class ResultAggregator implements IResultAggregator {
  private readonly strategy: AggregationStrategy;
  private readonly aggregateFn?: <T>(results: TaskResult<T>[]) => T;
  private readonly filterFailed: boolean;

  constructor(config: ResultAggregatorConfig) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.strategy = cfg.strategy;
    this.aggregateFn = cfg.aggregateFn;
    this.filterFailed = cfg.filterFailed;

    logger.debug({ strategy: this.strategy, filterFailed: this.filterFailed }, 'ResultAggregator initialized');
  }

  /**
   * Aggregate multiple task results into a single result.
   *
   * @param results - Task results to aggregate
   * @returns Aggregated result containing an array of results
   */
  aggregate<T>(results: TaskResult<T>[]): TaskResult<T[]> {
    const toProcess = this.filterFailed ? this.getSuccessful(results) : results;

    if (toProcess.length === 0) {
      return {
        task: {
          id: 'aggregated',
          input: undefined,
        },
        success: false,
        error: 'No results to aggregate',
        duration: 0,
        workerId: 'aggregator',
      };
    }

    const startTime = Date.now();
    let aggregatedData: T[];

    try {
      switch (this.strategy) {
        case 'concat':
          aggregatedData = this.aggregateConcat(toProcess);
          break;

        case 'merge':
          aggregatedData = [this.aggregateMerge(toProcess) as T];
          break;

        case 'first':
          aggregatedData = [this.aggregateFirst(toProcess)!];
          break;

        case 'last':
          aggregatedData = [this.aggregateLast(toProcess)!];
          break;

        case 'custom':
          if (!this.aggregateFn) {
            throw new Error('Custom aggregation function not provided');
          }
          aggregatedData = [this.aggregateFn(toProcess)];
          break;

        default:
          aggregatedData = this.aggregateConcat(toProcess);
      }

      const duration = Date.now() - startTime;
      const summary = this.getSummary(toProcess);

      logger.debug(
        {
          strategy: this.strategy,
          totalResults: results.length,
          processedResults: toProcess.length,
          duration,
        },
        'Results aggregated'
      );

      return {
        task: {
          id: 'aggregated',
          input: results.map(r => r.task),
          metadata: { summary },
        },
        success: true,
        result: aggregatedData,
        duration,
        workerId: 'aggregator',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Aggregation failed');

      return {
        task: {
          id: 'aggregated',
          input: undefined,
        },
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
        workerId: 'aggregator',
      };
    }
  }

  /**
   * Concat strategy: Combine all results into an array.
   */
  private aggregateConcat<T>(results: TaskResult<T>[]): T[] {
    return results
      .filter(r => r.success && r.result !== undefined)
      .map(r => r.result!);
  }

  /**
   * Merge strategy: Merge all results into a single object.
   */
  private aggregateMerge<T>(results: TaskResult<T>[]): T {
    const merged: Record<string, unknown> = {};

    for (const result of results) {
      if (result.success && result.result && typeof result.result === 'object') {
        Object.assign(merged, result.result);
      }
    }

    return merged as T;
  }

  /**
   * First strategy: Return the first successful result.
   */
  private aggregateFirst<T>(results: TaskResult<T>[]): T | undefined {
    const first = results.find(r => r.success && r.result !== undefined);
    return first?.result;
  }

  /**
   * Last strategy: Return the last successful result.
   */
  private aggregateLast<T>(results: TaskResult<T>[]): T | undefined {
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].success && results[i].result !== undefined) {
        return results[i].result;
      }
    }
    return undefined;
  }

  /**
   * Get successful results only.
   */
  getSuccessful<T>(results: TaskResult<T>[]): TaskResult<T>[] {
    return results.filter(r => r.success);
  }

  /**
   * Get failed results only.
   */
  getFailed<T>(results: TaskResult<T>[]): TaskResult<T>[] {
    return results.filter(r => !r.success);
  }

  /**
   * Get summary statistics.
   */
  getSummary(results: TaskResult[]): {
    total: number;
    successful: number;
    failed: number;
    avgDuration: number;
  } {
    const total = results.length;
    const successful = results.filter(r => r.success).length;
    const failed = total - successful;

    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
    const avgDuration = total > 0 ? totalDuration / total : 0;

    return {
      total,
      successful,
      failed,
      avgDuration,
    };
  }
}
