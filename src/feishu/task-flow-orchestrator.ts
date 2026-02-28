/**
 * TaskFlowOrchestrator - Manages dialogue execution phase.
 *
 * This module handles:
 * - TaskFileWatcher for detecting new Task.md files
 * - ReflectionController execution (Evaluator → Executor → Reporter)
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
 */

import * as path from 'path';
import {
  ReflectionController,
  TerminationConditions,
  DialogueMessageTracker,
} from '../task/index.js';
import { TaskFileWatcher } from '../task/task-file-watcher.js';
import { Config } from '../config/index.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import type { TaskTracker } from '../utils/task-tracker.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import type { Logger } from 'pino';
import type { AgentMessage } from '../types/agent.js';
import type { ReflectionContext } from '../task/reflection.js';
import { Evaluator } from '../agents/evaluator.js';
import { Executor } from '../agents/executor.js';
import { Reporter } from '../agents/reporter.js';
import { TaskFileManager } from '../task/task-files.js';
import { DIALOGUE } from '../config/constants.js';

export interface MessageCallbacks {
  sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<void>;
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
  sendFile: (chatId: string, filePath: string) => Promise<void>;
}

export class TaskFlowOrchestrator {
  private messageCallbacks: MessageCallbacks;
  private logger: Logger;
  private fileWatcher: TaskFileWatcher;

  constructor(
    _taskTracker: TaskTracker,
    messageCallbacks: MessageCallbacks,
    logger: Logger
  ) {
    this.messageCallbacks = messageCallbacks;
    this.logger = logger;

    // Initialize file watcher with serial execution callback
    const workspaceDir = Config.getWorkspaceDir();
    const tasksDir = path.join(workspaceDir, 'tasks');

    this.fileWatcher = new TaskFileWatcher({
      tasksDir,
      onTaskCreated: (taskPath, messageId, chatId) => {
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
   * @param chatId - Feishu chat ID
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
      await this.messageCallbacks.sendMessage(
        chatId,
        `❌ 任务执行失败: ${error instanceof Error ? error.message : String(error)}`,
        messageId
      ).catch((sendError) => {
        this.logger.error({ err: sendError }, 'Failed to send error notification');
      });
    }
  }

  /**
   * Run the dialogue phase using ReflectionController (Evaluator → Executor → Reporter).
   *
   * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
   */
  private async runDialogue(
    chatId: string,
    messageId: string,
    taskPath: string,
    agentConfig: { apiKey: string; model: string; apiBaseUrl?: string }
  ): Promise<void> {
    // Import MCP tools to set message tracking callback
    const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');

    // Extract taskId from taskPath
    const taskDir = path.dirname(taskPath);
    const taskId = path.basename(taskDir);

    // Create message tracker
    const messageTracker = new DialogueMessageTracker();

    // Set the message sent callback to track when MCP tools send messages
    setMessageSentCallback((_chatId: string) => {
      messageTracker.recordMessageSent();
    });

    // Create output adapter for this chat
    // Pass messageId as parentMessageId for thread replies
    const adapter = new FeishuOutputAdapter({
      sendMessage: async (id: string, msg: string) => {
        messageTracker.recordMessageSent();
        await this.messageCallbacks.sendMessage(id, msg, messageId);
      },
      chatId,
    });
    adapter.clearThrottleState();
    adapter.resetMessageTracking();

    // Create file manager for checking final_result.md
    const fileManager = new TaskFileManager();

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
          return fileManager.hasFinalResult(context.taskId);
        },
        // Terminate when max iterations reached
        TerminationConditions.maxIterations(DIALOGUE.MAX_ITERATIONS),
      ]
    );

    // Create execute phase: runs Evaluator
    const executePhase = async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      const evaluator = new Evaluator({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      });

      try {
        yield* evaluator.evaluate(context.taskId, context.iteration);
      } finally {
        evaluator.dispose();
      }
    };

    // Create evaluate phase: runs Executor (after Evaluator)
    const evaluatePhase = async function* (context: ReflectionContext): AsyncGenerator<AgentMessage> {
      // Check if task is already complete
      const hasFinalResult = await fileManager.hasFinalResult(context.taskId);
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

      const reporter = new Reporter({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      });

      const executor = new Executor({
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      });

      const reporterContext = {
        taskId: context.taskId,
        iteration: context.iteration,
        chatId,
      };

      try {
        const executorStream = executor.executeTask(
          context.taskId,
          context.iteration,
          Config.getWorkspaceDir()
        );

        for await (const event of executorStream) {
          yield* reporter.processEvent(event, reporterContext);
        }
      } catch (error) {
        yield {
          content: `❌ **Task execution failed**: ${error instanceof Error ? error.message : String(error)}`,
          role: 'assistant',
          messageType: 'error',
        };
      } finally {
        reporter.dispose();
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
      const hasFinalResult = await fileManager.hasFinalResult(taskId);
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
      await this.messageCallbacks.sendMessage(chatId, errorMsg, messageId);
    } finally {
      // Clean up message tracking callback to prevent memory leaks
      setMessageSentCallback(null);

      // Check if no user message was sent and send warning
      if (!messageTracker.hasAnyMessage()) {
        const warning = messageTracker.buildWarning(completionReason, taskId);
        this.logger.info({ chatId, completionReason }, 'Sending no-message warning to user');
        await this.messageCallbacks.sendMessage(chatId, warning, messageId);
      }
    }
  }
}
