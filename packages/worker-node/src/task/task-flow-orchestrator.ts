/**
 * TaskFlowOrchestrator - Manages dialogue execution phase.
 *
 * This module handles:
 * - TaskFileWatcher for detecting new Task.md files
 * - ReflectionController execution (SkillAgent with skill files)
 * - Output adapters for Feishu integration
 * - Message tracking and cleanup
 * - Error handling
 *
 * Architecture (Serial Loop):
 * TaskFileWatcher loop: find task → execute (await) → wait (if no task)
 *
 * All tasks are processed serially, one at a time, to prevent:
 * - Resource contention (API quota exhaustion)
 * - Complex state tracking
 * - Debugging difficulties with interleaved logs
 *
 * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
 * Refactored (Issue #417): Removed Reporter, using message level system instead.
 * Simplified (Issue #413): Uses SkillAgent instead of Evaluator/Executor classes.
 */

import * as path from 'path';
import {
  ReflectionController,
  TerminationConditions,
  type ReflectionContext,
  TaskFileWatcher,
  TaskFileManager,
  type TaskFileManagerConfig,
  DialogueMessageTracker,
  TaskTracker,
  type AgentMessage,
  FeishuOutputAdapter,
  handleError,
  ErrorCategory,
  DIALOGUE,
  SkillAgentBase,
  type BaseAgentConfig,
  Config,
} from '@disclaude/core';
import type { Logger } from 'pino';
import type { MessageCallbacks } from '../types.js';

/**
 * Factory function type for creating setMessageSentCallback.
 * This allows the main application to provide the callback setter.
 */
export type SetMessageSentCallbackFn = (callback: ((chatId: string) => void) | null) => void;

/**
 * Configuration for TaskFlowOrchestrator.
 */
export interface TaskFlowOrchestratorConfig {
  /** Workspace directory for task files */
  workspaceDir: string;
  /** Message callbacks for sending messages */
  messageCallbacks: MessageCallbacks;
  /** Logger instance */
  logger: Logger;
  /** Optional function to set message sent callback */
  setMessageSentCallback?: SetMessageSentCallbackFn;
}

/**
 * TaskFlowOrchestrator - Manages dialogue execution for task files.
 *
 * This class is responsible for:
 * 1. Watching for new Task.md files
 * 2. Running the reflection cycle (Execute → Evaluate)
 * 3. Sending output to users via callbacks
 */
export class TaskFlowOrchestrator {
  private config: TaskFlowOrchestratorConfig;
  private logger: Logger;
  private fileWatcher: TaskFileWatcher;
  private taskFileManager: TaskFileManager;

  constructor(
    _taskTracker: TaskTracker,
    config: TaskFlowOrchestratorConfig
  ) {
    this.config = config;
    this.logger = config.logger;

    // Initialize file manager
    const fileManagerConfig: TaskFileManagerConfig = {
      workspaceDir: config.workspaceDir,
    };
    this.taskFileManager = new TaskFileManager(fileManagerConfig);

    // Initialize file watcher with serial execution callback
    const tasksDir = path.join(config.workspaceDir, 'tasks');

    this.fileWatcher = new TaskFileWatcher({
      tasksDir,
      onTaskCreated: (taskPath: string, messageId: string, chatId: string) => {
        // Serial execution: await is handled by TaskFileWatcher's main loop
        return this.executeDialoguePhase(chatId, messageId, taskPath);
      },
    });
  }

  /**
   * Start the file watcher.
   */
  async start(): Promise<void> {
    await this.fileWatcher.start();
    this.logger.info('TaskFlowOrchestrator started with file watcher (serial loop mode)');
  }

  /**
   * Stop the file watcher and cleanup.
   */
  stop(): void {
    this.fileWatcher.stop();
    this.logger.info('TaskFlowOrchestrator stopped');
  }

  /**
   * Execute dialogue phase for a task.
   *
   * This method is async and awaited by TaskFileWatcher to ensure
   * serial execution - only one task runs at a time.
   *
   * @param chatId - Chat ID
   * @param messageId - Unique message identifier
   * @param taskPath - Path to the Task.md file
   */
  async executeDialoguePhase(
    chatId: string,
    messageId: string,
    taskPath: string
  ): Promise<void> {
    const agentConfig = Config.getAgentConfig();

    this.logger.info({ messageId, chatId }, 'Dialogue phase started (serial mode)');

    try {
      await this.runDialogue(chatId, messageId, taskPath, agentConfig);
    } catch (error) {
      this.logger.error({ err: error, chatId, messageId }, 'Dialogue failed');
      // Send error notification to user (as thread reply)
      await this.config.messageCallbacks.sendMessage(
        chatId,
        `❌ 任务执行失败: ${error instanceof Error ? error.message : String(error)}`,
        messageId
      ).catch((sendError) => {
        this.logger.error({ err: sendError }, 'Failed to send error notification');
      });
    }
  }

  /**
   * Run the dialogue phase using ReflectionController (Evaluator → Executor).
   *
   * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
   */
  private async runDialogue(
    chatId: string,
    messageId: string,
    taskPath: string,
    agentConfig: { apiKey: string; model: string; apiBaseUrl?: string }
  ): Promise<void> {
    // Set the message sent callback to track when MCP tools send messages
    if (this.config.setMessageSentCallback) {
      this.config.setMessageSentCallback((_chatId: string) => {
        // Could track message sent here if needed
      });
    }

    // Extract taskId from taskPath
    const taskDir = path.dirname(taskPath);
    const taskId = path.basename(taskDir);

    // Create message tracker
    const messageTracker = new DialogueMessageTracker();

    // Set the message sent callback to track when MCP tools send messages
    if (this.config.setMessageSentCallback) {
      this.config.setMessageSentCallback((_chatId: string) => {
        messageTracker.recordMessageSent();
      });
    }

    // Create output adapter for this chat
    // Pass messageId as parentMessageId for thread replies
    const adapter = new FeishuOutputAdapter({
      sendMessage: async (id: string, msg: string) => {
        messageTracker.recordMessageSent();
        await this.config.messageCallbacks.sendMessage(id, msg, messageId);
      },
      chatId,
    });
    adapter.clearThrottleState();
    adapter.resetMessageTracking();

    let completionReason = 'unknown';

    // Create ReflectionController with termination conditions
    const controller = new ReflectionController(
      {
        maxIterations: DIALOGUE.MAX_ITERATIONS,
        confidenceThreshold: 0.8,
        enableMetrics: true,
      },
      [
        // Terminate when task is complete (final_result.md exists)
        (context: ReflectionContext) => {
          return this.taskFileManager.hasFinalResult(context.taskId);
        },
        // Terminate when max iterations reached
        TerminationConditions.maxIterations(DIALOGUE.MAX_ITERATIONS),
      ]
    );

    // Store reference to this for use in nested functions
    const self = this;

    // Create execute phase: runs Evaluator via SkillAgent
    const executePhase = async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      // Ensure iteration directory exists
      await self.taskFileManager.createIteration(context.taskId, context.iteration);

      // Build template variables
      const templateVars = {
        taskId: context.taskId,
        iteration: String(context.iteration),
        taskMdPath: self.taskFileManager.getTaskSpecPath(context.taskId),
        evaluationPath: self.taskFileManager.getEvaluationPath(context.taskId, context.iteration),
        finalResultPath: self.taskFileManager.getFinalResultPath(context.taskId),
        previousExecutionPath: context.iteration > 1
          ? self.taskFileManager.getExecutionPath(context.taskId, context.iteration - 1)
          : '(No previous execution - this is the first iteration)',
      };

      const skillConfig: BaseAgentConfig = {
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      };

      const evaluator = new SkillAgentBase(skillConfig, 'skills/evaluator/SKILL.md');

      try {
        yield* evaluator.executeWithContext({ templateVars });
      } finally {
        evaluator.dispose();
      }
    };

    // Create evaluate phase: runs Executor via SkillAgent (after Evaluator)
    const evaluatePhase = async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      // Check if task is already complete
      const hasFinalResult = await self.taskFileManager.hasFinalResult(context.taskId);
      if (hasFinalResult) {
        yield {
          content: '✅ Task completed - final result detected',
          role: 'assistant',
          messageType: 'task_completion',
          metadata: { status: 'complete' },
        };
        return;
      }

      yield {
        content: '⚡ **Executing Task**',
        role: 'assistant',
        messageType: 'status',
      };

      // Read evaluation.md for guidance
      let evaluationContent = '(No evaluation guidance available)';
      try {
        evaluationContent = await self.taskFileManager.readEvaluation(context.taskId, context.iteration);
      } catch {
        // No evaluation yet, that's fine
      }

      // Build template variables
      const templateVars = {
        taskId: context.taskId,
        iteration: String(context.iteration),
        taskMdPath: self.taskFileManager.getTaskSpecPath(context.taskId),
        executionPath: self.taskFileManager.getExecutionPath(context.taskId, context.iteration),
        evaluationPath: evaluationContent,
      };

      const skillConfig: BaseAgentConfig = {
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      };

      const executor = new SkillAgentBase(skillConfig, 'skills/executor/SKILL.md');

      try {
        yield* executor.executeWithContext({ templateVars });
      } catch (error) {
        yield {
          content: `❌ **Task execution failed**: ${error instanceof Error ? error.message : String(error)}`,
          role: 'assistant',
          messageType: 'error',
        };
      } finally {
        executor.dispose();
      }
    };

    try {
      this.logger.debug({ chatId, taskId }, 'Starting dialogue with ReflectionController');

      // Run reflection cycle
      for await (const message of controller.run(taskId, executePhase, evaluatePhase)) {
        const content = typeof message.content === 'string'
          ? message.content
          : '';

        if (!content) {
          continue;
        }

        // Send to user
        await adapter.write(content, message.messageType ?? 'text', {
          toolName: message.metadata?.toolName as string | undefined,
          toolInputRaw: message.metadata?.toolInputRaw as Record<string, unknown> | undefined,
        });

        // Update completion reason based on message type
        if (message.messageType === 'result') {
          completionReason = 'task_done';
        } else if (message.messageType === 'error') {
          completionReason = 'error';
        } else if (message.messageType === 'task_completion') {
          completionReason = 'task_done';
        }
      }

      // Check final result
      const hasFinalResult = await this.taskFileManager.hasFinalResult(taskId);
      if (hasFinalResult) {
        completionReason = 'task_done';
      }
    } catch (error) {
      this.logger.error({ err: error, chatId }, 'Task flow failed');
      completionReason = 'error';

      const enriched = handleError(error, {
        category: ErrorCategory.SDK,
        chatId,
        userMessage: 'Task processing failed. Please try again.'
      }, {
        log: true,
        customLogger: this.logger
      });

      const errorMsg = `❌ ${enriched.userMessage || enriched.message}`;
      await this.config.messageCallbacks.sendMessage(chatId, errorMsg, messageId);
    } finally {
      // Clean up message tracking callback to prevent memory leaks
      if (this.config.setMessageSentCallback) {
        this.config.setMessageSentCallback(null);
      }

      // Check if no user message was sent and send warning
      if (!messageTracker.hasAnyMessage()) {
        const warning = messageTracker.buildWarning(completionReason, taskId);
        this.logger.info({ chatId, completionReason }, 'Sending no-message warning to user');
        await this.config.messageCallbacks.sendMessage(chatId, warning, messageId);
      }
    }
  }
}
