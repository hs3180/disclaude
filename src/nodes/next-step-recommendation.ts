/**
 * Next Step Recommendation Module for PrimaryNode.
 *
 * Issue #834: Refactored to use simple LLM prompt instead of SkillAgent.
 *
 * Design principles:
 * - Uses simple LLM prompt to generate recommendations
 * - Returns a string prompt containing candidates
 * - The prompt is sent to ChatAgent as a regular message via callback
 *
 * @module nodes/next-step-recommendation
 */

import { generateNextStepPrompt } from './next-step-service.js';
import { messageLogger } from '../feishu/message-logger.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('NextStepRecommendation');

/**
 * Dependencies needed for next-step recommendations.
 */
export interface NextStepRecommendationDeps {
  /** Get chat history for a chat ID */
  getChatHistory: (chatId: string) => Promise<string | undefined>;
  /** Send prompt to ChatAgent */
  sendToAgent: (chatId: string, prompt: string, threadId?: string) => Promise<void>;
}

/**
 * Default dependencies using messageLogger.
 */
const createDefaultDeps = (
  sendToAgent: (chatId: string, prompt: string, threadId?: string) => Promise<void>
): NextStepRecommendationDeps => ({
  getChatHistory: async (chatId: string) => {
    const history = await messageLogger.getChatHistory(chatId);
    return history && history.trim().length > 0 ? history : undefined;
  },
  sendToAgent,
});

/**
 * Trigger next-step recommendations after task completion.
 *
 * Issue #834: Uses simple LLM prompt instead of SkillAgent.
 * Generates recommendations and sends them to ChatAgent as a regular message.
 *
 * @param chatId - Chat ID to get history from
 * @param threadId - Optional thread ID for reply
 * @param sendToAgent - Callback to send prompt to ChatAgent
 * @param deps - Optional dependencies for testing
 */
export async function triggerNextStepRecommendation(
  chatId: string,
  threadId?: string,
  sendToAgent?: (chatId: string, prompt: string, threadId?: string) => Promise<void>,
  deps?: NextStepRecommendationDeps
): Promise<void> {
  // Use provided deps or create default deps with sendToAgent callback
  const dependencies = deps ?? (sendToAgent ? createDefaultDeps(sendToAgent) : undefined);

  if (!dependencies) {
    logger.warn({ chatId }, 'No sendToAgent callback provided, skipping next-step recommendations');
    return;
  }

  try {
    logger.info({ chatId }, 'Triggering next-step recommendations');

    // Get chat history for context
    const chatHistory = await dependencies.getChatHistory(chatId);

    if (!chatHistory) {
      logger.debug({ chatId }, 'No chat history available for recommendations');
      return;
    }

    // Limit context to recent messages
    const recentHistory = extractRecentMessages(chatHistory, 20);

    // Generate next-step prompt using LLM
    const nextStepPrompt = await generateNextStepPrompt(recentHistory);

    if (!nextStepPrompt || nextStepPrompt.trim().length === 0) {
      logger.debug({ chatId }, 'No next-step recommendations generated');
      return;
    }

    // Send the prompt to ChatAgent as a regular message
    await dependencies.sendToAgent(chatId, nextStepPrompt, threadId);

    logger.info({ chatId }, 'Next-step recommendations sent to ChatAgent');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to trigger next-step recommendations');
  }
}

/**
 * Extract recent messages from chat history.
 * Limits context size for LLM execution.
 *
 * @param chatHistory - Full chat history
 * @param count - Number of recent messages to extract (lines)
 * @returns Recent messages as string
 */
export function extractRecentMessages(chatHistory: string, count: number): string {
  const lines = chatHistory.split('\n');
  if (lines.length <= count) {
    return chatHistory;
  }
  // Take the last N lines
  return lines.slice(-count).join('\n');
}
