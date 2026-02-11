/**
 * IterationBridge - Simplified Evaluator-Worker communication with REAL-TIME streaming.
 *
 * **Architecture (Simplified - Direct Evaluator → Worker):**
 * - Phase 1: Evaluator evaluates task completion and calls task_done if complete
 * - Phase 2: If not complete, Worker executes the task directly
 *
 * **Key Components:**
 * - **Evaluator** (Phase 1): Specialized in task completion evaluation
 * - **Worker** (Phase 2): Executes tasks directly with Executor
 *
 * **Simplified Architecture:**
 * - No Planner layer - Worker executes tasks directly
 * - Single execution mode - always direct execution
 * - Worker uses Executor with a single pseudo-subtask
 * - Faster execution with fewer API calls
 *
 * **Real-time Streaming:**
 * - All agent messages are yielded immediately for user feedback
 * - Task progress tracked and reported in real-time
 *
 * **Direct Architecture:**
 * - Evaluator provides missing_items directly to Worker
 * - No intermediate layers - simplest and fastest approach
 */

import type { AgentMessage } from '../types/agent.js';
import { extractText } from '../utils/sdk.js';
import { Evaluator, type EvaluatorConfig, type EvaluationResult } from '../agents/evaluator.js';
import { Reporter } from '../agents/reporter.js';
import { Executor } from '../agents/executor.js';
import type { LongTaskConfig, SubtaskResult, Subtask } from '../long-task/types.js';
import type { SubtaskProgressEvent } from '../agents/executor.js';
import { createLogger } from '../utils/logger.js';
import { parseTaskMd } from './file-manager.js';
import { Config } from '../config/index.js';

const logger = createLogger('IterationBridge', {});

/**
 * Result of a single iteration.
 */
export interface IterationResult {
  /** All messages produced during iteration */
  messages: AgentMessage[];
  /** Accumulated Worker output text */
  workerOutput: string;
  /** Accumulated Manager output text */
  managerOutput: string;
  /** Whether Worker completed its work (sent 'result' message) */
  workerComplete: boolean;
  /** Whether Manager called task_done to signal completion */
  taskDone: boolean;
}

/**
 * Configuration for IterationBridge.
 */
export interface IterationBridgeConfig {
  /** Executor configuration for task execution */
  executorConfig: LongTaskConfig;
  /** Evaluator configuration */
  evaluatorConfig: EvaluatorConfig;
  /** Full Task.md content */
  taskMdContent: string;
  /** Current iteration number */
  iteration: number;
  /** Task ID for file management */
  taskId: string;
  /** Previous Worker output (for iteration > 1) */
  previousWorkerOutput?: string;
  /** Chat ID for user feedback (passed from DialogueOrchestrator) */
  chatId?: string;
}

/**
 * IterationBridge - Simplified Evaluator-Worker communication for a single iteration.
 *
 * Usage:
 * ```typescript
 * const bridge = new IterationBridge({
 *   executorConfig: { apiKey, model, sendMessage, sendCard, chatId },
 *   evaluatorConfig: { apiKey, model },
 *   taskMdContent,
 *   iteration: 1,
 * });
 *
 * for await (const msg of bridge.runIterationStreaming()) {
 *   // Handle real-time messages
 * }
 * ```
 */
export class IterationBridge {
  readonly executorConfig: LongTaskConfig;
  readonly evaluatorConfig: EvaluatorConfig;
  readonly taskMdContent: string;
  readonly iteration: number;
  readonly taskId: string;
  readonly previousWorkerOutput?: string;
  readonly chatId?: string;

  // Completion tracking
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private taskDoneSignaled = false;  // Set when Evaluator calls task_done
  private workerToManagerQueue: AgentMessage[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private workerDone = false;

  constructor(config: IterationBridgeConfig) {
    this.executorConfig = config.executorConfig;
    this.evaluatorConfig = config.evaluatorConfig;
    this.taskMdContent = config.taskMdContent;
    this.iteration = config.iteration;
    this.taskId = config.taskId;
    this.previousWorkerOutput = config.previousWorkerOutput;
    this.chatId = config.chatId;
  }

  /**
   * Run a single iteration with DIRECT Evaluator → Worker communication.
   *
   * **Simplified architecture:**
   * - Phase 1: Evaluator evaluates task completion, calls task_done if complete
   * - Phase 2: If not complete, Worker executes task directly
   *
   * Key design:
   * - task_done decision happens in Phase 1 (Evaluator)
   * - First iteration: No task_done possible (no Worker output yet)
   * - Evaluator provides missing_items directly to Worker
   * - Always use direct execution mode (no planning)
   *
   * @returns Async iterable of AgentMessage
   */
  async *runIterationStreaming(): AsyncIterable<AgentMessage> {
    logger.info({
      iteration: this.iteration,
    }, 'Starting two-phase IterationBridge iteration with Evaluator (Simplified Architecture)');

    // Reset state for this iteration
    this.workerToManagerQueue = [];
    this.workerDone = false;
    this.taskDoneSignaled = false;

    // === Phase 1: Evaluation - Evaluator decides if task is complete ===
    const evaluator = new Evaluator(this.evaluatorConfig);
    await evaluator.initialize();

    let evaluationResult: EvaluationResult;

    try {
      logger.debug({
        iteration: this.iteration,
      }, 'Phase 1: Evaluation - Evaluator assessing task completion');

      evaluationResult = await this.evaluateCompletion(evaluator);

      if (evaluationResult.is_complete) {
        logger.info({
          iteration: this.iteration,
          reason: evaluationResult.reason,
          confidence: evaluationResult.confidence,
        }, 'Evaluator determined task is complete - ending iteration without Worker');

        this.taskDoneSignaled = true;
        evaluator.cleanup();

        // Yield a completion signal message so DialogueOrchestrator knows task is done
        yield {
          content: `Task completed: ${evaluationResult.reason}`,
          role: 'assistant',
          messageType: 'task_completion',
          metadata: {
            status: 'complete',
          },
        };

        return;  // Early return - task complete, no Worker needed
      }

      logger.info({
        iteration: this.iteration,
        reason: evaluationResult.reason,
        missingItems: evaluationResult.missing_items,
      }, 'Evaluator determined task is not complete - continuing to Phase 2');

    } finally {
      evaluator.cleanup();
    }

    // === Phase 2: Execution with Evaluator's feedback ===
    // Parse Task.md to extract metadata and user request
    const taskMetadata = parseTaskMd(this.taskMdContent);

    // Format Evaluator output as execution instruction
    const executionInstruction = this.formatEvaluatorOutputAsInstruction(evaluationResult);

    logger.debug({
      iteration: this.iteration,
      instructionLength: executionInstruction.length,
      chatId: taskMetadata.chatId || this.chatId,
      messageId: taskMetadata.messageId,
    }, 'Phase 2: Execution phase with Evaluator feedback (streaming to user)');

    // Direct Execute mode: Worker executes directly without planning
    logger.info('Using Direct Execute mode (no planning phase)');
    yield* this.executeTask(executionInstruction, taskMetadata);

    logger.info({
      iteration: this.iteration,
      totalMessages: this.workerToManagerQueue.length,
    }, 'Phase 2: Execution phase complete (streamed to user)');
  }

  /**
   * Execute task directly without planning (simple, fast execution).
   *
   * In this mode:
   * - No planning phase (no Planner agent)
   * - Single Worker/Executor instance executes the entire task
   * - Faster execution with fewer API calls
   * - No multi-step breakdown
   */
  private async *executeTask(
    instruction: string,
    _taskMetadata: { chatId?: string; messageId: string; userRequest: string }
  ): AsyncIterable<AgentMessage> {
    // Indicate direct execution mode
    yield {
      content: '⚡ **Executing Task**\n\nProcessing task directly...',
      role: 'assistant',
      messageType: 'status',
    };

    // Create a single pseudo-subtask for direct execution
    const directSubtask: Subtask = {
      sequence: 1,
      title: 'Execute Task',
      description: instruction,
      inputs: {
        description: 'Task specification from Task.md',
        sources: [],
        context: undefined,
      },
      outputs: {
        description: 'Complete the task as specified in Task.md',
        files: [],
        summaryFile: 'execution-summary.md',
      },
    };

    // Create Reporter for progress formatting
    const reporter = new Reporter({
      apiKey: this.executorConfig.apiKey,
      model: this.executorConfig.model,
      apiBaseUrl: this.executorConfig.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    });
    await reporter.initialize();

    try {
      // Create Executor for the single subtask
      const executor = new Executor(
        this.executorConfig.apiKey,
        this.executorConfig.model,
        this.executorConfig
      );

      // Execute the single subtask
      const generator = executor.executeSubtask(
        directSubtask,
        [], // No previous subtask results
        Config.getWorkspaceDir(),
        this.taskId,
        this.iteration
      );

      let result: IteratorResult<SubtaskProgressEvent, SubtaskResult>;
      let finalResult: SubtaskResult | undefined;

      // Process each progress event
      while (!(result = await generator.next()).done) {
        const event = result.value;

        // For 'output' events, yield directly without Reporter processing
        if (event.type === 'output') {
          yield {
            content: event.content,
            role: 'assistant',
            messageType: event.messageType as any,
            metadata: event.metadata,
          };
          continue;
        }

        // For other events, pass to Reporter for formatting
        const prompt = this.progressEventToPrompt(event, 1); // Only 1 step in direct mode
        if (prompt) {
          for await (const msg of reporter.queryStream(prompt)) {
            yield msg;
          }
        }
      }

      // Get the final result
      finalResult = result.value;

      if (finalResult) {
        // Store result for Evaluator's evaluation
        this.workerToManagerQueue.push({
          content: `Task execution completed:\n\n${finalResult.summary}`,
          role: 'assistant',
          messageType: 'text',
        });

        // Yield completion message
        if (finalResult.success) {
          yield {
            content: `✅ **Task Execution Complete**\n\n**Summary**:\n\n${finalResult.summary}`,
            role: 'assistant',
            messageType: 'result',
          };
        } else {
          yield {
            content: `⚠️ **Task Execution Completed**\n\n${finalResult.summary}`,
            role: 'assistant',
            messageType: 'result',
          };
        }

        this.workerDone = finalResult.success;
      }
    } catch (error) {
      logger.error({
        err: error,
        taskId: this.taskId,
        iteration: this.iteration,
      }, 'Task execution failed');

      yield {
        content: `❌ **Task execution failed**: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    } finally {
      reporter.cleanup();
    }
  }

  /**
   * Evaluate task completion using Evaluator.
   *
   * Phase 1: Evaluator assesses whether the task is complete.
   * Returns structured evaluation result with missing_items.
   *
   * @param evaluator - Evaluator instance
   * @returns Evaluation result
   */
  private async evaluateCompletion(evaluator: Evaluator): Promise<EvaluationResult> {
    // Query Evaluator and parse result
    const { result } = await evaluator.evaluate(
      this.taskMdContent,
      this.iteration,
      this.previousWorkerOutput,
      this.taskId  // ✨ Pass taskId for file management
    );

    logger.debug({
      iteration: this.iteration,
      isComplete: result.is_complete,
      reason: result.reason,
      missingItems: result.missing_items,
      confidence: result.confidence,
    }, 'Evaluator result received');

    return result;
  }

  /**
   * Format Evaluator's output as execution instruction.
   *
   * Converts EvaluationResult into clear, actionable instructions for execution.
   *
   * @param evaluationResult - Result from Evaluator
   * @returns Formatted instruction string for execution
   */
  private formatEvaluatorOutputAsInstruction(evaluationResult: EvaluationResult): string {
    // If no missing items but also not complete (edge case), use reason
    if (evaluationResult.missing_items.length === 0) {
      return evaluationResult.reason;
    }

    // Format missing_items as clear instructions
    let instruction = 'Based on the evaluation, the following items need to be addressed:\n\n';
    instruction += evaluationResult.missing_items.map((item, i) => `${i + 1}. ${item}`).join('\n');
    instruction += '\n\nPlease complete these items to fulfill the task requirements.';

    return instruction;
  }

  /**
   * Collect Worker results from the message queue.
   *
   * @returns Worker's output text
   */
  private collectWorkerResults(): string {
    const results: string[] = [];
    for (const msg of this.workerToManagerQueue) {
      const text = extractText(msg);
      if (text) {
        results.push(text);
      }
    }
    return results.join('\n');
  }

  /**
   * Convert SubtaskProgressEvent to Reporter prompt.
   *
   * @param event - Progress event from Executor
   * @param totalSteps - Total number of steps in the task
   * @returns Prompt string for Reporter
   */
  private progressEventToPrompt(event: SubtaskProgressEvent, totalSteps: number): string {
    switch (event.type) {
      case 'start':
        return `Report that Step ${event.sequence}/${totalSteps} is starting: ${event.title}\n\n${event.description}`;
      case 'complete':
        return `Report that Step ${event.sequence} completed: ${event.title}\n\nCreated ${event.files.length} file(s). Summary: ${event.summaryFile}`;
      case 'error':
        return `Report that Step ${event.sequence} failed: ${event.title}\n\nError: ${event.error}`;
      case 'output':
        // For raw tool output, we yield directly without Reporter processing
        // This avoids unnecessary AI calls for every tool output
        return '';
      default:
        return '';
    }
  }

  /**
   * Get the Worker's output from the most recent iteration.
   * This should be called after runIterationStreaming() completes.
   *
   * @returns Worker's output text
   */
  getWorkerOutput(): string {
    return this.collectWorkerResults();
  }

}
