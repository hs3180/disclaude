/**
 * TaskFlowOrchestrator - Manages dialogue execution phase.
 *
 * This module handles:
 * - TaskFileWatcher for detecting new Task.md files
 * - DialogueOrchestrator execution (Evaluator → Executor → Reporter)
 * - Output adapters for Feishu integration
 * - Message tracking and cleanup
 * - Error handling
 *
 * Architecture:
 * Task.md file created → TaskFileWatcher detects → executeDialoguePhase → Dialogue loop
 */

import * as path from 'path';
import { DialogueOrchestrator, extractText } from '../task/index.js';
import { TaskFileWatcher } from '../task/task-file-watcher.js';
import { Config } from '../config/index.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import type { TaskTracker } from '../utils/task-tracker.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import type { Logger } from 'pino';

export interface MessageCallbacks {
  sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<void>;
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
  sendFile: (chatId: string, filePath: string) => Promise<void>;
}

export class TaskFlowOrchestrator {
  private messageCallbacks: MessageCallbacks;
  private logger: Logger;
  private fileWatcher: TaskFileWatcher;

  // Track running background tasks for cleanup
  private runningDialogueTasks: Map<string, Promise<unknown>> = new Map();

  constructor(
    _taskTracker: TaskTracker,
    messageCallbacks: MessageCallbacks,
    logger: Logger
  ) {
    this.messageCallbacks = messageCallbacks;
    this.logger = logger;

    // Initialize file watcher
    const workspaceDir = Config.getWorkspaceDir();
    const tasksDir = path.join(workspaceDir, 'tasks');

    this.fileWatcher = new TaskFileWatcher({
      tasksDir,
      onTaskCreated: (taskPath, messageId, chatId) => {
        this.executeDialoguePhase(chatId, messageId, taskPath);
      },
    });
  }

  /**
   * Start the file watcher.
   */
  async start(): Promise<void> {
    await this.fileWatcher.start();
    this.logger.info('TaskFlowOrchestrator started with file watcher');
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
   * Triggered by TaskFileWatcher when a new Task.md is detected.
   * The dialogue runs asynchronously in the background.
   *
   * @param chatId - Feishu chat ID
   * @param messageId - Unique message identifier
   * @param taskPath - Path to the Task.md file
   */
  executeDialoguePhase(
    chatId: string,
    messageId: string,
    taskPath: string
  ): void {
    const agentConfig = Config.getAgentConfig();

    // Run dialogue asynchronously in background
    void this.runDialogue(chatId, messageId, taskPath, agentConfig)
      .catch((error) => {
        this.logger.error({ err: error, chatId, messageId }, 'Async dialogue failed');
        // Send error notification to user (as thread reply)
        this.messageCallbacks.sendMessage(chatId, `❌ 后台任务执行失败: ${error instanceof Error ? error.message : String(error)}`, messageId)
          .catch((sendError) => {
            this.logger.error({ err: sendError }, 'Failed to send error notification');
          });
      })
      .finally(() => {
        // Clean up tracking
        this.runningDialogueTasks.delete(messageId);
        this.logger.debug({ messageId }, 'Async dialogue task completed and cleaned up');
      });

    this.logger.info({ messageId, chatId }, 'Dialogue phase started async');
  }

  /**
   * Run the dialogue phase (Evaluator → Executor → Reporter).
   */
  private async runDialogue(
    chatId: string,
    messageId: string,
    taskPath: string,
    agentConfig: { apiKey: string; model: string; apiBaseUrl?: string }
  ): Promise<void> {
    // Import MCP tools to set message tracking callback
    const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');

    // Create bridge with agent configs
    const bridge = new DialogueOrchestrator({
      evaluatorConfig: {
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        apiBaseUrl: agentConfig.apiBaseUrl,
        permissionMode: 'bypassPermissions',
      },
    });

    // Set the message sent callback to track when MCP tools send messages
    const messageTracker = bridge.getMessageTracker();
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
      sendCard: async (id: string, card: Record<string, unknown>) => {
        messageTracker.recordMessageSent();
        await this.messageCallbacks.sendCard(id, card, undefined, messageId);
      },
      chatId,
      sendFile: this.messageCallbacks.sendFile.bind(null, chatId),
    });
    adapter.clearThrottleState();
    adapter.resetMessageTracking();

    let completionReason = 'unknown';

    try {
      this.logger.debug({ chatId, taskId: path.basename(taskPath, '.md') }, 'Starting dialogue');

      // Run dialogue loop (text is extracted from Task.md by DialogueOrchestrator)
      for await (const message of bridge.runDialogue(taskPath, '', chatId, messageId)) {
        const content = typeof message.content === 'string'
          ? message.content
          : extractText(message);

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
        }
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
      const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');
      setMessageSentCallback(null);

      // Check if no user message was sent and send warning
      if (!messageTracker.hasAnyMessage()) {
        const taskId = path.basename(taskPath, '.md');
        const warning = messageTracker.buildWarning(completionReason, taskId);
        this.logger.info({ chatId, completionReason }, 'Sending no-message warning to user');
        await this.messageCallbacks.sendMessage(chatId, warning, messageId);
      }
    }
  }
}
