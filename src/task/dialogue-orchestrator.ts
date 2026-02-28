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
  private currentIterationTaskDone = false;
  private currentChatId?: string;
  private iterationCount: number = 0;

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
  }

  /**
   * Process a single dialogue iteration with REAL-TIME streaming Evaluator-Executor communication.
   *
   * File-driven Flow:
   *   1. Create IterationBridge with task context
   *   2. Run iteration with streaming: Agent messages are yielded immediately
   *   3. Check for final_result.md to determine task completion
   *
   * @param iteration - Current iteration number
   * @returns Async iterable of AgentMessage (real-time execution output)
   */
  private async *processIterationStreaming(
    iteration: number
  ): AsyncIterable<AgentMessage> {
    logger.debug({ iteration }, 'Processing iteration with file-driven Eval-Execute architecture');

    // Create IterationBridge with all necessary context
    const bridge = new IterationBridge({
      evaluatorConfig: this.evaluatorConfig,
      iteration,
      taskId: this.taskId,
      chatId: this.currentChatId,
    });

    // Run the iteration with streaming
    for await (const msg of bridge.runIterationStreaming()) {
      // Yield the message for immediate delivery to user
      yield msg;
    }

    // Check for task completion via final_result.md (created by Executor)
    const hasFinalResult = await this.fileManager.hasFinalResult(this.taskId);

    // Log completion status
    logger.info({
      iteration,
      hasFinalResult,
    }, 'Streaming iteration complete');

    // Update completion status for return value check
    this.currentIterationTaskDone = hasFinalResult;
  }

  /**
   * Run a dialogue loop with REAL-TIME streaming Evaluator-Executor communication.
   *
   * **File-Driven Flow**
   * - Evaluator writes evaluation.md
   * - Executor reads evaluation.md and writes execution.md + final_result.md
   * - Task completion detected when final_result.md is created
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
    this.currentIterationTaskDone = false;
    this.currentChatId = chatId;
    this.iterationCount = 0;

    let iteration = 0;

    logger.info(
      { taskId: this.taskId, chatId, taskPath, maxIterations: this.maxIterations },
      'Starting file-driven Eval-Execute dialogue flow'
    );

    // Main dialogue loop: Evaluator → Executor → Evaluator → Executor → ...
    while (iteration < this.maxIterations) {
      iteration++;
      this.iterationCount = iteration;

      logger.info(
        { taskId: this.taskId, chatId, iteration, maxIterations: this.maxIterations },
        'Starting iteration'
      );

      // Reset task done flag for this iteration
      this.currentIterationTaskDone = false;

      // Process iteration with REAL-TIME streaming
      try {
        for await (const msg of this.processIterationStreaming(iteration)) {
          // Yield the message immediately to the user
          yield msg;
        }
      } catch (error) {
        logger.error(
          { err: error, taskId: this.taskId, chatId, iteration },
          'Error during iteration processing'
        );
        throw error;
      }

      // Check if task was completed during this iteration
      if (this.currentIterationTaskDone) {
        logger.info(
          { taskId: this.taskId, chatId, iteration },
          'Task completed during this iteration'
        );
        break;
      }

      logger.info(
        { taskId: this.taskId, chatId, iteration },
        'Iteration completed, task not yet done'
      );
    }

    // Write final summary when task completes
    if (this.currentIterationTaskDone) {
      await this.writeFinalSummary();
    }

    // Log warning if max iterations reached without task completion
    if (iteration >= this.maxIterations && !this.currentIterationTaskDone) {
      logger.warn(
        {
          taskId: this.taskId,
          chatId,
          iteration,
          maxIterations: this.maxIterations,
        },
        'Task stopped after reaching maximum iterations without completion signal'
      );
    }

    logger.info(
      { taskId: this.taskId, chatId, totalIterations: iteration, completed: this.currentIterationTaskDone },
      'Dialogue flow finished'
    );
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
