/**
 * DialogueOrchestrator - Manages streaming dialogue with simplified Eval-Execute architecture.
 *
 * ## Architecture: Eval-Execute (Simplified)
 *
 * - Phase 1: Evaluator evaluates task completion
 * - Phase 2: Worker executes tasks with Evaluator's feedback
 * - Direct architecture: No intermediate layers
 * - Loop continues until max iterations reached or task complete
 *
 * ## Key Changes from Previous Architecture
 *
 * **BEFORE (Plan-and-Execute)**:
 * - Evaluator → Planner → Executor (with multi-step breakdown)
 * - 3 agent instances per iteration
 * - Planner as intermediate layer
 *
 * **AFTER (Eval-Execute)**:
 * - Evaluator (evaluate) → Worker (execute directly)
 * - 2 agent instances per iteration (Evaluator + Worker)
 * - Direct feedback from Evaluator to Worker
 *
 * ## Simplified Flow
 *
 * - No Planner layer - tasks executed directly
 * - Worker processes the entire task in one pass
 * - Sequential execution with context passing
 * - Results evaluated for completion
 *
 * ## No Session State Across Iterations
 *
 * - Each iteration creates FRESH agent instances via IterationBridge
 * - Context is maintained via previousWorkerOutput storage between iterations
 * - No cross-iteration session IDs needed
 */
import type { AgentMessage } from '../types/agent.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { extractText } from '../utils/sdk.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { EvaluatorConfig } from '../agents/evaluator.js';
import type { LongTaskConfig } from '../long-task/types.js';
import { IterationBridge } from './iteration-bridge.js';
import { TaskPlanExtractor, type TaskPlanData } from '../long-task/task-plan-extractor.js';
import { DialogueMessageTracker } from './dialogue-message-tracker.js';
import { isTaskDoneTool } from './mcp-utils.js';
import { TaskFileManager } from './file-manager.js';

const logger = createLogger('DialogueOrchestrator', {});

/**
 * Dialogue orchestrator configuration.
 */
export interface DialogueOrchestratorConfig {
  /** Executor configuration for task execution */
  executorConfig: LongTaskConfig;
  /** Evaluator configuration */
  evaluatorConfig: EvaluatorConfig;
  /** Callback when task plan is generated (deprecated - no longer used) */
  onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
}

/**
 * DialogueOrchestrator - Manages streaming dialogue loop with Eval-Execute.
 *
 * Refactored from AgentDialogueBridge to focus on orchestration only.
 * - Message tracking delegated to DialogueMessageTracker
 * - Uses IterationBridge for single iterations
 *
 * NEW Streaming Flow:
 * 1. Each iteration: Evaluator and Worker run via IterationBridge
 * 2. Evaluator evaluates completion → Worker executes task
 * 3. All tasks executed directly (no planning phase)
 * 4. When execution completes, iteration ends
 * 5. Loop continues until max iterations reached
 *
 * **User Communication:**
 * - Agent output is streamed directly to users
 * - Progress updates provided in real-time
 * - Evaluator controls task completion signaling
 */
export class DialogueOrchestrator {
  readonly executorConfig: LongTaskConfig;
  readonly evaluatorConfig: EvaluatorConfig;
  /** Maximum iterations from constants - single source of truth */
  readonly maxIterations = Config.MAX_ITERATIONS;
  private readonly onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
  private readonly taskPlanExtractor: TaskPlanExtractor;
  private readonly messageTracker: DialogueMessageTracker;
  private fileManager: TaskFileManager;

  private taskId: string = '';
  private originalRequest: string = '';
  private taskPlanSaved = false;
  private currentIterationTaskDone = false;
  private currentChatId?: string;

  // Store previous Worker output for Evaluator evaluation in next iteration
  private previousWorkerOutput?: string;
  private iterationCount: number = 0;

  constructor(config: DialogueOrchestratorConfig) {
    this.executorConfig = config.executorConfig;
    this.evaluatorConfig = config.evaluatorConfig;
    this.onTaskPlanGenerated = config.onTaskPlanGenerated;

    // Initialize extracted services
    this.taskPlanExtractor = new TaskPlanExtractor();
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
    this.originalRequest = '';
    this.taskPlanSaved = false;
    this.previousWorkerOutput = undefined;
    this.currentChatId = undefined;
    this.messageTracker.reset();
  }

  /**
   * Save task plan on first iteration.
   *
   * Extracts and saves task plan from Manager's first output.
   *
   * @param managerOutput - Manager's output text
   * @param iteration - Current iteration number
   */
  private async saveTaskPlanIfNeeded(managerOutput: string, iteration: number): Promise<void> {
    if (iteration === 1 && this.onTaskPlanGenerated && !this.taskPlanSaved) {
      const plan = this.taskPlanExtractor.extract(managerOutput, this.originalRequest);
      if (plan) {
        try {
          await this.onTaskPlanGenerated(plan);
          this.taskPlanSaved = true;
          logger.info({ taskId: plan.taskId }, 'Task plan saved');
        } catch (error) {
          logger.error({ err: error }, 'Failed to save task plan');
        }
      }
    }
  }

  /**
   * Process a single dialogue iteration with REAL-TIME streaming Evaluator-Worker communication.
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
      executorConfig: this.executorConfig,
      evaluatorConfig: this.evaluatorConfig,
      taskMdContent,
      iteration,
      taskId: this.taskId,  // Pass taskId for file management
      previousWorkerOutput: this.previousWorkerOutput,
      chatId: this.currentChatId,
    });

    let taskDone = false;

    // Run the iteration with streaming
    for await (const msg of bridge.runIterationStreaming()) {
      // Check for task_done using mcp-utils
      if (isTaskDoneTool(msg)) {
        taskDone = true;
      }

      // Also check for task_completion message type (from Evaluator)
      if (msg.messageType === 'task_completion') {
        logger.debug({
          iteration,
          messageType: msg.messageType,
        }, 'Task completion signal detected from Evaluator');
        taskDone = true;
      }

      // Yield the message for immediate delivery to user
      yield msg;
    }

    // Get Worker output from this iteration for next iteration
    const workerOutput = bridge.getWorkerOutput();

    // Store Worker output for next iteration
    this.previousWorkerOutput = workerOutput;

    // Log completion status
    logger.info({
      iteration,
      taskDone,
      workerOutputLength: workerOutput.length,
    }, 'REAL-TIME streaming iteration complete');

    // Update completion status for return value check
    // (This is a bit awkward with async generators - we track via instance variable)
    this.currentIterationTaskDone = taskDone;
  }

  /**
   * Run a dialogue loop with REAL-TIME streaming Evaluator-Worker communication.
   *
   * **NEW: Real-time Streaming Flow**
   * - Evaluator's and Worker's messages are yielded immediately
   * - Users receive progress updates as they happen
   * - Worker's output is collected for Evaluator evaluation
   *
   * Flow:
   * 1. Each iteration: Evaluator runs and yields messages immediately
   * 2. Worker executes based on Evaluator's feedback (output also yielded)
   * 3. Evaluator evaluates Worker output
   * 4. Loop continues until task_done or max iterations
   *
   * @param taskPath - Path to Task.md file
   * @param originalRequest - Original user request text
   * @param chatId - Feishu chat ID (passed to IterationBridge for context)
   * @param _messageId - Unique message ID (reserved for future use)
   * @returns Async iterable of messages (real-time execution output)
   */
  async *runDialogue(
    taskPath: string,
    originalRequest: string,
    chatId: string,
    _messageId: string
  ): AsyncIterable<AgentMessage> {
    // Extract taskId from the parent directory name (e.g., /path/to/tasks/cli-123/task.md -> cli-123)
    const taskDir = path.dirname(taskPath);
    this.taskId = path.basename(taskDir);
    this.originalRequest = originalRequest;
    this.taskPlanSaved = false;
    this.currentIterationTaskDone = false;
    this.currentChatId = chatId;
    this.iterationCount = 0;

    const taskMdContent = await fs.readFile(taskPath, 'utf-8');
    let iteration = 0;

    logger.info(
      { taskId: this.taskId, chatId, maxIterations: this.maxIterations },
      'Starting Eval-Execute dialogue flow with REAL-TIME streaming'
    );

    // Main dialogue loop: Evaluator → Worker → Evaluator → Worker → ...
    while (iteration < this.maxIterations) {
      iteration++;
      this.iterationCount = iteration;

      // Reset task done flag for this iteration
      this.currentIterationTaskDone = false;

      // Process iteration with REAL-TIME streaming
      // All messages are yielded immediately
      for await (const msg of this.processIterationStreaming(taskMdContent, iteration)) {
        // Save task plan on first iteration (from Worker's output)
        const text = typeof msg.content === 'string' ? msg.content : extractText(msg);
        if (iteration === 1 && text) {
          await this.saveTaskPlanIfNeeded(text, iteration);
        }

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
- Execution plans: \`tasks/${this.taskId}/iterations/iter-*/plan.md\`
- Step results: \`tasks/${this.taskId}/iterations/iter-*/steps/step-*.md\`

## Lessons Learned

Task execution completed successfully with Plan-and-Execute architecture.

## Recommendations

Review the generated markdown files for detailed execution history.
`;
  }
}

// Re-export TaskPlanData for backward compatibility
export type { TaskPlanData } from '../long-task/task-plan-extractor.js';
