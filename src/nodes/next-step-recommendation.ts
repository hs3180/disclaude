/**
 * Next Step Recommendation Module for PrimaryNode.
 *
 * Issue #834: Refactored to use simple LLM prompt instead of SkillAgent.
 * - Uses NextStepGenerator to generate candidates
 * - Delegates presentation to ChatAgent.promptNextSteps()
 *
 * This module is now decoupled from the presentation layer.
 * ChatAgent decides how to present candidates (card, text, etc.)
 * based on channel capabilities.
 *
 * @module nodes/next-step-recommendation
 */

import { messageLogger } from '../feishu/message-logger.js';
import { createLogger } from '../utils/logger.js';
import { NextStepGenerator, type NextStepCandidate } from './next-step-generator.js';

const logger = createLogger('NextStepRecommendation');

/**
 * Dependencies needed for next-step recommendations.
 */
export interface NextStepRecommendationDeps {
  /** Get chat history for a chat ID */
  getChatHistory: (chatId: string) => Promise<string | undefined>;
  /**
   * Prompt user with next step candidates (Issue #834).
   * ChatAgent implementation that decides how to present candidates.
   */
  promptNextSteps: (
    candidates: NextStepCandidate[],
    contextMessage?: string,
    threadId?: string
  ) => Promise<void>;
}

/**
 * Default dependencies using messageLogger.
 * Note: promptNextSteps must be provided by caller.
 */
const defaultDeps: Pick<NextStepRecommendationDeps, 'getChatHistory'> = {
  getChatHistory: async (chatId: string) => {
    const history = await messageLogger.getChatHistory(chatId);
    return history && history.trim().length > 0 ? history : undefined;
  },
};

/**
 * Trigger next-step recommendations after task completion.
 *
 * Issue #834: Uses simple LLM prompt to generate candidates, then
 * delegates presentation to ChatAgent.promptNextSteps().
 *
 * Context is limited to recent messages to avoid context overflow.
 *
 * @param chatId - Chat ID to get history from
 * @param threadId - Optional thread ID for reply
 * @param deps - Dependencies including promptNextSteps callback
 */
export async function triggerNextStepRecommendation(
  chatId: string,
  threadId?: string,
  deps?: Partial<NextStepRecommendationDeps>
): Promise<void> {
  // Merge default deps with provided deps
  const fullDeps: NextStepRecommendationDeps = {
    getChatHistory: deps?.getChatHistory ?? defaultDeps.getChatHistory,
    promptNextSteps: deps?.promptNextSteps ?? defaultPromptNextSteps,
  };

  // Check if promptNextSteps is available
  if (!fullDeps.promptNextSteps) {
    logger.warn({ chatId }, 'No promptNextSteps callback provided, skipping recommendations');
    return;
  }

  let generator: NextStepGenerator | undefined;

  try {
    logger.info({ chatId }, 'Triggering next-step recommendations');

    // Get chat history for context
    const chatHistory = await fullDeps.getChatHistory(chatId);

    if (!chatHistory) {
      logger.debug({ chatId }, 'No chat history available for recommendations');
      return;
    }

    // Create generator for next step candidates
    generator = new NextStepGenerator();

    // Limit context to recent messages (Issue #716)
    // Only use the last 10 messages to avoid context overflow
    const recentHistory = extractRecentMessages(chatHistory, 10);

    // Generate candidates using LLM prompt
    const result = await generator.generateCandidates(recentHistory);

    logger.debug(
      { chatId, candidateCount: result.candidates.length },
      'Generated next step candidates'
    );

    // Delegate presentation to ChatAgent
    await fullDeps.promptNextSteps(result.candidates, result.contextMessage, threadId);

    logger.info({ chatId }, 'Next-step recommendations completed');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to trigger next-step recommendations');
  } finally {
    // Dispose generator
    if (generator) {
      generator.dispose();
      logger.debug({ chatId }, 'NextStepGenerator disposed');
    }
  }
}

/**
 * Default promptNextSteps implementation (no-op).
 * In production, this should be provided by PrimaryNode via AgentPool.
 */
async function defaultPromptNextSteps(
  candidates: NextStepCandidate[],
  contextMessage?: string,
  threadId?: string
): Promise<void> {
  logger.warn(
    { candidateCount: candidates.length, contextMessage, threadId },
    'defaultPromptNextSteps called - should be overridden by PrimaryNode'
  );
  // No-op: PrimaryNode should provide the actual implementation
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

// Re-export types for external use
export type { NextStepCandidate, NextStepResult } from './next-step-generator.js';
