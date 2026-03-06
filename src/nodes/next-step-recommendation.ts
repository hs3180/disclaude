/**
 * Next Step Recommendation Module for PrimaryNode.
 *
 * Issue #834: Refactored to use simple LLM prompt instead of SkillAgent.
 *
 * Key Changes:
 * - Uses NextStepAssessor (simple LLM prompt) instead of SkillAgent
 * - Generates candidates and sends to ChatAgent for display
 * - Removed skills/next-step/SKILL.md dependency
 *
 * Architecture:
 * ```
 * onTaskDone → triggerNextStepRecommendation
 *                    ↓
 *           NextStepAssessor (LLM prompt)
 *                    ↓
 *              candidates (JSON)
 *                    ↓
 *          ChatAgent.promptNextSteps(candidates)
 *                    ↓
 *         ChatAgent decides display method (card/text/etc)
 * ```
 */

import { createLogger } from '../utils/logger.js';
import { createNextStepAssessor, type NextStepAssessment } from './next-step-assessor.js';

const logger = createLogger('NextStepRecommendation');

/**
 * Dependencies needed for next-step recommendations.
 */
export interface NextStepRecommendationDeps {
  /** Get chat history for a chat ID */
  getChatHistory: (chatId: string) => Promise<string | undefined>;
  /** Prompt next steps via ChatAgent (Issue #834) */
  promptNextSteps: (chatId: string, candidates: NextStepAssessment, threadId?: string) => Promise<void>;
}

/**
 * Default dependencies using messageLogger.
 * Note: promptNextSteps must be provided by the caller (PrimaryNode).
 */
const defaultDeps: Partial<NextStepRecommendationDeps> = {
  getChatHistory: async (chatId: string) => {
    const { messageLogger } = await import('../feishu/message-logger.js');
    const history = await messageLogger.getChatHistory(chatId);
    return history && history.trim().length > 0 ? history : undefined;
  },
};

/**
 * Trigger next-step recommendations after task completion.
 *
 * Issue #834: Uses simple LLM prompt instead of SkillAgent.
 * Generates candidates and sends to ChatAgent for display decision.
 *
 * @param chatId - Chat ID to get history from
 * @param threadId - Optional thread ID for reply
 * @param deps - Dependencies for testing
 */
export async function triggerNextStepRecommendation(
  chatId: string,
  threadId?: string,
  deps: Partial<NextStepRecommendationDeps> = defaultDeps
): Promise<void> {
  const assessor = createNextStepAssessor();

  try {
    logger.info({ chatId }, 'Triggering next-step recommendations');

    // Get chat history for context
    const chatHistory = await deps.getChatHistory?.(chatId);

    if (!chatHistory) {
      logger.debug({ chatId }, 'No chat history available for recommendations');
      return;
    }

    // Limit context to recent messages
    const recentHistory = extractRecentMessages(chatHistory, 10);

    // Use simple LLM prompt to generate candidates
    const assessment = await assessor.assess(recentHistory);

    if (!assessment || assessment.candidates.length === 0) {
      logger.debug({ chatId }, 'No recommendations generated');
      return;
    }

    logger.info({
      chatId,
      taskType: assessment.taskType,
      candidateCount: assessment.candidates.length
    }, 'Next-step assessment completed');

    // Send candidates to ChatAgent for display
    if (deps.promptNextSteps) {
      await deps.promptNextSteps(chatId, assessment, threadId);
    } else {
      // Fallback: log candidates if no promptNextSteps provided
      logger.warn(
        { chatId, candidates: assessment.candidates },
        'No promptNextSteps callback, candidates not displayed'
      );
    }

  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to trigger next-step recommendations');
  } finally {
    assessor.dispose();
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
