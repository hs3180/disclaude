/**
 * TaskFlowOrchestrator - Manages the complete task flow for Scout → Dialogue execution.
 *
 * This module orchestrates:
 * - Flow 1: Scout creates Task.md
 * - Flow 2: DialogueOrchestrator executes the task
 *
 * Responsibilities:
 * - Coordinate Scout and Dialogue agents
 * - Manage output adapters for Feishu integration
 * - Track message sending and completion
 * - Handle errors and cleanup
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Scout, DialogueOrchestrator, extractText } from '../task/index.js';
import { Config } from '../config/index.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import type { TaskTracker } from '../utils/task-tracker.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import type { Logger } from 'pino';

export interface MessageCallbacks {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<void>;
  sendFile: (chatId: string, filePath: string) => Promise<void>;
}

export interface TaskFlowContext {
  chatId: string;
  messageId: string;
  text: string;
  sender?: { sender_type?: string; sender_id?: { open_id?: string; union_id?: string; user_id?: string } };
  conversationHistory?: string;
}

export class TaskFlowOrchestrator {
  private taskTracker: TaskTracker;
  private messageCallbacks: MessageCallbacks;
  private logger: Logger;

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
   * Execute the complete task flow: Scout → Dialogue
   *
   * @param context - Task execution context
   * @returns Accumulated response content
   */
  async execute(context: TaskFlowContext): Promise<string> {
    const { chatId, messageId, text, sender } = context;
    const agentConfig = Config.getAgentConfig();

    // === FLOW 1: Scout creates Task.md ===
    const taskPath = this.taskTracker.getDialogueTaskPath(messageId);

    const scout = new Scout({
      skillName: 'scout',
    });

    // Set context for Task.md creation
    // Extract open_id from sender_id object (Feishu event structure)
    const senderOpenId = sender?.sender_id?.open_id;
    scout.setTaskContext({
      chatId,
      userId: senderOpenId,
      messageId,
      taskPath,
      conversationHistory: context.conversationHistory,
    });

    // Create output adapter for Scout phase
    const scoutAdapter = new FeishuOutputAdapter({
      sendMessage: async (id: string, msg: string) => {
        await this.messageCallbacks.sendMessage(id, msg);
      },
      sendCard: async (id: string, card: Record<string, unknown>) => {
        await this.messageCallbacks.sendCard(id, card);
      },
      chatId,
      sendFile: this.messageCallbacks.sendFile.bind(null, chatId),
    });
    scoutAdapter.clearThrottleState();
    scoutAdapter.resetMessageTracking();

    // Run Scout to create Task.md
    this.logger.info({ messageId, taskPath }, 'Flow 1: Scout creating Task.md');
    for await (const msg of scout.queryStream(text)) {
      this.logger.debug({ content: msg.content }, 'Scout output');

      // Send text content to user
      if (msg.content && typeof msg.content === 'string') {
        await scoutAdapter.write(msg.content, msg.messageType ?? 'text', {
          toolName: msg.metadata?.toolName as string | undefined,
          toolInputRaw: msg.metadata?.toolInputRaw as Record<string, unknown> | undefined,
        });
      }
    }
    this.logger.info({ taskPath }, 'Task.md created by Scout');

    // === Send task.md content to user ===
    try {
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      await this.messageCallbacks.sendMessage(chatId, taskContent);
    } catch (error) {
      this.logger.error({ err: error, taskPath }, 'Failed to read/send task.md');
    }

    // === FLOW 2: Execute dialogue ===
    return this.executeDialoguePhase(chatId, messageId, text, taskPath, agentConfig);
  }

  /**
   * Execute Flow 2: Dialogue phase
   */
  private async executeDialoguePhase(
    chatId: string,
    messageId: string,
    text: string,
    taskPath: string,
    agentConfig: { apiKey: string; model: string; apiBaseUrl?: string }
  ): Promise<string> {
    // Import MCP tools to set message tracking callback
    const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');

    // Create bridge with agent configs (not instances)
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
    const adapter = new FeishuOutputAdapter({
      sendMessage: async (id: string, msg: string) => {
        messageTracker.recordMessageSent();
        await this.messageCallbacks.sendMessage(id, msg);
      },
      sendCard: async (id: string, card: Record<string, unknown>) => {
        messageTracker.recordMessageSent();
        await this.messageCallbacks.sendCard(id, card);
      },
      chatId,
      sendFile: this.messageCallbacks.sendFile.bind(null, chatId),
    });
    adapter.clearThrottleState();
    adapter.resetMessageTracking();

    // Accumulate response content
    const responseChunks: string[] = [];
    let completionReason = 'unknown';

    try {
      this.logger.debug({ chatId, taskId: path.basename(taskPath, '.md') }, 'Flow 2: Starting dialogue');

      // Run dialogue loop (Flow 2)
      for await (const message of bridge.runDialogue(taskPath, text, chatId, messageId)) {
        const content = typeof message.content === 'string'
          ? message.content
          : extractText(message);

        if (!content) {
          continue;
        }

        responseChunks.push(content);

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

      const finalResponse = responseChunks.join('\n');
      return finalResponse;
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
      await this.messageCallbacks.sendMessage(chatId, errorMsg);

      return errorMsg;
    } finally {
      // Clean up message tracking callback to prevent memory leaks
      const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');
      setMessageSentCallback(null);

      // Check if no user message was sent and send warning
      if (!messageTracker.hasAnyMessage()) {
        const taskId = path.basename(taskPath, '.md');
        const warning = messageTracker.buildWarning(completionReason, taskId);
        this.logger.info({ chatId, completionReason }, 'Sending no-message warning to user');
        await this.messageCallbacks.sendMessage(chatId, warning);
      }
    }
  }
}
