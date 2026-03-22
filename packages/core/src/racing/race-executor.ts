/**
 * Agent Framework Racing - Race Executor
 *
 * Core execution engine for running Agent Framework races.
 * Orchestrates parallel/sequential execution of tasks across multiple providers
 * and collects metrics for comparison.
 *
 * @module racing/race-executor
 */

import type {
  RaceConfig,
  RaceResult,
  RaceTaskResult,
  RaceParticipantResult,
  RaceParticipantMetrics,
  RaceRanking,
  RaceProgress,
  RaceState,
  RaceTask,
  RaceParticipantConfig,
  RankingCriterion,
  RankingWeights,
  QualityEvaluation,
} from './types.js';
import type {
  IAgentSDKProvider,
  AgentMessage,
  AgentQueryOptions,
} from '../sdk/index.js';
import {
  getProvider,
} from '../sdk/index.js';
import { createLogger, type Logger } from '../utils/logger.js';

// ============================================================================
// Default Configuration
// ============================================================================

/** Default ranking weights */
const DEFAULT_WEIGHTS: RankingWeights = {
  speed: 0.3,
  cost: 0.25,
  quality: 0.35,
  tokens: 0.1,
};

/** Default timeout per participant execution (2 minutes) */
const DEFAULT_TIMEOUT = 120_000;

/** Default max concurrency for parallel execution */
const DEFAULT_MAX_CONCURRENCY = 3;

// ============================================================================
// Race Executor
// ============================================================================

/**
 * Executes Agent Framework races.
 *
 * The RaceExecutor orchestrates the execution of tasks across multiple
 * providers/models, collects performance metrics, and computes rankings.
 *
 * @example
 * ```typescript
 * const executor = new RaceExecutor();
 *
 * const result = await executor.run({
 *   id: 'race-1',
 *   name: 'Claude vs GPT Coding Benchmark',
 *   participants: [
 *     { id: 'claude', name: 'Claude Sonnet', providerType: 'claude', model: 'claude-sonnet-4-20250514' },
 *     { id: 'gpt', name: 'GPT-4o', providerType: 'openai', model: 'gpt-4o' },
 *   ],
 *   tasks: [
 *     { id: 'task-1', description: 'Write a binary search', category: 'coding', input: 'Write a binary search in TypeScript', mode: 'queryOnce' },
 *   ],
 * });
 *
 * console.log(result.overallStandings);
 * ```
 */
export class RaceExecutor {
  private readonly logger: Logger;
  private state: RaceState = 'pending';
  private progress: RaceProgress | null = null;
  private abortController: AbortController | null = null;

  constructor() {
    this.logger = createLogger('RaceExecutor');
  }

  /**
   * Execute a race with the given configuration.
   *
   * @param config - Race configuration
   * @param weights - Optional custom ranking weights
   * @returns Complete race result
   */
  async run(config: RaceConfig, weights?: Partial<RankingWeights>): Promise<RaceResult> {
    const startTime = Date.now();

    // Validate configuration
    this.validateConfig(config);

    // Set up state
    this.state = 'running';
    this.abortController = new AbortController();

    const mergedWeights: RankingWeights = { ...DEFAULT_WEIGHTS, ...weights };
    const totalExecutions = config.participants.length * config.tasks.length;

    this.progress = {
      state: 'running',
      config,
      completedTasks: 0,
      totalTasks: config.tasks.length,
      completedParticipants: 0,
      totalParticipants: totalExecutions,
    };

    const callbacks = config.callbacks ?? {};

    try {
      // Notify race start
      await callbacks.onRaceStart?.(config);

      // Execute all tasks
      const taskResults: RaceTaskResult[] = [];

      const taskExecution = async (task: RaceTask): Promise<RaceTaskResult> => {
        const participantResults = await this.executeTask(config, task);
        const taskResult: RaceTaskResult = {
          task,
          participantResults,
          rankings: this.computeRankings(participantResults, mergedWeights),
        };

        this.progress!.completedTasks++;
        await callbacks.onTaskComplete?.(taskResult);

        return taskResult;
      };

      if (config.parallel !== false) {
        // Execute tasks with concurrency control
        const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
        taskResults.push(...await this.runWithConcurrency(
          config.tasks.map(taskExecution),
          maxConcurrency
        ));
      } else {
        // Execute tasks sequentially
        for (const task of config.tasks) {
          if (this.abortController.signal.aborted) break;
          taskResults.push(await taskExecution(task));
        }
      }

      const completedAt = Date.now();

      // Compute overall standings
      const overallStandings = this.computeOverallStandings(taskResults);

      const result: RaceResult = {
        config,
        taskResults,
        overallStandings,
        startedAt: startTime,
        completedAt,
        totalDurationMs: completedAt - startTime,
      };

      this.state = 'completed';
      this.progress!.state = 'completed';

      await callbacks.onRaceComplete?.(result);

      return result;
    } catch (error) {
      this.state = 'failed';
      if (this.progress) {
        this.progress.state = 'failed';
        this.progress.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Cancel a running race.
   */
  cancel(): void {
    if (this.abortController && this.state === 'running') {
      this.abortController.abort();
      this.state = 'cancelled';
      if (this.progress) {
        this.progress.state = 'cancelled';
      }
    }
  }

  /**
   * Get the current race progress.
   */
  getProgress(): RaceProgress | null {
    return this.progress;
  }

  /**
   * Get the current race state.
   */
  getState(): RaceState {
    return this.state;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Execute a single task across all participants.
   */
  private async executeTask(
    config: RaceConfig,
    task: RaceTask,
  ): Promise<RaceParticipantResult[]> {
    const callbacks = config.callbacks ?? {};
    const timeout = task.timeout ?? DEFAULT_TIMEOUT;

    const participantExecution = async (participant: RaceParticipantConfig): Promise<RaceParticipantResult> => {
      await callbacks.onParticipantStart?.(participant, task);

      const result = await this.executeParticipant(participant, task, config.commonQueryOptions, timeout);

      this.progress!.completedParticipants++;

      // Evaluate quality if expected output is defined
      if (task.expectedOutput !== undefined) {
        result.quality = await this.evaluateQuality(result.outputText, task.expectedOutput);
      }

      await callbacks.onParticipantComplete?.(result);

      return result;
    };

    if (config.parallel !== false) {
      const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
      return this.runWithConcurrency(
        config.participants.map(participantExecution),
        maxConcurrency,
      );
    } else {
      const results: RaceParticipantResult[] = [];
      for (const participant of config.participants) {
        if (this.abortController?.signal.aborted) break;
        results.push(await participantExecution(participant));
      }
      return results;
    }
  }

  /**
   * Execute a single participant on a single task.
   */
  private async executeParticipant(
    participant: RaceParticipantConfig,
    task: RaceTask,
    commonOptions?: Partial<AgentQueryOptions>,
    timeout?: number,
  ): Promise<RaceParticipantResult> {
    const startedAt = Date.now();
    let provider: IAgentSDKProvider;
    const rawMessages: AgentMessage[] = [];
    let outputText = '';
    let hasError = false;
    let errorMessage: string | undefined;
    let timedOut = false;
    let timeToFirstTokenMs: number | undefined;
    let timeToLastTokenMs: number | undefined;

    const metrics: RaceParticipantMetrics = {
      totalElapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      toolCallCount: 0,
      messageCount: 0,
      timedOut: false,
      hasError: false,
    };

    try {
      // Get provider for this participant
      provider = getProvider(participant.providerType as never);
    } catch (error) {
      // Provider not available - record as error
      hasError = true;
      errorMessage = `Provider '${participant.providerType}' not available: ${error instanceof Error ? error.message : String(error)}`;
      metrics.hasError = true;
      metrics.errorMessage = errorMessage;

      return {
        participant,
        task,
        metrics,
        outputText: '',
        rawMessages: [],
        startedAt,
        completedAt: Date.now(),
      };
    }

    // Build query options
    const queryOptions: AgentQueryOptions = {
      ...(commonOptions ?? {}),
      settingSources: ['project'],
      model: participant.model,
      ...(participant.queryOptions ?? {}),
    };

    try {
      if (task.mode === 'queryOnce') {
        // Single-shot execution
        const iterator = provider.queryOnce(task.input, queryOptions);

        // Set up timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout);
        });

        await Promise.race([
          (async () => {
            for await (const message of iterator) {
              if (this.abortController?.signal.aborted) break;

              rawMessages.push(message);
              const now = Date.now();

              // Track time to first token
              if (timeToFirstTokenMs === undefined && message.type === 'text') {
                timeToFirstTokenMs = now - startedAt;
              }

              // Track time to last token
              if (message.type === 'text' || message.type === 'result') {
                timeToLastTokenMs = now - startedAt;
              }

              // Accumulate output text
              if (message.type === 'text') {
                outputText += message.content;
              }

              // Accumulate metadata
              if (message.metadata) {
                if (message.metadata.inputTokens) {
                  metrics.inputTokens = Math.max(metrics.inputTokens, message.metadata.inputTokens);
                }
                if (message.metadata.outputTokens) {
                  metrics.outputTokens = Math.max(metrics.outputTokens, message.metadata.outputTokens);
                }
                if (message.metadata.costUsd) {
                  metrics.costUsd = Math.max(metrics.costUsd, message.metadata.costUsd);
                }
                if (message.metadata.toolName) {
                  metrics.toolCallCount++;
                }
              }

              metrics.messageCount++;
            }
          })(),
          timeoutPromise,
        ]);
      } else {
        // Streaming execution
        const result = provider.queryStream(
          (async function* () {
            yield { role: 'user' as const, content: task.input };
          })(),
          queryOptions,
        );

        // Set up timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout);
        });

        await Promise.race([
          (async () => {
            for await (const message of result.iterator) {
              if (this.abortController?.signal.aborted) break;

              rawMessages.push(message);
              const now = Date.now();

              if (timeToFirstTokenMs === undefined && message.type === 'text') {
                timeToFirstTokenMs = now - startedAt;
              }
              if (message.type === 'text' || message.type === 'result') {
                timeToLastTokenMs = now - startedAt;
              }
              if (message.type === 'text') {
                outputText += message.content;
              }
              if (message.metadata) {
                if (message.metadata.inputTokens) {
                  metrics.inputTokens = Math.max(metrics.inputTokens, message.metadata.inputTokens);
                }
                if (message.metadata.outputTokens) {
                  metrics.outputTokens = Math.max(metrics.outputTokens, message.metadata.outputTokens);
                }
                if (message.metadata.costUsd) {
                  metrics.costUsd = Math.max(metrics.costUsd, message.metadata.costUsd);
                }
                if (message.metadata.toolName) {
                  metrics.toolCallCount++;
                }
              }

              metrics.messageCount++;
            }

            result.handle.close();
          })(),
          timeoutPromise,
        ]);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Timeout')) {
        timedOut = true;
        hasError = true;
        errorMessage = error.message;
      } else {
        hasError = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    const completedAt = Date.now();
    metrics.totalElapsedMs = completedAt - startedAt;
    metrics.timedOut = timedOut;
    metrics.hasError = hasError;
    metrics.errorMessage = errorMessage;
    metrics.timeToFirstTokenMs = timeToFirstTokenMs;
    metrics.timeToLastTokenMs = timeToLastTokenMs;

    this.logger.debug({
      participant: participant.id,
      task: task.id,
      elapsed: metrics.totalElapsedMs,
      tokens: metrics.inputTokens + metrics.outputTokens,
      cost: metrics.costUsd,
      hasError,
    }, 'Participant execution completed');

    return {
      participant,
      task,
      metrics,
      outputText,
      rawMessages,
      startedAt,
      completedAt,
    };
  }

  /**
   * Evaluate output quality against expected output.
   */
  private async evaluateQuality(
    output: string,
    expected: string | ((output: string) => boolean | Promise<boolean>),
  ): Promise<QualityEvaluation> {
    if (typeof expected === 'function') {
      try {
        const passed = await expected(output);
        return {
          passed: !!passed,
          score: passed ? 1 : 0,
          feedback: passed ? 'Output passed custom evaluation' : 'Output did not pass custom evaluation',
        };
      } catch (error) {
        return {
          passed: false,
          score: 0,
          feedback: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // String-based evaluation: check if expected substring is in output
    if (output.toLowerCase().includes(expected.toLowerCase())) {
      return {
        passed: true,
        score: 1,
        feedback: `Expected output found in response`,
      };
    }

    // Fuzzy match: compute word overlap ratio
    const outputWords = new Set(output.toLowerCase().split(/\s+/));
    const expectedWords = new Set(expected.toLowerCase().split(/\s+/));
    let matchCount = 0;
    for (const word of expectedWords) {
      if (outputWords.has(word)) matchCount++;
    }
    const overlapRatio = expectedWords.size > 0 ? matchCount / expectedWords.size : 0;

    return {
      passed: overlapRatio >= 0.5,
      score: overlapRatio,
      feedback: `Word overlap: ${(overlapRatio * 100).toFixed(1)}%`,
    };
  }

  // ==========================================================================
  // Ranking Computation
  // ==========================================================================

  /**
   * Compute rankings for a single task.
   */
  private computeRankings(
    results: RaceParticipantResult[],
    weights: RankingWeights,
  ): RaceRanking[] {
    if (results.length === 0) return [];

    // Normalize metrics for scoring
    const validResults = results.filter(r => !r.metrics.hasError);
    const errorResults = results.filter(r => r.metrics.hasError);

    if (validResults.length === 0) {
      // All participants had errors - rank by least bad
      return results.map((r, i) => ({
        participantId: r.participant.id,
        participantName: r.participant.name,
        rank: i + 1,
        score: 0,
        scoreBreakdown: { speed: 0, cost: 0, quality: 0, tokens: 0 },
        highlight: r.metrics.errorMessage,
      }));
    }

    // Find min/max for normalization
    const maxElapsed = Math.max(...validResults.map(r => r.metrics.totalElapsedMs));
    const maxCost = Math.max(...validResults.map(r => r.metrics.costUsd));
    const maxTokens = Math.max(...validResults.map(r => r.metrics.inputTokens + r.metrics.outputTokens));

    // Score each valid result
    const rankings: RaceRanking[] = validResults.map(r => {
      const scoreBreakdown: Record<RankingCriterion, number> = {
        speed: maxElapsed > 0 ? 1 - (r.metrics.totalElapsedMs / maxElapsed) : 1,
        cost: maxCost > 0 ? 1 - (r.metrics.costUsd / maxCost) : 1,
        quality: r.quality?.score ?? (r.metrics.hasError ? 0 : 0.5),
        tokens: maxTokens > 0 ? 1 - ((r.metrics.inputTokens + r.metrics.outputTokens) / maxTokens) : 1,
      };

      const score =
        scoreBreakdown.speed * weights.speed +
        scoreBreakdown.cost * weights.cost +
        scoreBreakdown.quality * weights.quality +
        scoreBreakdown.tokens * weights.tokens;

      return {
        participantId: r.participant.id,
        participantName: r.participant.name,
        rank: 0, // Will be assigned after sorting
        score,
        scoreBreakdown,
        highlight: this.generateHighlight(r, scoreBreakdown),
      };
    });

    // Add error results at the bottom
    for (const r of errorResults) {
      rankings.push({
        participantId: r.participant.id,
        participantName: r.participant.name,
        rank: 0,
        score: 0,
        scoreBreakdown: { speed: 0, cost: 0, quality: 0, tokens: 0 },
        highlight: `Failed: ${r.metrics.errorMessage}`,
      });
    }

    // Sort by score descending and assign ranks
    rankings.sort((a, b) => b.score - a.score);
    rankings.forEach((r, i) => {
      r.rank = i + 1;
    });

    return rankings;
  }

  /**
   * Compute overall standings across all tasks.
   */
  private computeOverallStandings(
    taskResults: RaceTaskResult[],
  ): RaceRanking[] {
    if (taskResults.length === 0) return [];

    // Collect all participant IDs
    const participantMap = new Map<string, {
      id: string;
      name: string;
      scores: number[];
      breakdowns: Record<RankingCriterion, number>[];
    }>();

    for (const taskResult of taskResults) {
      for (const ranking of taskResult.rankings) {
        if (!participantMap.has(ranking.participantId)) {
          participantMap.set(ranking.participantId, {
            id: ranking.participantId,
            name: ranking.participantName,
            scores: [],
            breakdowns: [],
          });
        }
        const entry = participantMap.get(ranking.participantId)!;
        entry.scores.push(ranking.score);
        entry.breakdowns.push(ranking.scoreBreakdown);
      }
    }

    // Compute average scores
    const standings: RaceRanking[] = [];
    for (const [, entry] of participantMap) {
      const avgScore = entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length;

      // Average breakdown
      const avgBreakdown: Record<RankingCriterion, number> = {
        speed: 0,
        cost: 0,
        quality: 0,
        tokens: 0,
      };
      for (const bd of entry.breakdowns) {
        for (const criterion of Object.keys(avgBreakdown) as RankingCriterion[]) {
          avgBreakdown[criterion] += bd[criterion];
        }
      }
      for (const criterion of Object.keys(avgBreakdown) as RankingCriterion[]) {
        avgBreakdown[criterion] /= entry.breakdowns.length;
      }

      standings.push({
        participantId: entry.id,
        participantName: entry.name,
        rank: 0,
        score: avgScore,
        scoreBreakdown: avgBreakdown,
        highlight: `Average score across ${entry.scores.length} tasks`,
      });
    }

    // Sort and assign ranks
    standings.sort((a, b) => b.score - a.score);
    standings.forEach((r, i) => {
      r.rank = i + 1;
    });

    return standings;
  }

  /**
   * Generate a highlight string for a ranking entry.
   */
  private generateHighlight(
    result: RaceParticipantResult,
    breakdown: Record<RankingCriterion, number>,
  ): string {
    const highlights: string[] = [];

    if (breakdown.speed >= 0.8) highlights.push('⚡ Fastest');
    if (breakdown.cost <= 0.2) highlights.push('💰 Most expensive');
    else if (breakdown.cost >= 0.8) highlights.push('💰 Most cost-effective');
    if (breakdown.quality >= 0.9) highlights.push('✅ Perfect quality');
    if (breakdown.quality <= 0.3 && result.quality) highlights.push('❌ Low quality');
    if (result.metrics.timeToFirstTokenMs && result.metrics.timeToFirstTokenMs < 1000) {
      highlights.push(`🚀 Quick TTFB: ${result.metrics.timeToFirstTokenMs}ms`);
    }

    return highlights.length > 0 ? highlights.join(' | ') : 'Standard performance';
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Run promises with concurrency control.
   */
  private async runWithConcurrency<T>(
    tasks: Promise<T>[],
    maxConcurrency: number,
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      if (this.abortController?.signal.aborted) break;

      const p = task.then(result => {
        results.push(result);
      }).finally(() => {
        const index = executing.indexOf(p);
        if (index > -1) executing.splice(index, 1);
      });

      executing.push(p);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
    return results;
  }

  /**
   * Validate race configuration.
   */
  private validateConfig(config: RaceConfig): void {
    if (!config.id) throw new Error('Race config must have an id');
    if (!config.name) throw new Error('Race config must have a name');
    if (config.participants.length < 2) {
      throw new Error('Race must have at least 2 participants');
    }
    if (config.participants.length !== new Set(config.participants.map(p => p.id)).size) {
      throw new Error('Participant IDs must be unique');
    }
    if (config.tasks.length === 0) {
      throw new Error('Race must have at least 1 task');
    }
    if (config.tasks.length !== new Set(config.tasks.map(t => t.id)).size) {
      throw new Error('Task IDs must be unique');
    }
  }
}
