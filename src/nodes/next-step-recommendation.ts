/**
 * Next Step Recommendation Module for PrimaryNode.
 *
 * Issue #834: Refactored to use simple LLM prompt instead of SkillAgent.
 * - Uses direct LLM call to generate next step candidates
 * - Returns prompt text (string) to be sent to ChatAgent
 * - ChatAgent decides how to present to user (card, text, buttons, etc.)
 *
 * Issue #657: 任务完成后推荐下一步
 */

import { getProvider } from '../sdk/index.js';
import type { AgentQueryOptions } from '../sdk/types.js';
import { messageLogger } from '../feishu/message-logger.js';
import { Config } from '../config/index.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('NextStepRecommendation');

/**
 * Dependencies needed for next-step recommendations.
 */
export interface NextStepRecommendationDeps {
  /** Get chat history for a chat ID */
  getChatHistory: (chatId: string) => Promise<string | undefined>;
  /** Send prompt to ChatAgent for display */
  promptNextSteps: (chatId: string, prompt: string, threadId?: string) => Promise<void>;
}

/**
 * Default dependencies using messageLogger.
 */
const getDefaultDeps = (
  promptNextSteps: (chatId: string, prompt: string, threadId?: string) => Promise<void>
): NextStepRecommendationDeps => ({
  getChatHistory: async (chatId: string) => {
    const history = await messageLogger.getChatHistory(chatId);
    return history && history.trim().length > 0 ? history : undefined;
  },
  promptNextSteps,
});

/**
 * System prompt for generating next step recommendations.
 */
const NEXT_STEP_SYSTEM_PROMPT = `你是一个任务后续步骤推荐专家。当用户完成一个任务后，你需要分析对话历史并推荐2-4个相关的后续操作。

## 输出格式

请直接输出推荐的操作列表，每行一个，格式为：
- emoji + 操作名称：简短描述

## 示例

如果是代码相关的任务：
- 📋 创建 GitHub Issue：记录这个功能或修复
- 🧪 添加测试：确保代码质量
- 📝 更新文档：记录变更内容
- 🔄 继续优化：进一步完善代码

如果是研究分析任务：
- 📝 总结报告：整理分析结果
- 📋 创建 Issue：记录发现的问题
- 🔄 深入研究：探索相关话题

## 规则

1. 推荐必须与完成的任务相关
2. 每个推荐要简洁明了
3. 使用恰当的 emoji 增强可读性
4. 最多4个推荐，最少2个`;

/**
 * Generate next step recommendations using simple LLM prompt.
 *
 * @param chatHistory - Recent chat history
 * @returns Prompt text containing recommendations
 */
async function generateNextStepPrompt(chatHistory: string): Promise<string> {
  const agentConfig = Config.getAgentConfig();

  const options: AgentQueryOptions = {
    cwd: Config.getWorkspaceDir(),
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    env: buildSdkEnv(
      agentConfig.apiKey,
      agentConfig.apiBaseUrl,
      Config.getGlobalEnv(),
      false
    ),
    model: agentConfig.model,
  };

  const provider = getProvider();

  const userPrompt = `${NEXT_STEP_SYSTEM_PROMPT}

## 最近的对话

${chatHistory}

请给出2-4个相关的后续操作建议。`;

  let result = '';

  try {
    for await (const message of provider.queryOnce(
      [
        { role: 'user', content: userPrompt },
      ],
      options
    )) {
      if (message.type === 'text' && message.content) {
        result += message.content;
      }
      // Break on result type (completion)
      if (message.type === 'result') {
        break;
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate next step recommendations');
    // Return a default prompt on error
    return `✅ 任务已完成

接下来您可以：
- 📋 创建 GitHub Issue 记录这次工作
- 🔄 继续相关任务
- ❓ 有其他问题随时问我`;
  }

  if (!result.trim()) {
    return `✅ 任务已完成

接下来您可以：
- 📋 创建 GitHub Issue 记录这次工作
- 🔄 继续相关任务
- ❓ 有其他问题随时问我`;
  }

  return `✅ 任务已完成，以下是一些建议的后续操作：

${result}`;
}

/**
 * Trigger next-step recommendations after task completion.
 * Uses simple LLM prompt to analyze chat history and generate recommendations.
 *
 * Issue #834: Uses simple prompt instead of SkillAgent.
 * Issue #716: No agent storage needed (one-shot LLM call).
 *
 * @param chatId - Chat ID to get history from and send recommendations to
 * @param threadId - Optional thread ID for reply
 * @param promptNextSteps - Callback to send prompt to ChatAgent
 */
export async function triggerNextStepRecommendation(
  chatId: string,
  threadId?: string,
  promptNextSteps: (chatId: string, prompt: string, threadId?: string) => Promise<void> = async () => {
    logger.warn({ chatId }, 'promptNextSteps callback not provided, recommendations will not be displayed');
  }
): Promise<void> {
  const deps = getDefaultDeps(promptNextSteps);

  try {
    logger.info({ chatId }, 'Triggering next-step recommendations');

    // Get chat history for context
    const chatHistory = await deps.getChatHistory(chatId);

    if (!chatHistory) {
      logger.debug({ chatId }, 'No chat history available for recommendations');
      return;
    }

    // Limit context to recent messages
    const recentHistory = extractRecentMessages(chatHistory, 10);

    // Generate recommendations using simple LLM prompt
    const prompt = await generateNextStepPrompt(recentHistory);

    // Send prompt to ChatAgent for display
    await deps.promptNextSteps(chatId, prompt, threadId);

    logger.info({ chatId, promptLength: prompt.length }, 'Next-step recommendations sent to ChatAgent');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to trigger next-step recommendations');
  }
}

/**
 * Extract recent messages from chat history.
 * Limits context size for LLM processing.
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
