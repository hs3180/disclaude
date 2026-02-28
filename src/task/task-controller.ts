/**
 * TaskController - Simplified iterative task execution controller.
 *
 * ## Architecture (Issue #283)
 *
 * This module replaces DialogueOrchestrator + IterationBridge with a single,
 * simplified controller that implements the Reflection pattern.
 *
 * ```
 * ┌─────────────────────────────────────────────────────────┐
 * │              TaskController (单协程控制)                 │
 * ├─────────────────────────────────────────────────────────┤
 * │                                                         │
 * │   while (!complete && iteration < MAX) {               │
 *       iteration++                                       │
 *                                                         │
 *       // Phase 1: Evaluate                              │
 *       evaluation.md ← Evaluator(task.md)               │
 *       if (final_result.md exists) break                │
 *                                                         │
 *       // Phase 2: Execute                               │
 *       execution.md ← Executor(evaluation.md)           │
 *   }                                                     │
 *                                                         │
 * └─────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Features
 * - Single point of state management
 * - Blocking coroutine (similar to Scheduler)
 * - File-based completion detection
 * - Simple yield* composition
 *
 * @module task/task-controller
 */

import * as path from 'path';
import type { AgentMessage } from '../types/agent.js';
import { DIALOGUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { Evaluator, type EvaluatorConfig } from '../agents/evaluator.js';
import { Executor } from '../agents/executor.js';
import { Reporter } from '../agents/reporter.js';
import { TaskFileManager } from './task-files.js';
import { Config } from '../config/index.js';

const logger = createLogger('TaskController');

/**
 * Configuration for TaskController.
 */
export interface TaskControllerConfig {
  /** Evaluator configuration */
  evaluatorConfig: EvaluatorConfig;
  /** Maximum iterations (default: from DIALOGUE.MAX_ITERATIONS) */
  maxIterations?: number;
}

/**
 * Context passed to each iteration.
 */
interface IterationContext {
  taskId: string;
  chatId?: string;
  iteration: number;
}

/**
 * TaskController - Simplified iterative task execution.
 *
 * Replaces DialogueOrchestrator + IterationBridge with a single controller
 * that implements the Evaluate → Execute → Repeat pattern.
 *
 * ## File-Driven Architecture
 * - Evaluator writes: iterations/iter-N/evaluation.md
 * - Executor writes: iterations/iter-N/execution.md
 * - Completion marker: final_result.md (at task root)
 *
 * ## Usage
 * ```typescript
 * const controller = new TaskController({ evaluatorConfig });
 * for await (const msg of controller.run(taskPath, chatId)) {
 *   // Handle message
 * }
 * ```
 */
export class TaskController {
  readonly evaluatorConfig: EvaluatorConfig;
  readonly maxIterations: number;

  private fileManager: TaskFileManager;
  private taskId: string = '';
  private iterationCount: number = 0;
  private running: boolean = false;

  constructor(config: TaskControllerConfig) {
    this.evaluatorConfig = config.evaluatorConfig;
    this.maxIterations = config.maxIterations ?? DIALOGUE.MAX_ITERATIONS;
    this.fileManager = new TaskFileManager();
  }

  /**
   * Run the task execution loop.
   *
   * Implements the Evaluate → Execute → Repeat pattern until:
   * - final_result.md is created (task complete)
   * - Max iterations reached
   *
   * @param taskPath - Path to Task.md file
   * @param chatId - Optional chat ID for context
   * @returns Async iterable of AgentMessage
   */
  async *run(taskPath: string, chatId?: string): AsyncIterable<AgentMessage> {
    // Extract taskId from the parent directory name
    const taskDir = path.dirname(taskPath);
    this.taskId = path.basename(taskDir);
    this.iterationCount = 0;
    this.running = true;

    logger.info(
      { taskId: this.taskId, chatId, taskPath, maxIterations: this.maxIterations },
      'Starting task execution loop'
    );

    try {
      while (this.running && this.iterationCount < this.maxIterations) {
        this.iterationCount++;

        const context: IterationContext = {
          taskId: this.taskId,
          chatId,
          iteration: this.iterationCount,
        };

        logger.info(
          { taskId: this.taskId, iteration: this.iterationCount },
          'Starting iteration'
        );

        // Phase 1: Evaluate
        yield* this.runEvaluatePhase(context);

        // Check for completion via final_result.md
        if (await this.hasFinalResult()) {
          logger.info(
            { taskId: this.taskId, iteration: this.iterationCount },
            'Task completed (final_result.md detected)'
          );

          yield {
            content: '✅ Task completed - final result detected',
            role: 'assistant',
            messageType: 'task_completion',
            metadata: { status: 'complete' },
          };
          break;
        }

        // Phase 2: Execute
        yield* this.runExecutePhase(context);
      }

      // Write final summary
      await this.writeFinalSummary();

      // Log warning if max iterations reached without completion
      if (this.iterationCount >= this.maxIterations && !(await this.hasFinalResult())) {
        logger.warn(
          { taskId: this.taskId, iteration: this.iterationCount },
          'Task stopped after reaching maximum iterations without completion'
        );
      }
    } finally {
      this.running = false;
      logger.info(
        { taskId: this.taskId, totalIterations: this.iterationCount },
        'Task execution loop finished'
      );
    }
  }

  /**
   * Stop the running task.
   */
  stop(): void {
    this.running = false;
    logger.info({ taskId: this.taskId }, 'Task stopped');
  }

  /**
   * Get current iteration count.
   */
  getIterationCount(): number {
    return this.iterationCount;
  }

  /**
   * Check if task is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Run the Evaluate phase.
   */
  private async *runEvaluatePhase(context: IterationContext): AsyncIterable<AgentMessage> {
    logger.debug({ ...context }, 'Starting Evaluate phase');

    const evaluator = new Evaluator(this.evaluatorConfig);

    try {
      for await (const msg of evaluator.evaluate(context.taskId, context.iteration)) {
        yield msg;
      }

      logger.info({ ...context }, 'Evaluate phase completed');
    } catch (error) {
      logger.error({ err: error, ...context }, 'Evaluate phase failed');
      yield {
        content: `❌ Evaluate phase failed: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    } finally {
      evaluator.dispose();
    }
  }

  /**
   * Run the Execute phase.
   */
  private async *runExecutePhase(context: IterationContext): AsyncIterable<AgentMessage> {
    logger.debug({ ...context }, 'Starting Execute phase');

    yield {
      content: '⚡ **Executing Task**',
      role: 'assistant',
      messageType: 'status',
    };

    const agentConfig = Config.getAgentConfig();

    // Create Reporter for processing Executor events
    const reporter = new Reporter({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    });

    const reporterContext = {
      taskId: context.taskId,
      iteration: context.iteration,
      chatId: context.chatId,
    };

    try {
      // Create Executor
      const executor = new Executor({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      });

      // Get Executor event stream
      const executorStream = executor.executeTask(
        context.taskId,
        context.iteration,
        Config.getWorkspaceDir()
      );

      // Process all Executor events through Reporter
      let eventCount = 0;
      for await (const event of executorStream) {
        eventCount++;
        yield* reporter.processEvent(event, reporterContext);
      }

      logger.info({ ...context, eventCount }, 'Execute phase completed');
    } catch (error) {
      logger.error({ err: error, ...context }, 'Execute phase failed');
      yield {
        content: `❌ **Task execution failed**: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    } finally {
      reporter.dispose();
    }
  }

  /**
   * Check if final_result.md exists.
   */
  private async hasFinalResult(): Promise<boolean> {
    return this.fileManager.hasFinalResult(this.taskId);
  }

  /**
   * Write final summary markdown file.
   */
  private async writeFinalSummary(): Promise<void> {
    if (!(await this.hasFinalResult())) {
      return;
    }

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

    return `# Final Summary: ${this.taskId}

**Task ID**: ${this.taskId}
**Completed**: ${timestamp}
**Total Iterations**: ${this.iterationCount}
**Total Duration**: ${duration}

## Overview

Task completed successfully after ${this.iterationCount} iteration(s).

## Iteration History

${Array.from({ length: this.iterationCount }, (_, i) => `- Iteration ${i + 1}: Executed`).join('\n')}

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
