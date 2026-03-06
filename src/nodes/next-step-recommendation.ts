/**
 * Next Step Recommendation Module for PrimaryNode.
 *
 * Extracted from primary-node.ts (Issue #695) to improve maintainability.
 * Refactored (Issue #834) to use simple LLM prompt instead of SkillAgent.
 *
 * Issue #657: 任务完成后推荐下一步
 * Issue #834: Use simple prompt instead of skill agent for next step generation
 *
 * Architecture:
 * ```
 * PrimaryNode.onTaskDone
 *     └── triggerNextStepRecommendation
 *             └── generateNextStepCandidates (LLM call)
 *                     └── Returns NextStepResult with candidates
 *                             └── ChatAgent decides how to display
 * ```
 */

import { generateNextStepCandidates } from './next-step-prompt.js';
import { messageLogger } from '../feishu/message-logger.js';
import { createLogger } from '../utils/logger.js';
import { send_user_feedback } from '../mcp/feishu-context-mcp.js';
import type { NextStepResult } from './next-step-types.js';

const logger = createLogger('NextStepRecommendation');

/**
 * Dependencies needed for next-step recommendations.
 */
export interface NextStepRecommendationDeps {
  /** Get chat history for a chat ID */
  getChatHistory: (chatId: string) => Promise<string | undefined>;
  /** Send feedback to user (optional, for direct card sending) */
  sendFeedback?: (chatId: string, card: Record<string, unknown>, threadId?: string) => Promise<void>;
}

/**
 * Default dependencies using messageLogger.
 */
const defaultDeps: NextStepRecommendationDeps = {
  getChatHistory: async (chatId: string) => {
    const history = await messageLogger.getChatHistory(chatId);
    return history && history.trim().length > 0 ? history : undefined;
  },
};

/**
 * Build an interactive card from next-step candidates.
 *
 * Issue #834: This function creates a Feishu card for displaying candidates.
 * In the future, ChatAgent should handle this based on channel type.
 */
function buildNextStepCard(result: NextStepResult): Record<string, unknown> {
  const { candidates, taskSummary } = result;

  // Build action buttons from candidates
  const actions = candidates.map((c) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: c.label },
    type: 'default',
    value: c.id,
  }));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ 任务完成' },
      template: 'blue',
    },
    elements: [
      ...(taskSummary
        ? [
            {
              tag: 'markdown',
              content: `**完成内容**: ${taskSummary}`,
            },
          ]
        : []),
      {
        tag: 'markdown',
        content: '接下来您可以：',
      },
      {
        tag: 'action',
        actions,
      },
    ],
  };
}

/**
 * Trigger next-step recommendations after task completion.
 *
 * Issue #834: Refactored to use simple LLM prompt instead of SkillAgent.
 * This reduces complexity and latency by using a single LLM call.
 *
 * @param chatId - Chat ID to get history from
 * @param threadId - Optional thread ID for reply
 * @param deps - Optional dependencies for testing
 */
export async function triggerNextStepRecommendation(
  chatId: string,
  threadId?: string,
  deps: NextStepRecommendationDeps = defaultDeps
): Promise<void> {
  try {
    logger.info({ chatId, threadId }, 'Triggering next-step recommendations');

    // Get chat history for context
    const chatHistory = await deps.getChatHistory(chatId);

    if (!chatHistory) {
      logger.debug({ chatId }, 'No chat history available for recommendations');
      return;
    }

    // Limit context to recent messages (Issue #716)
    // Only use the last 10 messages to avoid context overflow
    const recentHistory = extractRecentMessages(chatHistory, 10);

    // Generate next-step candidates using LLM (Issue #834)
    const result = await generateNextStepCandidates({
      chatId,
      chatHistory: recentHistory,
    });

    logger.info(
      { chatId, candidateCount: result.candidates.length, taskType: result.taskType },
      'Next-step candidates generated'
    );

    // Issue #834: ChatAgent should decide how to display candidates
    // For now, we send a card directly as a transition step
    // In the future, this should be handled by ChatAgent based on channel type

    // Try to use sendFeedback callback if available (for better testability)
    if (deps.sendFeedback) {
      const card = buildNextStepCard(result);
      await deps.sendFeedback(chatId, card, threadId);
    } else {
      // Fallback to direct MCP call for Feishu
      // This maintains backward compatibility while we transition to ChatAgent-based display
      const card = buildNextStepCard(result);
      await send_user_feedback({
        chatId,
        content: card,
        format: 'card',
        parentMessageId: threadId,
      });
    }

    logger.info({ chatId }, 'Next-step recommendations sent');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to trigger next-step recommendations');
    // Don't throw - this is a non-critical feature
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

// Re-export types for external use
export type { NextStepCandidate, NextStepResult } from './next-step-types.js';
export { generateNextStepCandidates, formatCandidatesForPrompt } from './next-step-prompt.js';
