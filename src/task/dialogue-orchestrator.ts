/**
 * DialogueOrchestrator - Manages streaming dialogue with simplified Eval-Execute architecture.
 *
 * ## Architecture: Eval-Execute (Simplified)
 *
 * - Phase 1: Evaluator evaluates task completion
 * - Phase 2: Executor executes tasks with Evaluator's feedback
 * - Direct architecture: No intermediate layers
 * - Loop continues until max iterations reached or final_result.md detected
 *
 * ## Key Changes from Previous Architecture
 *
 * **BEFORE (Plan-and-Execute)**:
 * - Evaluator → Planner → Executor (with multi-step breakdown)
 * - 3 agent instances per iteration
 * - Planner as intermediate layer
 * - Completion signaled via task_done tool
 *
 * **AFTER (Eval-Execute)**:
 * - Evaluator (evaluate) → Executor (execute directly)
 * - 2 agent instances per iteration (Evaluator + Executor)
 * - Direct feedback from Evaluator to Executor
 * - Completion detected via final_result.md file
 *
 * ## Simplified Flow
 *
 * - No Planner layer - tasks executed directly
 * - Executor processes the entire task in one pass
 * - Sequential execution with context passing
 * - Results evaluated for completion
 * - Task completion automatically detected when Executor creates final_result.md
 *
 * ## No Session State Across Iterations
 *
 * - Each iteration creates FRESH agent instances via IterationBridge
 * - Context is maintained via previousExecutorOutput storage between iterations
 * - No cross-iteration session IDs needed
 */
import type { AgentMessage } from '../types/agent.js';
import { DIALOGUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { EvaluatorConfig } from '../agents/evaluator.js';
import { IterationBridge } from './iteration-bridge.js';
import { DialogueMessageTracker } from './dialogue-message-tracker.js';
import { TaskFileManager } from './file-manager.js';

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
 * Refactored from AgentDialogueBridge to focus on orchestration only.
 * - Message tracking delegated to DialogueMessageTracker
 * - Uses IterationBridge for single iterations
 *
 * NEW Streaming Flow:
 * 1. Each iteration: Evaluator and Executor run via IterationBridge
 * 2. Evaluator evaluates completion → Executor executes task
 * 3. All tasks executed directly (no planning phase)
 * 4. When execution completes, check for final_result.md
 * 5. Loop continues until final_result.md detected or max iterations reached
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

  // Store previous Executor output for Evaluator evaluation in next iteration
  private previousExecutorOutput?: string;
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
   * Cleanup resources held by the dialogue orchestrator.
   *
   * **IMPORTANT**: Call this method when the dialogue is complete to prevent memory leaks.
   *
   * Reset all state variables to their initial values.
   */
  cleanup(): void {
    logger.debug({ taskId: this.taskId }, 'Cleaning up dialogue orchestrator');
    this.taskId = '';
    this.previousExecutorOutput = undefined;
    this.currentChatId = undefined;
    this.messageTracker.reset();
  }

  /**
   * Process a single dialogue iteration with REAL-TIME streaming Evaluator-Executor communication.
   *
   * **NEW: Uses runIterationStreaming() for immediate user feedback**
   * - Agent messages are yielded immediately
   * - Task progress is reported in real-time
   * - Execution output is collected for Evaluator evaluation
   *
   * New Flow (Streaming):
   *   1. Create IterationBridge with Evaluator and Executor configs
   *   2. Run iteration with streaming: Agent messages are yielded immediately
   *   3. When execution sends 'result' message, iteration ends
   *   4. Store execution output for next iteration
   *   5. Check for final_result.md to determine task completion
   *
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @returns Async iterable of AgentMessage (real-time execution output)
   */
  private async *processIterationStreaming(
    taskMdContent: string,
    iteration: number
  ): AsyncIterable<AgentMessage> {
    logger.debug({ iteration }, 'Processing iteration with simplified Eval-Execute architecture');

    // Create IterationBridge with all necessary context including chatId and taskId
    const bridge = new IterationBridge({
      evaluatorConfig: this.evaluatorConfig,
      taskMdContent,
      iteration,
      taskId: this.taskId,
      previousExecutorOutput: this.previousExecutorOutput,
      chatId: this.currentChatId,
    });

    // Run the iteration with streaming
    for await (const msg of bridge.runIterationStreaming()) {
      // Yield the message for immediate delivery to user
      yield msg;
    }

    // Get Executor output from this iteration for next iteration
    const workerOutput = bridge.getExecutorOutput();

    // Store Executor output for next iteration
    this.previousExecutorOutput = workerOutput;

    // Check for task completion via final_result.md (created by Executor)
    const hasFinalResult = await this.fileManager.hasFinalResult(this.taskId);

    // Log completion status
    logger.info({
      iteration,
      hasFinalResult,
      workerOutputLength: workerOutput.length,
    }, 'REAL-TIME streaming iteration complete');

    // Update completion status for return value check
    // (This is a bit awkward with async generators - we track via instance variable)
    this.currentIterationTaskDone = hasFinalResult;
  }

  /**
   * Run a dialogue loop with REAL-TIME streaming Evaluator-Executor communication.
   *
   * **NEW: Real-time Streaming Flow**
   * - Evaluator's and Executor's messages are yielded immediately
   * - Users receive progress updates as they happen
   * - Executor's output is collected for Evaluator evaluation
   * - Task completion detected when final_result.md is created
   *
   * Flow:
   * 1. Each iteration: Evaluator runs and yields messages immediately
   * 2. Executor executes based on Evaluator's feedback (output also yielded)
   * 3. After iteration, check if final_result.md was created
   * 4. Loop continues until final_result.md detected or max iterations reached
   *
   * @param taskPath - Path to Task.md file
   * @param originalRequest - Original user request text
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

    const taskMdContent = await fs.readFile(taskPath, 'utf-8');
    let iteration = 0;

    logger.info(
      { taskId: this.taskId, chatId, maxIterations: this.maxIterations },
      'Starting Eval-Execute dialogue flow with REAL-TIME streaming'
    );

    // Main dialogue loop: Evaluator → Executor → Evaluator → Executor → ...
    while (iteration < this.maxIterations) {
      iteration++;
      this.iterationCount = iteration;

      // Reset task done flag for this iteration
      this.currentIterationTaskDone = false;

      // Process iteration with REAL-TIME streaming
      for await (const msg of this.processIterationStreaming(taskMdContent, iteration)) {
        // Yield the message immediately to the user
        yield msg;
      }

      // Check if task was completed during this iteration
      if (this.currentIterationTaskDone) {
        break;
      }
    }

    // ✨ NEW: Write final summary when task completes
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
        '⚠️  Task stopped after reaching maximum iterations without completion signal'
      );
    }
  }

  /**
   * Write final summary markdown file.
   */
  private async writeFinalSummary(): Promise<void> {
    try {
      const summary = this.generateFinalSummary();
      await this.fileManager.writeFinalSummary(this.taskId, summary);
      logger.info({ taskId: this.taskId }, 'Final summary written via TaskFileManager');
    } catch (error) {
      logger.error({ err: error, taskId: this.taskId }, 'Failed to write final summary via TaskFileManager');
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
- Step results: \`tasks/${this.taskId}/iterations/iter-*/steps/step-*.md\`

## Lessons Learned

Task execution completed successfully with Evaluation-Execution architecture.

## Recommendations

Review the generated markdown files for detailed execution history.
`;
  }
}
