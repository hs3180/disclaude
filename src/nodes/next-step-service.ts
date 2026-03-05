/**
 * NextStepService - Next-step recommendations after task completion.
 *
 * Extracts next-step recommendation concerns from PrimaryNode:
 * - Chat history analysis
 * - SkillAgent execution for recommendations
 * - Context limiting for optimal performance
 *
 * Issue #695: Refactored from primary-node.ts
 * Issue #716: SkillAgent disposed after execution, not stored
 *
 * @module nodes/next-step-service
 */

import { createLogger } from '../utils/logger.js';
import { messageLogger } from '../feishu/message-logger.js';
import { AgentFactory } from '../agents/index.js';

const logger = createLogger('NextStepService');

/**
 * NextStepService - Handles next-step recommendations.
 *
 * Uses SkillAgent to analyze chat history and suggest follow-up actions.
 * Context is limited to recent messages to avoid context overflow.
 */
export class NextStepService {
  /**
   * Trigger next-step recommendations after task completion.
   * Uses SkillAgent to analyze chat history and suggest follow-up actions.
   *
   * Issue #716: SkillAgent should be disposed after execution, not stored.
   * Context is limited to recent messages to avoid context overflow.
   *
   * @param chatId - Chat ID to get history from
   * @param threadId - Optional thread ID for reply
   */
  async triggerNextStepRecommendation(chatId: string, threadId?: string): Promise<void> {
    let nextStepAgent: Awaited<ReturnType<typeof AgentFactory.createSkillAgent>> | undefined;

    try {
      logger.info({ chatId }, 'Triggering next-step recommendations');

      // Get chat history for context
      const chatHistory = await messageLogger.getChatHistory(chatId);

      if (!chatHistory || chatHistory.trim().length === 0) {
        logger.debug({ chatId }, 'No chat history available for recommendations');
        return;
      }

      // Create SkillAgent for next-step recommendations using AgentFactory
      nextStepAgent = await AgentFactory.createSkillAgent('next-step');

      // Limit context to recent messages (Issue #716)
      // Only use the last 10 messages to avoid context overflow
      const recentHistory = this.extractRecentMessages(chatHistory, 10);

      // Build prompt with chat history
      const prompt = `## Context

**Chat ID for Feishu tools**: \`${chatId}\`
${threadId ? `**Thread ID**: \`${threadId}\`` : ''}

## Chat History (last 10 messages)

${recentHistory}`;

      // Execute skill and handle responses
      for await (const message of nextStepAgent.execute(prompt)) {
        if (message.type === 'tool_use' || message.metadata?.toolName) {
          logger.debug({ toolName: message.metadata?.toolName }, 'Next-step skill using tool');
        } else if ((message.type === 'text' || message.messageType === 'text') && message.content) {
          logger.debug({ contentLength: typeof message.content === 'string' ? message.content.length : 0 }, 'Next-step skill output');
        }
      }

      logger.info({ chatId }, 'Next-step recommendations completed');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to trigger next-step recommendations');
    } finally {
      // Issue #716: Dispose SkillAgent after execution (do not store)
      if (nextStepAgent) {
        nextStepAgent.dispose();
        logger.debug({ chatId }, 'Next-step SkillAgent disposed');
      }
    }
  }

  /**
   * Extract recent messages from chat history.
   * Limits context size for SkillAgent execution.
   *
   * @param chatHistory - Full chat history
   * @param count - Number of recent messages to extract (lines)
   * @returns Recent messages as string
   */
  extractRecentMessages(chatHistory: string, count: number): string {
    const lines = chatHistory.split('\n');
    if (lines.length <= count) {
      return chatHistory;
    }
    // Take the last N lines
    return lines.slice(-count).join('\n');
  }
}
