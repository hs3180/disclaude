/**
 * DialogueOrchestrator - Manages streaming dialogue with direct Evaluator → Worker flow.
 *
 * ## Architecture: Direct Evaluator-Worker Flow (P0)
 *
 * - Phase 1: Evaluator evaluates task completion
 * - Phase 2: Worker executes with Evaluator's feedback
 * - Direct architecture: No Manager intermediate layer
 * - Loop continues until max iterations reached or task complete
 *
 * ## Key Changes from Previous Architecture
 *
 * **BEFORE (Manager-Worker)**:
 * - Manager (evaluate + instruct) → Worker (execute) → Manager (feedback)
 * - 3 agent instances per iteration
 * - Manager as intermediate layer
 *
 * **AFTER (Direct Evaluator-Worker)**:
 * - Evaluator (evaluate) → Worker (execute with Evaluator feedback)
 * - 2 agent instances per iteration
 * - Direct feedback from Evaluator to Worker
 *
 * ## No Session State Across Iterations
 *
 * - Each iteration creates FRESH Evaluator and Worker instances via IterationBridge
 * - Context is maintained via previousWorkerOutput storage between iterations
 * - No cross-iteration session IDs needed
 */
import type { AgentMessage } from '../types/agent.js';
import { DIALOGUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { extractText } from '../utils/sdk.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { WorkerConfig } from './worker.js';
import type { EvaluatorConfig } from './evaluator.js';
import { IterationBridge } from './iteration-bridge.js';
import { TaskPlanExtractor, type TaskPlanData } from '../long-task/task-plan-extractor.js';
import { DialogueMessageTracker } from './dialogue-message-tracker.js';
import { isTaskDoneTool } from './mcp-utils.js';

const logger = createLogger('DialogueOrchestrator', {});

/**
 * Dialogue orchestrator configuration.
 */
export interface DialogueOrchestratorConfig {
  workerConfig: WorkerConfig;
  evaluatorConfig: EvaluatorConfig;
  /** Callback when task plan is generated */
  onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
}

/**
 * DialogueOrchestrator - Manages streaming dialogue loop between Manager and Worker.
 *
 * Refactored from AgentDialogueBridge to focus on orchestration only.
 * - Task plan extraction delegated to TaskPlanExtractor
 * - Message tracking delegated to DialogueMessageTracker
 * - Uses IterationBridge (formerly StreamBridge) for single iterations
 *
 * NEW Streaming Flow:
 * 1. Each iteration: Manager and Worker run concurrently via IterationBridge
 * 2. Message channels enable bidirectional communication
 * 3. Manager's output → Worker's input, Worker's output → Manager's input
 * 4. When Worker sends 'result' message, iteration ends
 * 5. Loop continues until max iterations reached
 *
 * **User Communication (Manager-only):**
 * - Manager uses `send_user_feedback` MCP tool to communicate with users
 * - Worker output is NEVER directly shown to users - Manager decides what to share
 */
export class DialogueOrchestrator {
  readonly workerConfig: WorkerConfig;
  readonly evaluatorConfig: EvaluatorConfig;
  /** Maximum iterations from constants - single source of truth */
  readonly maxIterations = DIALOGUE.MAX_ITERATIONS;
  private readonly onTaskPlanGenerated?: (plan: TaskPlanData) => Promise<void>;
  private readonly taskPlanExtractor: TaskPlanExtractor;
  private readonly messageTracker: DialogueMessageTracker;

  private taskId: string = '';
  private originalRequest: string = '';
  private taskPlanSaved = false;
  private currentIterationTaskDone = false;
  private currentChatId?: string;

  // Store previous Worker output for Evaluator evaluation in next iteration
  private previousWorkerOutput?: string;

  constructor(config: DialogueOrchestratorConfig) {
    this.workerConfig = config.workerConfig;
    this.evaluatorConfig = config.evaluatorConfig;
    this.onTaskPlanGenerated = config.onTaskPlanGenerated;

    // Initialize extracted services
    this.taskPlanExtractor = new TaskPlanExtractor();
    this.messageTracker = new DialogueMessageTracker();
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
   * Build a task completion message with detailed status.
   *
   * Distinguishes between different completion scenarios:
   * - 'full': Worker executed and completed implementation
   * - 'design_only': Manager completed task in Phase 1 without Worker execution
   *
   * @param iteration - Final iteration number
   * @param completionType - Type of completion
   * @returns Formatted completion message
   */
  private buildTaskCompletionMessage(
    iteration: number,
    completionType: 'full' | 'design_only'
  ): AgentMessage {
    const commonInfo = [
      `**任务ID**: \`${this.taskId}\``,
      `**完成迭代**: ${iteration}`,
    ];

    if (completionType === 'full') {
      logger.info({
        taskId: this.taskId,
        iteration,
        completionType: 'full',
      }, 'Task completed with full implementation');

      return {
        content: `✅ **任务完成**\n\n` +
          `${commonInfo.join('\n')}\n` +
          `\n✨ **执行状态**: 代码已实现并验证完成\n\n` +
          `感谢使用 Disclaude Task 模式！`,
        role: 'assistant',
        messageType: 'task_completion',
      };
    }

    // design_only
    logger.info({
      taskId: this.taskId,
      iteration,
      completionType: 'design_only',
    }, 'Task completed at design phase only');

    return {
      content: `✅ **任务完成（设计方案）**\n\n` +
        `${commonInfo.join('\n')}\n` +
        `\n📋 **已完成**:\n` +
        `- ✅ Task.md 已创建\n` +
        `- ✅ 实现方案已设计\n` +
        `- ✅ 详细指令已生成\n\n` +
        `⚠️ **注意**:\n` +
        `- ❌ 代码尚未实现\n` +
        `- 💡 请参考上述指令手动完成实现\n` +
        `- 🧪 实现后请运行测试验证\n\n` +
        `感谢使用 Disclaude Task 模式！`,
      role: 'assistant',
      messageType: 'task_completion',
    };
  }

  /**
   * Build a warning message when max iterations is reached.
   *
   * @param iteration - Final iteration number
   * @returns Formatted warning message
   */
  private buildMaxIterationsWarning(iteration: number): AgentMessage {
    logger.warn({ iteration }, 'Dialogue reached max iterations without completion');

    return {
      content: `⚠️ **达到最大迭代次数**\n\n` +
        `已完成 ${iteration} 次迭代，达到系统限制。\n` +
        `**任务ID**: \`${this.taskId}\`\n\n` +
        `**建议**:\n` +
        `1. 检查上述输出是否满足需求\n` +
        `2. 如需继续，使用 /reset 重置对话\n` +
        `3. 或调整任务需求后重新提交\n\n` +
        `感谢使用 Disclaude Task 模式！`,
      role: 'assistant',
      messageType: 'max_iterations_warning',
    };
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
   * Process a single dialogue iteration with REAL-TIME streaming Manager-Worker communication.
   *
   * **NEW: Uses runIterationStreaming() for immediate user feedback**
   * - Manager's messages are yielded immediately
   * - Manager's tool calls (send_user_feedback) are executed in real-time
   * - Worker's output is collected only for Manager evaluation
   *
   * New Flow (Streaming):
   *   1. Create IterationBridge with Manager and Worker configs
   *   2. Run iteration with streaming: Manager messages are yielded immediately
   *   3. When Worker sends 'result' message, iteration ends
   *   4. Store Worker output for next iteration
   *
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @returns Async iterable of AgentMessage (real-time Manager output)
   */
  private async *processIterationStreaming(
    taskMdContent: string,
    iteration: number
  ): AsyncIterable<AgentMessage> {
    logger.debug({ iteration }, 'Processing iteration with direct Evaluator-Worker communication');

    // Create IterationBridge with all necessary context including chatId
    const bridge = new IterationBridge({
      workerConfig: this.workerConfig,
      evaluatorConfig: this.evaluatorConfig,
      taskMdContent,
      iteration,
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

      // ✨ P0 FIX: Also check for task_completion message type (from Evaluator)
      if (msg.messageType === 'task_completion') {
        logger.debug({
          iteration,
          messageType: msg.messageType,
          reason: msg.metadata?.reason,
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
   * Run a dialogue loop with REAL-TIME streaming Manager-Worker communication.
   *
   * **NEW: Real-time Streaming Flow**
   * - Manager's messages (including tool calls) are yielded immediately
   * - Users receive progress updates as they happen
   * - Worker's output is collected only for Manager evaluation
   *
   * Flow:
   * 1. Each iteration: Manager runs and yields messages immediately
   * 2. Worker executes based on Manager's instructions (output not yielded)
   * 3. Manager evaluates Worker output and sends next instructions
   * 4. Loop continues until task_done or max iterations
   *
   * @param taskPath - Path to Task.md file
   * @param originalRequest - Original user request text
   * @param chatId - Feishu chat ID (passed to IterationBridge for context)
   * @param _messageId - Unique message ID (reserved for future use)
   * @returns Async iterable of messages (real-time Manager output and tool calls)
   */
  async *runDialogue(
    taskPath: string,
    originalRequest: string,
    chatId: string,
    _messageId: string
  ): AsyncIterable<AgentMessage> {
    this.taskId = path.basename(taskPath, '.md');
    this.originalRequest = originalRequest;
    this.taskPlanSaved = false;
    this.currentIterationTaskDone = false;
    this.currentChatId = chatId;

    const taskMdContent = await fs.readFile(taskPath, 'utf-8');
    let iteration = 0;
    let taskCompleted = false;

    logger.info(
      { taskId: this.taskId, chatId, maxIterations: this.maxIterations },
      'Starting Manager-First dialogue flow with REAL-TIME streaming'
    );

    // Main dialogue loop: Manager → Worker → Manager → Worker → ...
    while (iteration < this.maxIterations) {
      iteration++;

      // Reset task done flag for this iteration
      this.currentIterationTaskDone = false;

      // Process iteration with REAL-TIME streaming
      // All Manager messages (including tool calls) are yielded immediately
      for await (const msg of this.processIterationStreaming(taskMdContent, iteration)) {
        // Save task plan on first iteration (from Manager's output)
        const text = typeof msg.content === 'string' ? msg.content : extractText(msg);
        if (iteration === 1 && text) {
          await this.saveTaskPlanIfNeeded(text, iteration);
        }

        // Yield the message immediately to the user
        yield msg;
      }

      // Check if task was completed during this iteration
      if (this.currentIterationTaskDone) {
        taskCompleted = true;

        // Determine completion type: did Worker execute?
        const hasWorkerExecution = this.previousWorkerOutput && this.previousWorkerOutput.length > 0;
        const completionType: 'full' | 'design_only' = hasWorkerExecution ? 'full' : 'design_only';

        // Send task completion message with detailed status
        yield this.buildTaskCompletionMessage(iteration, completionType);

        break;
      }
    }

    // Warn if max iterations reached without completion
    if (!taskCompleted && iteration >= this.maxIterations) {
      yield this.buildMaxIterationsWarning(iteration);
    }
  }
}

// Re-export TaskPlanData for backward compatibility
export type { TaskPlanData } from '../long-task/task-plan-extractor.js';
