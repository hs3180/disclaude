/**
 * Agent Framework Racing Module
 *
 * Provides a benchmarking system for comparing different Agent SDK Providers
 * against each other on the same tasks.
 *
 * ## Features
 *
 * - **Parallel Execution**: Run multiple providers simultaneously
 * - **Metrics Collection**: Timing, cost, token usage, quality evaluation
 * - **Flexible Ranking**: Configurable scoring weights for speed, cost, quality, tokens
 * - **Report Generation**: Markdown and plain text reports
 * - **Concurrency Control**: Limit parallel execution to avoid resource exhaustion
 * - **Quality Evaluation**: Automatic quality checking against expected outputs
 *
 * ## Usage
 *
 * ```typescript
 * import { RaceExecutor, RaceReportGenerator } from '@disclaude/core';
 *
 * const executor = new RaceExecutor();
 *
 * const result = await executor.run({
 *   id: 'race-1',
 *   name: 'Provider Comparison',
 *   participants: [
 *     { id: 'claude', name: 'Claude Sonnet', providerType: 'claude', model: 'claude-sonnet-4-20250514' },
 *     { id: 'openai', name: 'GPT-4o', providerType: 'openai', model: 'gpt-4o' },
 *   ],
 *   tasks: [
 *     {
 *       id: 'task-1',
 *       description: 'Binary Search Implementation',
 *       category: 'coding',
 *       input: 'Write a binary search function in TypeScript',
 *       mode: 'queryOnce',
 *       expectedOutput: 'binary',
 *     },
 *   ],
 * });
 *
 * console.log(RaceReportGenerator.generate(result, { format: 'markdown' }));
 * ```
 *
 * @module racing
 */

// Types
export type {
  // Configuration
  RaceConfig,
  RaceParticipantConfig,
  RaceTask,
  RaceMode,
  TaskCategory,
  // Callbacks
  RaceCallbacks,
  // Results
  RaceResult,
  RaceTaskResult,
  RaceParticipantResult,
  RaceParticipantMetrics,
  RaceRanking,
  QualityEvaluation,
  // Ranking
  RankingCriterion,
  RankingWeights,
  // State
  RaceState,
  RaceProgress,
} from './types.js';

// Core
export { RaceExecutor } from './race-executor.js';

// Report
export { RaceReportGenerator } from './race-report.js';
export type { ReportConfig } from './race-report.js';
