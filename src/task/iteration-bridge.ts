/**
 * IterationBridge - Simplified Evaluator-Executor communication with REAL-TIME streaming.
 *
 * **Architecture (Simplified - Direct Evaluator → Executor):**
 * - Phase 1: Evaluator evaluates task completion
 * - Phase 2: If not complete, Executor executes the task directly
 *
 * **Key Components:**
 * - **Evaluator** (Phase 1): Specialized in task completion evaluation
 * - **Executor** (Phase 2): Executes tasks directly without subtask concept
 *
 * **Simplified Architecture:**
 * - No Planner layer - Executor executes tasks directly
 * - No subtask concept - Single task execution
 * - Faster execution with fewer API calls
 *
 * **Completion Detection:**
 * - Task completion is determined by the presence of final_result.md
 * - Evaluator returns JSON evaluation result (no task_done tool needed)
 * - Dialogue orchestrator checks for final_result.md after each iteration
 *
 * **Real-time Streaming:**
 * - All agent messages are yielded immediately for user feedback
 * - Task progress tracked and reported in real-time
 *
 * **Direct Architecture:**
 * - Evaluator provides missing_items directly to Executor
 * - No intermediate layers - simplest and fastest approach
 */

import type { AgentMessage } from '../types/agent.js';
import { extractText } from '../utils/sdk.js';
import { Evaluator, type EvaluatorConfig, type EvaluationResult } from '../agents/evaluator.js';
import { Reporter } from '../agents/reporter.js';
import { Executor, type TaskProgressEvent, type TaskResult } from '../agents/executor.js';
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
  /** Accumulated Executor output text */
  workerOutput: string;
  /** Accumulated Manager output text */
  managerOutput: string;
  /** Whether Executor completed its work (sent 'result' message) */
  workerComplete: boolean;
}

/**
 * Configuration for IterationBridge.
 */
export interface IterationBridgeConfig {
  /** Evaluator configuration */
  evaluatorConfig: EvaluatorConfig;
  /** Full Task.md content */
  taskMdContent: string;
  /** Current iteration number */
  iteration: number;
  /** Task ID for file management */
  taskId: string;
  /** Previous Executor output (for iteration > 1) */
  previousExecutorOutput?: string;
  /** Chat ID for user feedback (passed from DialogueOrchestrator) */
  chatId?: string;
}

/**
 * IterationBridge - Simplified Evaluator-Executor communication for a single iteration.
 */
export class IterationBridge {
  readonly evaluatorConfig: EvaluatorConfig;
  readonly taskMdContent: string;
  readonly iteration: number;
  readonly taskId: string;
  readonly previousExecutorOutput?: string;
  readonly chatId?: string;

  // Completion tracking
  private workerToManagerQueue: AgentMessage[] = [];

  constructor(config: IterationBridgeConfig) {
    this.evaluatorConfig = config.evaluatorConfig;
    this.taskMdContent = config.taskMdContent;
    this.iteration = config.iteration;
    this.taskId = config.taskId;
    this.previousExecutorOutput = config.previousExecutorOutput;
    this.chatId = config.chatId;
  }

  /**
   * Run a single iteration with DIRECT Evaluator → Executor communication.
   */
  async *runIterationStreaming(): AsyncIterable<AgentMessage> {
    logger.info({
      iteration: this.iteration,
    }, 'Starting iteration with Evaluator');

    this.workerToManagerQueue = [];

    // === Phase 1: Evaluation ===
    const evaluator = new Evaluator(this.evaluatorConfig);
    await evaluator.initialize();

    let evaluationResult: EvaluationResult;

    try {
      evaluationResult = await this.evaluateCompletion(evaluator);

      if (evaluationResult.is_complete) {
        logger.info({
          iteration: this.iteration,
          reason: evaluationResult.reason,
        }, 'Task complete - ending without Executor');

        evaluator.cleanup();

        yield {
          content: `Task completed: ${evaluationResult.reason}`,
          role: 'assistant',
          messageType: 'task_completion',
          metadata: { status: 'complete' },
        };

        return;
      }

      logger.info({
        iteration: this.iteration,
        missingItems: evaluationResult.missing_items,
      }, 'Task not complete - continuing to Phase 2');

    } finally {
      evaluator.cleanup();
    }

    // === Phase 2: Execution ===
    const taskMetadata = parseTaskMd(this.taskMdContent);
    const executionInstruction = this.formatEvaluatorOutputAsInstruction(evaluationResult);

    logger.debug({
      iteration: this.iteration,
      instructionLength: executionInstruction.length,
    }, 'Phase 2: Execution phase');

    yield* this.executeTask(executionInstruction, taskMetadata);

    logger.info({
      iteration: this.iteration,
      totalMessages: this.workerToManagerQueue.length,
    }, 'Execution phase complete');
  }

  /**
   * Execute task directly without subtask concept.
   */
  private async *executeTask(
    instruction: string,
    _taskMetadata: { chatId?: string; messageId: string; userRequest: string }
  ): AsyncIterable<AgentMessage> {
    yield {
      content: '⚡ **Executing Task**\n\nProcessing task directly...',
      role: 'assistant',
      messageType: 'status',
    };

    const agentConfig = Config.getAgentConfig();
    const reporter = new Reporter({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    });
    await reporter.initialize();

    try {
      const executor = new Executor({});

      const generator = executor.executeTask(
        instruction,
        Config.getWorkspaceDir(),
        this.taskId,
        this.iteration,
        this.previousExecutorOutput
      );

      let result: IteratorResult<TaskProgressEvent, TaskResult>;
      let finalResult: TaskResult | undefined;

      while (!(result = await generator.next()).done) {
        const event = result.value;

        if (event.type === 'output') {
          yield {
            content: event.content,
            role: 'assistant',
            messageType: event.messageType as any,
            metadata: event.metadata,
          };
          continue;
        }

        const prompt = this.progressEventToPrompt(event);
        if (prompt) {
          for await (const msg of reporter.queryStream(prompt)) {
            yield msg;
          }
        }
      }

      finalResult = result.value;

      if (finalResult) {
        this.workerToManagerQueue.push({
          content: `Task execution completed:\n\n${finalResult.output}`,
          role: 'assistant',
          messageType: 'text',
        });

        if (finalResult.success) {
          yield {
            content: `✅ **Task Execution Complete**\n\n**Summary**: ${finalResult.summaryFile}`,
            role: 'assistant',
            messageType: 'result',
          };
        } else {
          yield {
            content: `⚠️ **Task Execution Completed**\n\nError: ${finalResult.error || 'Unknown error'}`,
            role: 'assistant',
            messageType: 'result',
          };
        }
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
   */
  private async evaluateCompletion(evaluator: Evaluator): Promise<EvaluationResult> {
    const { result } = await evaluator.evaluate(
      this.taskMdContent,
      this.iteration,
      this.previousExecutorOutput,
      this.taskId
    );

    logger.debug({
      iteration: this.iteration,
      isComplete: result.is_complete,
      reason: result.reason,
      missingItems: result.missing_items,
    }, 'Evaluator result received');

    return result;
  }

  /**
   * Format Evaluator's output as execution instruction.
   */
  private formatEvaluatorOutputAsInstruction(evaluationResult: EvaluationResult): string {
    if (evaluationResult.missing_items.length === 0) {
      return evaluationResult.reason;
    }

    let instruction = 'Based on the evaluation, the following items need to be addressed:\n\n';
    instruction += evaluationResult.missing_items.map((item, i) => `${i + 1}. ${item}`).join('\n');
    instruction += '\n\nPlease complete these items to fulfill the task requirements.';

    return instruction;
  }

  /**
   * Convert TaskProgressEvent to Reporter prompt.
   */
  private progressEventToPrompt(event: TaskProgressEvent): string {
    switch (event.type) {
      case 'start':
        return `Task started: ${event.title}`;
      case 'complete':
        return `Task completed. Created ${event.files.length} file(s). Summary: ${event.summaryFile}`;
      case 'error':
        return `Task execution failed. Error: ${event.error}`;
      case 'output':
        return '';
      default:
        return '';
    }
  }

  /**
   * Get the Executor's output from the most recent iteration.
   */
  getExecutorOutput(): string {
    const results: string[] = [];
    for (const msg of this.workerToManagerQueue) {
      const text = extractText(msg);
      if (text) {
        results.push(text);
      }
    }
    return results.join('\n');
  }
}
