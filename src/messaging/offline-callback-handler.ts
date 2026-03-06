/**
 * Offline Message Callback Handler - Handles user replies to offline messages.
 *
 * This module processes user replies to messages sent via `leave_message` tool
 * and triggers the appropriate callback actions.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * Architecture:
 * ```
 * User replies to message
 *     ↓
 * MessageHandler detects reply
 *     ↓
 * OfflineCallbackHandler.process()
 *     ↓
 * Check if parent is offline message
 *     ↓
 * If yes: trigger callback (create Task/skill)
 *     ↓
 * Mark message as handled
 * ```
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import {
  getOfflineMessageStore,
  type OfflineMessageContext,
} from './offline-message-store.js';

const logger = createLogger('OfflineCallbackHandler');

/**
 * Result of processing a reply.
 */
export interface ReplyProcessResult {
  /** Whether this was a reply to an offline message */
  wasOfflineReply: boolean;
  /** The original message context (if found) */
  context?: OfflineMessageContext;
  /** The callback action that was triggered */
  action?: string;
  /** Any error that occurred */
  error?: string;
}

/**
 * Callback handler for offline message replies.
 *
 * Features:
 * - Detects replies to offline messages
 * - Triggers callback actions (create_task, trigger_skill, record_knowledge)
 * - Marks messages as handled
 *
 * @example
 * ```typescript
 * const handler = new OfflineCallbackHandler();
 *
 * // When user replies to a message
 * const result = await handler.processReply({
 *   parentMessageId: 'om_xxx',
 *   chatId: 'oc_xxx',
 *   replyContent: 'User response',
 *   userId: 'ou_xxx',
 * });
 *
 * if (result.wasOfflineReply) {
 *   console.log('Callback triggered:', result.action);
 * }
 * ```
 */
export class OfflineCallbackHandler {
  /**
   * Process a user reply to check if it's a reply to an offline message.
   *
   * @param params - Reply parameters
   * @returns Processing result
   */
  async processReply(params: {
    parentMessageId: string;
    chatId: string;
    replyContent: string;
    userId: string;
  }): Promise<ReplyProcessResult> {
    const { parentMessageId, chatId, replyContent, userId } = params;

    logger.info({
      parentMessageId,
      chatId,
      userId,
      replyLength: replyContent.length,
    }, 'Processing potential offline message reply');

    try {
      // Find the original offline message
      const store = getOfflineMessageStore();
      await store.initialize();

      const context = await store.findByMessageId(parentMessageId);

      if (!context) {
        logger.debug({ parentMessageId }, 'Not a reply to an offline message');
        return { wasOfflineReply: false };
      }

      // Check if already handled
      if (context.handled) {
        logger.info({ parentMessageId }, 'Offline message already handled');
        return {
          wasOfflineReply: true,
          context,
          error: 'Already handled',
        };
      }

      // Check if expired
      if (context.expiresAt < Date.now()) {
        logger.info({ parentMessageId }, 'Offline message has expired');
        await store.markHandled(parentMessageId);
        return {
          wasOfflineReply: true,
          context,
          error: 'Expired',
        };
      }

      // Trigger the callback action
      const actionResult = await this.triggerCallback(context, replyContent, userId);

      // Mark as handled
      await store.markHandled(parentMessageId);

      logger.info({
        parentMessageId,
        action: context.callbackAction,
        success: actionResult.success,
      }, 'Offline message callback completed');

      return {
        wasOfflineReply: true,
        context,
        action: context.callbackAction,
        error: actionResult.error,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, parentMessageId }, 'Failed to process offline reply');

      return {
        wasOfflineReply: true,
        error: errorMessage,
      };
    }
  }

  /**
   * Trigger the callback action for an offline message.
   */
  private async triggerCallback(
    context: OfflineMessageContext,
    replyContent: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    switch (context.callbackAction) {
      case 'create_task':
        return await this.createTask(context, replyContent, userId);

      case 'trigger_skill':
        return await this.triggerSkill(context, replyContent, userId);

      case 'record_knowledge':
        return await this.recordKnowledge(context, replyContent, userId);

      default:
        return { success: false, error: `Unknown callback action: ${context.callbackAction}` };
    }
  }

  /**
   * Create a Task.md file from the reply.
   */
  private async createTask(
    context: OfflineMessageContext,
    replyContent: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const workspaceDir = Config.getWorkspaceDir();
      const tasksDir = path.join(workspaceDir, 'tasks');

      // Ensure tasks directory exists
      await fs.mkdir(tasksDir, { recursive: true });

      // Generate unique task ID
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const taskId = `offline-${timestamp}-${userId.substring(0, 8)}`;
      const taskDir = path.join(tasksDir, taskId);

      await fs.mkdir(taskDir, { recursive: true });

      // Create Task.md content
      const taskContent = `# Task: Offline Message Reply

## Original Question
${context.question}

${context.agentContext ? `## Context\n${context.agentContext}\n` : ''}

## User Response
${replyContent}

## Metadata
- **Source**: Offline message reply
- **User**: ${userId}
- **Created**: ${new Date().toISOString()}
- **Original Message ID**: ${context.id}

## Instructions
Please process the user's response and take appropriate action.
`;

      await fs.writeFile(path.join(taskDir, 'Task.md'), taskContent, 'utf-8');

      logger.info({ taskId, chatId: context.chatId }, 'Task created from offline message reply');

      return { success: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, 'Failed to create task from offline reply');
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Trigger a skill with the reply content.
   */
  private async triggerSkill(
    context: OfflineMessageContext,
    replyContent: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const skillName = context.callbackParams?.skill as string;

      if (!skillName) {
        return { success: false, error: 'No skill specified in callbackParams' };
      }

      // Create a skill trigger file that the SkillAgent can pick up
      const workspaceDir = Config.getWorkspaceDir();
      const triggersDir = path.join(workspaceDir, '.skill-triggers');

      await fs.mkdir(triggersDir, { recursive: true });

      const triggerFile = path.join(triggersDir, `${Date.now()}-${context.id}.json`);
      const triggerContent = {
        skill: skillName,
        context: {
          originalQuestion: context.question,
          agentContext: context.agentContext,
          userReply: replyContent,
          userId,
          chatId: context.chatId,
          messageId: context.id,
        },
        params: context.callbackParams,
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(triggerFile, JSON.stringify(triggerContent, null, 2), 'utf-8');

      logger.info({
        skill: skillName,
        triggerFile,
        chatId: context.chatId,
      }, 'Skill trigger created from offline message reply');

      return { success: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, 'Failed to trigger skill from offline reply');
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Record the reply to the knowledge base.
   */
  private async recordKnowledge(
    context: OfflineMessageContext,
    replyContent: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const workspaceDir = Config.getWorkspaceDir();
      const knowledgeDir = path.join(workspaceDir, 'knowledge');

      await fs.mkdir(knowledgeDir, { recursive: true });

      // Create a knowledge entry
      const [timestamp] = new Date().toISOString().split('T');
      const knowledgeFile = path.join(knowledgeDir, `offline-replies-${timestamp}.md`);

      const entry = `

---
## Reply from ${userId} at ${new Date().toISOString()}

### Question
${context.question}

${context.agentContext ? `### Context\n${context.agentContext}\n` : ''}

### Response
${replyContent}

`;

      // Append to existing file or create new
      try {
        await fs.appendFile(knowledgeFile, entry, 'utf-8');
      } catch {
        // File doesn't exist, create with header
        const header = `# Knowledge: Offline Message Replies (${timestamp})

This file contains user responses to offline messages.
`;
        await fs.writeFile(knowledgeFile, header + entry, 'utf-8');
      }

      logger.info({
        knowledgeFile,
        chatId: context.chatId,
        userId,
      }, 'Knowledge recorded from offline message reply');

      return { success: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, 'Failed to record knowledge from offline reply');
      return { success: false, error: errorMessage };
    }
  }
}

// Singleton instance
let handlerInstance: OfflineCallbackHandler | null = null;

/**
 * Get the singleton OfflineCallbackHandler instance.
 */
export function getOfflineCallbackHandler(): OfflineCallbackHandler {
  if (!handlerInstance) {
    handlerInstance = new OfflineCallbackHandler();
  }
  return handlerInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetOfflineCallbackHandler(): void {
  handlerInstance = null;
}
