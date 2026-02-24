/**
 * TaskFlowOrchestrator - Manages dialogue execution phase.
 *
 * This module handles:
 * - DialogueOrchestrator execution (Evaluator → Executor → Reporter)
 * - Output adapters for Feishu integration
 * - Message tracking and cleanup
 * - Error handling
 *
 * The Task.md creation is handled by Pilot with task skill.
 * This orchestrator only manages the dialogue phase triggered by start_dialogue tool.
 */

import * as path from 'path';
import { DialogueOrchestrator, extractText } from '../task/index.js';
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
  private taskTracker: TaskTracker;
  private messageCallbacks: MessageCallbacks;
  private logger: Logger;

  // Track running background tasks for cleanup
  private runningDialogueTasks: Map<string, Promise<unknown>> = new Map();

  constructor(
    taskTracker: TaskTracker,
    messageCallbacks: MessageCallbacks,
    logger: Logger
  ) {
    this.taskTracker = taskTracker;
    this.messageCallbacks = messageCallbacks;
    this.logger = logger;
  }

  /**
   * Execute dialogue phase for a task.
   *
   * This is called by the start_dialogue tool after Pilot creates Task.md.
   * The dialogue runs asynchronously in the background.
   *
   * @param chatId - Feishu chat ID
   * @param messageId - Unique message identifier
   * @param text - Original user request
   */
  executeDialoguePhase(
    chatId: string,
    messageId: string,
    text: string
  ): void {
    const taskPath = this.taskTracker.getDialogueTaskPath(messageId);
    const agentConfig = Config.getAgentConfig();

    // Run dialogue asynchronously in background
    void this.runDialogue(chatId, messageId, text, taskPath, agentConfig)
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
    text: string,
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

      // Run dialogue loop
      for await (const message of bridge.runDialogue(taskPath, text, chatId, messageId)) {
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
