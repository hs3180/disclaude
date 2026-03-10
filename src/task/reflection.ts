/**
 * Reflection Pattern - Unified interface for iterative task execution.
 *
 * This module implements the Reflection design pattern as described in Issue #271:
 *
 * ┌─────────────────────────────────────────────┐
 * │              Reflection Pattern              │
 * ├─────────────────────────────────────────────┤
 * │  ┌─────────┐    ┌─────────┐    ┌─────────┐  │
 * │  │ Execute │ →  │ Evaluate│ →  │ Reflect │  │
 * │  └─────────┘    └─────────┘    └─────────┘  │
 * │       ↑                               │      │
 * │       └───────────────────────────────┘      │
 * │              (迭代直到满足条件)               │
 * └─────────────────────────────────────────────┘
 *
 * Key Features:
 * - Configurable termination conditions
 * - Built-in observability (metrics, events)
 * - Composable and testable design
 * - Clear phase separation
 *
 * @module task/reflection
 * @deprecated Use schedule-driven task scanner instead. See examples/schedules/task-scanner.example.md
 * This module will be removed in a future version.
 * Issue: #1309
 */

import { createLogger } from '../utils/logger.js';
import type { AgentMessage } from '../types/agent.js';

const logger = createLogger('Reflection');

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Status of a reflection phase.
 */
export type ReflectionPhaseStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Result of a single reflection phase.
 */
export interface ReflectionPhaseResult {
  /** Phase name */
  phase: 'execute' | 'evaluate' | 'reflect';
  /** Phase status */
  status: ReflectionPhaseStatus;
  /** Duration in milliseconds */
  durationMs: number;
  /** Optional error if failed */
  error?: Error;
  /** Phase-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of evaluating task completion.
 */
export interface ReflectionEvaluationResult {
  /** Whether the task is complete */
  isComplete: boolean;
  /** Confidence level (0-1) */
  confidence: number;
  /** Reasoning for the evaluation */
  reasoning: string;
  /** Suggested next actions if not complete */
  nextActions?: string[];
}

/**
 * Metrics collected during reflection.
 */
export interface ReflectionMetrics {
  /** Total number of iterations */
  totalIterations: number;
  /** Number of successful iterations */
  successfulIterations: number;
  /** Number of failed iterations */
  failedIterations: number;
  /** Total execution time in milliseconds */
  totalDurationMs: number;
  /** Average iteration duration in milliseconds */
  avgIterationDurationMs: number;
  /** Phase-specific metrics */
  phases: {
    execute: ReflectionPhaseMetrics;
    evaluate: ReflectionPhaseMetrics;
    reflect: ReflectionPhaseMetrics;
  };
}

/**
 * Metrics for a specific phase.
 */
export interface ReflectionPhaseMetrics {
  /** Number of executions */
  count: number;
  /** Total duration in milliseconds */
  totalDurationMs: number;
  /** Average duration in milliseconds */
  avgDurationMs: number;
  /** Number of failures */
  failureCount: number;
}

/**
 * Event emitted during reflection cycle.
 */
export interface ReflectionEvent {
  /** Event type */
  type: 'iteration_start' | 'iteration_end' | 'phase_start' | 'phase_end' | 'complete' | 'error';
  /** Task ID */
  taskId: string;
  /** Current iteration number */
  iteration: number;
  /** Timestamp */
  timestamp: Date;
  /** Event-specific data */
  data?: Record<string, unknown>;
}

/**
 * Configuration for reflection behavior.
 */
export interface ReflectionConfig {
  /** Maximum number of iterations (default: 10) */
  maxIterations: number;
  /** Minimum confidence threshold to consider task complete (default: 0.8) */
  confidenceThreshold: number;
  /** Whether to enable metrics collection (default: true) */
  enableMetrics: boolean;
  /** Event handler for observability */
  onEvent?: (event: ReflectionEvent) => void;
}

/**
 * Default reflection configuration.
 */
export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  maxIterations: 10,
  confidenceThreshold: 0.8,
  enableMetrics: true,
};

// ============================================================================
// Reflection Context
// ============================================================================

/**
 * Context passed through the reflection cycle.
 */
export interface ReflectionContext {
  /** Task ID */
  taskId: string;
  /** Current iteration number */
  iteration: number;
  /** Configuration */
  config: ReflectionConfig;
  /** Accumulated metrics */
  metrics: ReflectionMetrics;
  /** Previous evaluation result (if any) */
  previousEvaluation?: ReflectionEvaluationResult;
  /** User-provided context */
  userContext?: Record<string, unknown>;
}

// ============================================================================
// Phase Executors
// ============================================================================

/**
 * Executor for the Execute phase.
 */
export type ExecutePhaseExecutor = (
  context: ReflectionContext
) => AsyncGenerator<AgentMessage>;

/**
 * Executor for the Evaluate phase.
 */
export type EvaluatePhaseExecutor = (
  context: ReflectionContext
) => AsyncGenerator<AgentMessage>;

/**
 * Executor for the Reflect phase (optional).
 */
export type ReflectPhaseExecutor = (
  context: ReflectionContext,
  evaluationResult: ReflectionEvaluationResult
) => AsyncGenerator<AgentMessage>;

// ============================================================================
// Termination Conditions
// ============================================================================

/**
 * Function to check if reflection should terminate.
 */
export type TerminationCondition = (
  context: ReflectionContext,
  evaluationResult: ReflectionEvaluationResult
) => boolean | Promise<boolean>;

/**
 * Built-in termination conditions.
 */
export const TerminationConditions = {
  /**
   * Terminate when task is marked complete with sufficient confidence.
   */
  isComplete: (confidenceThreshold: number = 0.8): TerminationCondition => {
    return (_context, result) => {
      return result.isComplete && result.confidence >= confidenceThreshold;
    };
  },

  /**
   * Terminate after maximum iterations.
   */
  maxIterations: (max: number): TerminationCondition => {
    return (context) => {
      return context.iteration >= max;
    };
  },

  /**
   * Terminate when evaluation indicates completion.
   */
  evaluationComplete: (): TerminationCondition => {
    return (_context, result) => {
      return result.isComplete;
    };
  },

  /**
   * Combine multiple conditions with AND logic.
   */
  all: (...conditions: TerminationCondition[]): TerminationCondition => {
    return async (context, result) => {
      for (const condition of conditions) {
        if (!(await condition(context, result))) {
          return false;
        }
      }
      return true;
    };
  },

  /**
   * Combine multiple conditions with OR logic.
   */
  any: (...conditions: TerminationCondition[]): TerminationCondition => {
    return async (context, result) => {
      for (const condition of conditions) {
        if (await condition(context, result)) {
          return true;
        }
      }
      return false;
    };
  },
};

// ============================================================================
// Metrics Helpers
// ============================================================================

/**
 * Create empty metrics object.
 */
function createEmptyMetrics(): ReflectionMetrics {
  return {
    totalIterations: 0,
    successfulIterations: 0,
    failedIterations: 0,
    totalDurationMs: 0,
    avgIterationDurationMs: 0,
    phases: {
      execute: { count: 0, totalDurationMs: 0, avgDurationMs: 0, failureCount: 0 },
      evaluate: { count: 0, totalDurationMs: 0, avgDurationMs: 0, failureCount: 0 },
      reflect: { count: 0, totalDurationMs: 0, avgDurationMs: 0, failureCount: 0 },
    },
  };
}

/**
 * Update phase metrics after a phase completes.
 */
function updatePhaseMetrics(
  metrics: ReflectionMetrics,
  phase: 'execute' | 'evaluate' | 'reflect',
  durationMs: number,
  failed: boolean
): void {
  const phaseMetrics = metrics.phases[phase];
  phaseMetrics.count++;
  phaseMetrics.totalDurationMs += durationMs;
  phaseMetrics.avgDurationMs = phaseMetrics.totalDurationMs / phaseMetrics.count;
  if (failed) {
    phaseMetrics.failureCount++;
  }
}

// ============================================================================
// Reflection Controller
// ============================================================================

/**
 * Controller for managing reflection cycles.
 *
 * Provides a unified interface for running iterative Execute-Evaluate-Reflect
 * cycles with built-in observability and configurable termination conditions.
 */
export class ReflectionController {
  private readonly config: ReflectionConfig;
  private readonly terminationConditions: TerminationCondition[];
  private metrics: ReflectionMetrics = createEmptyMetrics();

  constructor(
    config: Partial<ReflectionConfig> = {},
    terminationConditions: TerminationCondition[] = []
  ) {
    this.config = { ...DEFAULT_REFLECTION_CONFIG, ...config };
    this.terminationConditions = terminationConditions.length > 0
      ? terminationConditions
      : [
          TerminationConditions.isComplete(this.config.confidenceThreshold),
          TerminationConditions.maxIterations(this.config.maxIterations),
        ];

    logger.debug({ config: this.config }, 'ReflectionController initialized');
  }

  /**
   * Emit an event for observability.
   */
  private emitEvent(
    type: ReflectionEvent['type'],
    taskId: string,
    iteration: number,
    data?: Record<string, unknown>
  ): void {
    if (this.config.onEvent) {
      const event: ReflectionEvent = {
        type,
        taskId,
        iteration,
        timestamp: new Date(),
        data,
      };
      this.config.onEvent(event);
    }
  }

  /**
   * Check if reflection should terminate.
   */
  private async shouldTerminate(
    context: ReflectionContext,
    evaluationResult: ReflectionEvaluationResult
  ): Promise<boolean> {
    for (const condition of this.terminationConditions) {
      if (await condition(context, evaluationResult)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Run a single iteration of the reflection cycle.
   */
  private async *runIteration(
    taskId: string,
    iteration: number,
    executePhase: ExecutePhaseExecutor,
    evaluatePhase: EvaluatePhaseExecutor,
    reflectPhase?: ReflectPhaseExecutor
  ): AsyncGenerator<AgentMessage, ReflectionEvaluationResult> {
    const context: ReflectionContext = {
      taskId,
      iteration,
      config: this.config,
      metrics: this.metrics,
    };

    this.emitEvent('iteration_start', taskId, iteration);
    const iterationStart = Date.now();

    // Phase 1: Execute
    this.emitEvent('phase_start', taskId, iteration, { phase: 'execute' });
    const executeStart = Date.now();
    let executeFailed = false;

    try {
      for await (const msg of executePhase(context)) {
        yield msg;
      }
    } catch (error) {
      executeFailed = true;
      logger.error({ err: error, taskId, iteration }, 'Execute phase failed');
      yield {
        content: `❌ Execute phase failed: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    }

    const executeDuration = Date.now() - executeStart;
    if (this.config.enableMetrics) {
      updatePhaseMetrics(this.metrics, 'execute', executeDuration, executeFailed);
    }
    this.emitEvent('phase_end', taskId, iteration, { phase: 'execute', durationMs: executeDuration });

    // Phase 2: Evaluate
    this.emitEvent('phase_start', taskId, iteration, { phase: 'evaluate' });
    const evaluateStart = Date.now();
    let evaluateFailed = false;
    let evaluationResult: ReflectionEvaluationResult = {
      isComplete: false,
      confidence: 0,
      reasoning: 'Evaluation not completed',
    };

    try {
      // Collect evaluation messages and determine result
      for await (const msg of evaluatePhase(context)) {
        yield msg;
        // Note: In real implementation, the Evaluator writes evaluation.md
        // and we would parse it to determine the result
      }

      // Default evaluation - task needs more work
      // In real implementation, this would be determined by parsing evaluation.md
      evaluationResult = {
        isComplete: false,
        confidence: 0.5,
        reasoning: 'Evaluation completed, task needs more work',
        nextActions: ['Continue execution'],
      };
    } catch (error) {
      evaluateFailed = true;
      logger.error({ err: error, taskId, iteration }, 'Evaluate phase failed');
      yield {
        content: `❌ Evaluate phase failed: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    }

    const evaluateDuration = Date.now() - evaluateStart;
    if (this.config.enableMetrics) {
      updatePhaseMetrics(this.metrics, 'evaluate', evaluateDuration, evaluateFailed);
    }
    this.emitEvent('phase_end', taskId, iteration, { phase: 'evaluate', durationMs: evaluateDuration });

    // Phase 3: Reflect (optional)
    if (reflectPhase && !evaluationResult.isComplete) {
      this.emitEvent('phase_start', taskId, iteration, { phase: 'reflect' });
      const reflectStart = Date.now();
      let reflectFailed = false;

      try {
        for await (const msg of reflectPhase(context, evaluationResult)) {
          yield msg;
        }
      } catch (error) {
        reflectFailed = true;
        logger.error({ err: error, taskId, iteration }, 'Reflect phase failed');
      }

      const reflectDuration = Date.now() - reflectStart;
      if (this.config.enableMetrics) {
        updatePhaseMetrics(this.metrics, 'reflect', reflectDuration, reflectFailed);
      }
      this.emitEvent('phase_end', taskId, iteration, { phase: 'reflect', durationMs: reflectDuration });
    }

    // Update iteration metrics
    const iterationDuration = Date.now() - iterationStart;
    this.metrics.totalIterations++;
    this.metrics.totalDurationMs += iterationDuration;
    this.metrics.avgIterationDurationMs = this.metrics.totalDurationMs / this.metrics.totalIterations;

    if (executeFailed || evaluateFailed) {
      this.metrics.failedIterations++;
    } else {
      this.metrics.successfulIterations++;
    }

    this.emitEvent('iteration_end', taskId, iteration, {
      durationMs: iterationDuration,
      evaluationResult,
    });

    return evaluationResult;
  }

  /**
   * Run the reflection cycle until termination condition is met.
   *
   * @param taskId - Task identifier
   * @param executePhase - Execute phase executor
   * @param evaluatePhase - Evaluate phase executor
   * @param reflectPhase - Optional reflect phase executor
   * @yields AgentMessage from all phases
   * @returns Final evaluation result
   */
  async *run(
    taskId: string,
    executePhase: ExecutePhaseExecutor,
    evaluatePhase: EvaluatePhaseExecutor,
    reflectPhase?: ReflectPhaseExecutor
  ): AsyncGenerator<AgentMessage, ReflectionEvaluationResult> {
    logger.info({ taskId, config: this.config }, 'Starting reflection cycle');

    let iteration = 1;
    let evaluationResult: ReflectionEvaluationResult = {
      isComplete: false,
      confidence: 0,
      reasoning: 'Not started',
    };

    while (iteration <= this.config.maxIterations) {
      const context: ReflectionContext = {
        taskId,
        iteration,
        config: this.config,
        metrics: this.metrics,
        previousEvaluation: evaluationResult,
      };

      // Run iteration
      const generator = this.runIteration(
        taskId,
        iteration,
        executePhase,
        evaluatePhase,
        reflectPhase
      );

      // Yield all messages and get final result
      let result = await generator.next();
      while (!result.done) {
        yield result.value;
        result = await generator.next();
      }
      evaluationResult = result.value;

      // Check termination
      if (await this.shouldTerminate(context, evaluationResult)) {
        logger.info(
          { taskId, iteration, evaluationResult },
          'Termination condition met'
        );
        break;
      }

      iteration++;
    }

    this.emitEvent('complete', taskId, iteration, { evaluationResult, metrics: this.metrics });
    logger.info({ taskId, totalIterations: iteration, metrics: this.metrics }, 'Reflection cycle completed');

    return evaluationResult;
  }

  /**
   * Get current metrics.
   */
  getMetrics(): ReflectionMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics.
   */
  resetMetrics(): void {
    this.metrics = createEmptyMetrics();
  }
}

// ============================================================================
// Exports
// ============================================================================

export default {
  ReflectionController,
  TerminationConditions,
  DEFAULT_REFLECTION_CONFIG,
};
