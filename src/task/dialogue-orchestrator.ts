/**
 * DialogueOrchestrator - Manages streaming dialogue with file-driven Eval-Execute architecture.
 *
 * ## Architecture: File-Driven Eval-Execute
 *
 * - Phase 1: Evaluator writes evaluation.md to iteration directory
 * - Phase 2: Executor reads evaluation.md, writes execution.md + final_result.md
 * - Direct architecture: No intermediate layers, no JSON parsing
 * - Loop continues until max iterations reached or final_result.md detected
 *
 * ## Integration with ReflectionController (Issue #283)
 *
 * This module uses ReflectionController for:
 * - Iteration management with configurable termination conditions
 * - Unified metrics collection
 * - Event-based observability
 *
 * ## File-Driven Architecture
 *
 * - Evaluator writes: iterations/iter-N/evaluation.md
 * - Executor writes: iterations/iter-N/execution.md
 * - Completion marker: final_result.md (at task root)
 * - No JSON parsing needed - all communication via markdown files
 *
 * ## Simplified Flow
 *
 * - No Planner layer - tasks executed directly
 * - No JSON parsing - file-based communication
 * - Executor processes the entire task in one pass
 * - Task completion automatically detected when final_result.md is created
 */

import type { AgentMessage } from '../types/agent.js';
import { DIALOGUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import * as path from 'path';
import type { EvaluatorConfig } from '../agents/evaluator.js';
import { IterationBridge } from './iteration-bridge.js';
import { DialogueMessageTracker } from './dialogue-message-tracker.js';
import { TaskFileManager } from './task-files.js';
import {
  ReflectionController,
  TerminationConditions,
  type ReflectionContext,
  type ReflectionEvaluationResult,
  type ReflectionEvent,
  type ReflectionMetrics,
} from './reflection.js';

const logger = createLogger('DialogueOrchestrator', {});

/**
 * Dialogue orchestrator configuration.
 */
export interface DialogueOrchestratorConfig {
  /** Evaluator configuration */
  evaluatorConfig: EvaluatorConfig;
}

/**
 * DialogueOrchestrator - Manages streaming dialogue loop with Eval-Execute.
 *
 * Uses ReflectionController for unified iteration management (Issue #283).
 *
 * File-driven architecture:
 * - Message tracking delegated to DialogueMessageTracker
 * - Uses IterationBridge for single iterations
 * - All agent communication via markdown files
 *
 * Flow:
 * 1. Each iteration: Evaluator writes evaluation.md, Executor writes execution.md
 * 2. Check for final_result.md to determine task completion
 * 3. Loop continues until final_result.md detected or max iterations reached
 *
 * **User Communication:**
 * - Agent output is streamed directly to users
 * - Progress updates provided in real-time
 * - Task completion detected automatically when Executor creates final_result.md
 */
export class DialogueOrchestrator {
  readonly evaluatorConfig: EvaluatorConfig;
  /** Maximum iterations from constants - single source of truth */
  readonly maxIterations = DIALOGUE.MAX_ITERATIONS;
  private readonly messageTracker: DialogueMessageTracker;
  private fileManager: TaskFileManager;

  private taskId: string = '';
  private currentChatId?: string;
  private iterationCount: number = 0;
  private reflectionController?: ReflectionController;
  private taskComplete = false;

  constructor(config: DialogueOrchestratorConfig) {
    this.evaluatorConfig = config.evaluatorConfig;

    // Initialize extracted services
    this.messageTracker = new DialogueMessageTracker();
    this.fileManager = new TaskFileManager();
  }

  /**
   * Get the message tracker for this dialogue.
   *
   * @returns The message tracker instance
   */
  getMessageTracker(): DialogueMessageTracker {
    return this.messageTracker;
  }

  /**
   * Get the reflection metrics (if available).
   *
   * @returns Reflection metrics or undefined
   */
  getReflectionMetrics(): ReflectionMetrics | undefined {
    return this.reflectionController?.getMetrics();
  }

  /**
   * Dispose resources held by the dialogue orchestrator.
   *
   * **IMPORTANT**: Call this method when the dialogue is complete to prevent memory leaks.
   *
   * Reset all state variables to their initial values.
   */
  dispose(): void {
    logger.debug({ taskId: this.taskId }, 'Disposing dialogue orchestrator');
    this.taskId = '';
    this.currentChatId = undefined;
    this.messageTracker.reset();
    this.reflectionController?.resetMetrics();
  }

  /**
   * Create a termination condition that checks for final_result.md.
   */
  private createFinalResultCondition(taskId: string) {
    return async (_context: ReflectionContext, _result: ReflectionEvaluationResult): Promise<boolean> => {
      const hasFinalResult = await this.fileManager.hasFinalResult(taskId);
      return hasFinalResult;
    };
  }

  /**
   * Run a dialogue loop with REAL-TIME streaming Evaluator-Executor communication.
   *
   * **File-Driven Flow**
   * - Evaluator writes evaluation.md
   * - Executor reads evaluation.md and writes execution.md + final_result.md
   * - Task completion detected when final_result.md is created
   *
   * **Uses ReflectionController** (Issue #283) for:
   * - Iteration management
   * - Metrics collection
   * - Event-based observability
   *
   * @param taskPath - Path to Task.md file
   * @param _originalRequest - Original user request text (unused)
   * @param chatId - Feishu chat ID (passed to IterationBridge for context)
   * @param _messageId - Unique message ID (reserved for future use)
   * @returns Async iterable of messages (real-time execution output)
   */
  async *runDialogue(
    taskPath: string,
    _originalRequest: string,
    chatId: string,
    _messageId: string
  ): AsyncIterable<AgentMessage> {
    // Extract taskId from the parent directory name (e.g., /path/to/tasks/cli-123/task.md -> cli-123)
    const taskDir = path.dirname(taskPath);
    this.taskId = path.basename(taskDir);
    this.currentChatId = chatId;
    this.iterationCount = 0;
    this.taskComplete = false;

    logger.info(
      { taskId: this.taskId, chatId, taskPath, maxIterations: this.maxIterations },
      'Starting file-driven Eval-Execute dialogue flow with ReflectionController'
    );

    // Create ReflectionController with evaluateFirst mode for Eval-Exec pattern
    this.reflectionController = new ReflectionController(
      {
        maxIterations: this.maxIterations,
        confidenceThreshold: 0.8,
        enableMetrics: true,
        evaluateFirst: true, // Eval-Exec pattern: Evaluate → Execute
        onEvent: (event: ReflectionEvent) => {
          logger.debug({ event }, 'Reflection event');
        },
      },
      [
        TerminationConditions.maxIterations(this.maxIterations),
        this.createFinalResultCondition(this.taskId),
      ]
    );

    // Create phase executors that wrap IterationBridge
    const evaluatePhase = this.createEvaluatePhase();
    const executePhase = this.createExecutePhase();

    try {
      // Run reflection cycle
      const generator = this.reflectionController.run(
        this.taskId,
        executePhase,
        evaluatePhase
      );

      // Yield all messages
      let result = await generator.next();
      while (!result.done) {
        yield result.value;
        result = await generator.next();
      }

      // Check if task completed
      this.taskComplete = await this.fileManager.hasFinalResult(this.taskId);
      this.iterationCount = this.reflectionController.getMetrics().totalIterations;

    } catch (error) {
      logger.error(
        { err: error, taskId: this.taskId, chatId },
        'Error during reflection cycle'
      );
      throw error;
    }

    // Write final summary when task completes
    if (this.taskComplete) {
      await this.writeFinalSummary();
    }

    // Log warning if max iterations reached without task completion
    if (this.iterationCount >= this.maxIterations && !this.taskComplete) {
      logger.warn(
        {
          taskId: this.taskId,
          chatId,
          iteration: this.iterationCount,
          maxIterations: this.maxIterations,
        },
        'Task stopped after reaching maximum iterations without completion signal'
      );
    }

    logger.info(
      { taskId: this.taskId, chatId, totalIterations: this.iterationCount, completed: this.taskComplete },
      'Dialogue flow finished'
    );
  }

  /**
   * Create the Evaluate phase executor.
   *
   * Uses IterationBridge to run the Evaluator.
   */
  private createEvaluatePhase() {
    const self = this;
    return async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      const bridge = new IterationBridge({
        evaluatorConfig: self.evaluatorConfig,
        iteration: context.iteration,
        taskId: context.taskId,
        chatId: self.currentChatId,
      });

      // Run evaluator phase only (not the full iteration)
      yield* bridge.runEvaluatorOnly();
    };
  }

  /**
   * Create the Execute phase executor.
   *
   * Uses IterationBridge to run the Executor.
   */
  private createExecutePhase() {
    const self = this;
    return async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      const bridge = new IterationBridge({
        evaluatorConfig: self.evaluatorConfig,
        iteration: context.iteration,
        taskId: context.taskId,
        chatId: self.currentChatId,
      });

      // Run executor phase only
      yield* bridge.runExecutorOnly();
    };
  }

  /**
   * Write final summary markdown file.
   */
  private async writeFinalSummary(): Promise<void> {
    try {
      const summary = this.generateFinalSummary();
      await this.fileManager.writeFinalSummary(this.taskId, summary);
      logger.info({ taskId: this.taskId }, 'Final summary written');
    } catch (error) {
      logger.error({ err: error, taskId: this.taskId }, 'Failed to write final summary');
    }
  }

  /**
   * Generate final summary content.
   */
  private generateFinalSummary(): string {
    const timestamp = new Date().toISOString();
    const duration = this.iterationCount > 0 ? `${this.iterationCount} iterations` : 'Unknown';
    const metrics = this.reflectionController?.getMetrics();

    return `# Final Summary: ${this.taskId}

**Task ID**: ${this.taskId}
**Completed**: ${timestamp}
**Total Iterations**: ${this.iterationCount}
**Total Duration**: ${duration}

## Overview

Task completed successfully after ${this.iterationCount} iteration(s).

## Iteration History

${Array.from({ length: this.iterationCount }, (_, i) => `- Iteration ${i + 1}: Executed`).join('\n')}

## Reflection Metrics

- Total Iterations: ${metrics?.totalIterations ?? 'N/A'}
- Successful: ${metrics?.successfulIterations ?? 'N/A'}
- Failed: ${metrics?.failedIterations ?? 'N/A'}
- Avg Duration: ${metrics?.avgIterationDurationMs?.toFixed(0) ?? 'N/A'}ms

## Final Results

✅ Task completed - all objectives achieved

## Key Deliverables

- Task specification: \`tasks/${this.taskId}/task.md\`
- Evaluation results: \`tasks/${this.taskId}/iterations/iter-*/evaluation.md\`
- Execution results: \`tasks/${this.taskId}/iterations/iter-*/execution.md\`
- Final result: \`tasks/${this.taskId}/final_result.md\`

## Lessons Learned

Task execution completed successfully with file-driven Evaluation-Execution architecture.

## Recommendations

Review the generated markdown files for detailed execution history.
`;
  }
}
