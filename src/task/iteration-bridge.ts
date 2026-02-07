/**
 * IterationBridge - Simplified Evaluator-Worker communication with REAL-TIME streaming.
 *
 * **Architecture (P0 - Direct Evaluator → Worker):**
 * - Phase 1: Evaluator evaluates task completion and calls task_done if complete
 * - Phase 2: If not complete, Worker executes with Evaluator's feedback
 * - Phase 3: Reporter receives Worker output and organizes user feedback
 *
 * **Key Components:**
 * - **Evaluator** (Phase 1): Specialized in task completion evaluation
 * - **Worker** (Phase 2): Executes tasks with full tool access
 * - **Reporter** (Phase 3): Organizes user feedback
 *
 * **Real-time Streaming:**
 * - Reporter's messages (send_user_feedback) are yielded immediately for execution
 * - Worker's output is NOT yielded (only for Evaluator evaluation)
 *
 * **Direct Architecture:**
 * - Evaluator provides missing_items directly to Worker
 * - No Manager intermediate layer - simpler and faster
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentMessage } from '../types/agent.js';
import { extractText } from '../utils/sdk.js';
import { Worker, type WorkerConfig } from './worker.js';
import { Evaluator, type EvaluatorConfig, type EvaluatorInput, type EvaluationResult } from './evaluator.js';
import { createLogger } from '../utils/logger.js';
import { isTaskDoneTool } from './mcp-utils.js';
import { parseTaskMd } from './prompt-builder.js';
import { loadSkill } from './skill-loader.js';

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
  workerConfig: WorkerConfig;
  evaluatorConfig: EvaluatorConfig;
  /** Full Task.md content */
  taskMdContent: string;
  /** Current iteration number */
  iteration: number;
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
 *   workerConfig: { apiKey, model },
 *   evaluatorConfig: { apiKey, model },
 *   taskMdContent,
 *   iteration: 1,
 * });
 *
 * const result = await bridge.runIteration();
 * ```
 */
export class IterationBridge {
  readonly workerConfig: WorkerConfig;
  readonly evaluatorConfig: EvaluatorConfig;
  readonly taskMdContent: string;
  readonly iteration: number;
  readonly previousWorkerOutput?: string;
  readonly chatId?: string;

  // Completion tracking
  private taskDoneSignaled = false;  // Set when Evaluator calls task_done
  // Worker output for Evaluator evaluation
  private workerOutput = '';
  // Evaluation result from Evaluator
  private lastEvaluationResult?: EvaluationResult;

  constructor(config: IterationBridgeConfig) {
    this.workerConfig = config.workerConfig;
    this.evaluatorConfig = config.evaluatorConfig;
    this.taskMdContent = config.taskMdContent;
    this.iteration = config.iteration;
    this.previousWorkerOutput = config.previousWorkerOutput;
    this.chatId = config.chatId;
  }

  /**
   * Run a single iteration with DIRECT Evaluator → Worker communication.
   *
   * **Direct architecture (P0):**
   * - Phase 1: Evaluator evaluates task completion, calls task_done if complete
   * - Phase 2: Worker executes with Evaluator's feedback (if not complete)
   *
   * Key design:
   * - task_done decision happens in Phase 1 (Evaluator)
   * - First iteration: No task_done possible (no Worker output yet)
   * - Evaluator provides missing_items directly to Worker
   *
   * @returns Async iterable of AgentMessage
   */
  async *runIterationStreaming(): AsyncIterable<AgentMessage> {
    logger.info({
      iteration: this.iteration,
    }, 'Starting three-phase IterationBridge iteration with Evaluator (P0 Architecture)');

    // Reset state for this iteration
    this.workerToManagerQueue = [];
    this.workerDone = false;
    this.collectedManagerInstruction = '';
    this.taskDoneSignaled = false;
    this.lastEvaluationResult = undefined;

    // === Phase 1a: Evaluation - Evaluator decides if task is complete ===
    const evaluator = new Evaluator(this.evaluatorConfig);
    await evaluator.initialize();

    let evaluationResult: EvaluationResult;

    try {
      logger.debug({
        iteration: this.iteration,
      }, 'Phase 1a: Evaluation - Evaluator assessing task completion');

      evaluationResult = await this.evaluateCompletion(evaluator);

      // Store evaluation result for Manager to use
      this.lastEvaluationResult = evaluationResult;

      if (evaluationResult.is_complete) {
        logger.info({
          iteration: this.iteration,
          reason: evaluationResult.reason,
          confidence: evaluationResult.confidence,
        }, 'Evaluator determined task is complete - ending iteration without Worker');

        this.taskDoneSignaled = true;
        evaluator.cleanup();

        // ✨ P0 FIX: Yield a completion signal message so DialogueOrchestrator knows task is done
        yield {
          content: `Task completed: ${evaluationResult.reason}`,
          role: 'assistant',
          messageType: 'task_completion',
          metadata: {
            is_complete: true,
            reason: evaluationResult.reason,
            confidence: evaluationResult.confidence,
          },
        };

        return;  // Early return - task complete, no Worker or Manager needed
      }

      logger.info({
        iteration: this.iteration,
        reason: evaluationResult.reason,
        missingItems: evaluationResult.missing_items,
      }, 'Evaluator determined task is not complete - continuing to Phase 1b');

    } finally {
      evaluator.cleanup();
    }

    // === Phase 2: Worker executes with Evaluator's feedback ===
    // Parse Task.md to extract metadata and user request
    const taskMetadata = parseTaskMd(this.taskMdContent);

    // Load Worker skill for prompt template
    const workerSkillResult = await loadSkill('worker');
    const workerSkillContent = workerSkillResult.success && workerSkillResult.skill
      ? workerSkillResult.skill.content
      : undefined;

    // Determine task path from Task.md (fallback to taskId if not found)
    // Task.md is typically at workspace/tasks/{taskId}/Task.md
    const taskPath = `workspace/tasks/${taskMetadata.messageId}/Task.md`;

    // Format Evaluator output as Worker instruction
    const workerInstruction = this.formatEvaluatorOutputAsInstruction(evaluationResult);

    // Build Worker prompt with Evaluator's feedback
    const workerPrompt = Worker.buildPrompt(
      taskMetadata.userRequest,
      workerInstruction,
      taskMetadata.chatId || this.chatId || '',
      taskMetadata.messageId,
      taskPath,
      workerSkillContent
    );

    logger.debug({
      iteration: this.iteration,
      instructionLength: workerInstruction.length,
      chatId: taskMetadata.chatId || this.chatId,
      messageId: taskMetadata.messageId,
    }, 'Phase 2: Worker executing with Evaluator feedback (direct architecture)');

    // Create Worker instance
    const worker = new Worker(this.workerConfig);
    await worker.initialize();

    try {
      // Run Worker coroutine
      await this.runWorkerCoroutine(worker, workerPrompt);

      logger.info({
        iteration: this.iteration,
        queuedMessages: this.workerToManagerQueue.length,
      }, 'Phase 2: Worker completed');

      // Store Worker output for next iteration's Evaluator
      this.workerOutput = this.collectWorkerResults();

    } finally {
      // Cleanup Worker
      worker.cleanup();
    }

    logger.info({
      iteration: this.iteration,
    }, 'Direct architecture IterationBridge iteration complete');
  }

  /**
   * Legacy method: Run a single iteration and return buffered results.
   *
   * @deprecated Use runIterationStreaming() for real-time user feedback.
   * This method is kept for backward compatibility.
   */
  async runIteration(): Promise<IterationResult> {
    logger.info({ iteration: this.iteration }, 'Using LEGACY buffered runIteration (deprecated)');

    const messages: AgentMessage[] = [];
    const managerOutputBuf: string[] = [];

    // Collect all messages from the streaming version
    for await (const msg of this.runIterationStreaming()) {
      messages.push(msg);

      // Collect text from non-tool messages (Manager output)
      if (msg.messageType !== 'tool_use') {
        const text = extractText(msg);
        if (text) {
          managerOutputBuf.push(text);
        }
      }
    }

    // Worker output is in the queue
    const workerOutput = this.collectWorkerResults();

    return {
      messages,
      workerOutput,
      managerOutput: managerOutputBuf.join(''),
      workerComplete: this.workerDone,
      taskDone: this.taskDoneSignaled,
    };
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

  /**
   * Format Evaluator's output as Worker instruction.
   *
   * Converts EvaluationResult into clear, actionable instructions for Worker.
   *
   * @param evaluationResult - Result from Evaluator
   * @returns Formatted instruction string for Worker
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
  private async evaluateCompletion(evaluator: Evaluator): Promise<EvaluationResult> {
    // Query Evaluator and parse result
    const { result } = await evaluator.evaluate(
      this.taskMdContent,
      this.iteration,
      this.previousWorkerOutput
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
   * Get the Worker's output from the most recent iteration.
   * This should be called after runIterationStreaming() completes.
   *
   * @returns Worker's output text
   */
  getWorkerOutput(): string {
    return this.collectWorkerResults();
  }

  /**
   * Convert string prompt to AsyncIterable<SDKUserMessage> for Streaming Input mode.
   * This enables Manager to receive multi-turn conversation context.
   *
   * @param prompt - String prompt to convert
   * @returns Async iterable of SDK user messages
   */
  private async *promptAsMessages(prompt: string): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: prompt,
      },
      parent_tool_use_id: null,
      session_id: '',
    };
  }

  /**
   * Worker coroutine - executes task and queues messages for Manager.
   *
   * Worker calls SDK query(), SDK starts Worker coroutine.
   * All messages are queued for Manager, not yielded to user.
   *
   * @param worker - Worker instance
   * @param prompt - Worker prompt
   */
  private async runWorkerCoroutine(worker: Worker, prompt: string): Promise<void> {
    logger.debug({
      iteration: this.iteration,
      promptLength: prompt.length,
    }, 'Worker coroutine started');

    // worker.queryStream() calls SDK query() which starts Worker coroutine
    for await (const msg of worker.queryStream(prompt)) {
      // Queue all Worker messages for Manager (not yielded to user)
      this.workerToManagerQueue.push(msg);

      // Check for result message - Worker is done
      if (msg.messageType === 'result') {
        logger.debug({
          iteration: this.iteration,
        }, 'Worker sent result message, setting workerDone=true');
        this.workerDone = true;
        break; // Worker coroutine ends
      }
    }

    logger.debug({
      iteration: this.iteration,
      queuedMessages: this.workerToManagerQueue.length,
    }, 'Worker coroutine finished');
  }
}
