/**
 * Next Step Service - Generates next-step recommendations using simple LLM prompt.
 *
 * Issue #834: Replaces SkillAgent-based approach with simple LLM prompt.
 *
 * Design principles:
 * - Uses simple LLM prompt (not SkillAgent) to generate recommendations
 * - Returns a string prompt containing candidates
 * - The prompt is sent to ChatAgent as a regular message
 *
 * @module nodes/next-step-service
 */

import { getProvider } from '../sdk/index.js';
import type { AgentQueryOptions } from '../sdk/types.js';
import { Config } from '../config/index.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('NextStepService');

/**
 * System prompt for next-step generation.
 */
const NEXT_STEP_SYSTEM_PROMPT = `你是一个智能助手，负责分析用户的对话历史并推荐下一步可能的操作。

## 任务

根据最近的对话历史，分析用户可能需要的下一步操作。

## 输出格式

请直接输出推荐的下一步操作，格式如下：

---
**建议的下一步操作：**

1. [第一个建议] - [简要说明为什么这个建议相关]
2. [第二个建议] - [简要说明为什么这个建议相关]
3. [第三个建议] - [简要说明为什么这个建议相关]

**注意事项：**
- [任何需要用户注意的事项]
---

## 要求

1. 建议 2-4 个相关的下一步操作
2. 每个建议应该基于对话历史中的具体内容
3. 如果对话中有未完成的任务，优先推荐完成这些任务
4. 如果对话中有提到的问题，推荐解决方案
5. 保持建议简洁、实用
6. 如果对话历史太短或没有明确的上下文，可以输出"暂无明确建议"`;

/**
 * Generate next-step recommendations prompt using LLM.
 *
 * This function:
 * 1. Takes chat history as input
 * 2. Uses LLM to analyze the history and generate recommendations
 * 3. Returns a string prompt containing the recommendations
 *
 * The returned string should be sent to ChatAgent as a regular message.
 *
 * @param chatHistory - Recent chat history
 * @returns Promise<string> - A string containing next-step recommendations
 */
export async function generateNextStepPrompt(chatHistory: string): Promise<string> {
  logger.debug({ historyLength: chatHistory.length }, 'Generating next-step prompt');

  // Get SDK provider
  const provider = getProvider();

  // Build SDK options
  const loggingConfig = Config.getLoggingConfig();
  const agentConfig = Config.getAgentConfig();

  const options: AgentQueryOptions = {
    cwd: Config.getWorkspaceDir(),
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    env: buildSdkEnv(
      agentConfig.apiKey,
      agentConfig.apiBaseUrl,
      Config.getGlobalEnv(),
      loggingConfig.sdkDebug
    ),
    model: agentConfig.model,
  };

  // Build the combined prompt (system + user context)
  const combinedPrompt = `${NEXT_STEP_SYSTEM_PROMPT}

---

## 最近对话历史

${chatHistory}

---

请根据以上对话历史，分析并推荐用户可能需要的下一步操作。`;

  // Execute LLM query
  let result = '';

  try {
    const iterator = provider.queryOnce(combinedPrompt, options);

    for await (const message of iterator) {
      if (message.type === 'text') {
        result += message.content || '';
      }
      // Stop at result type (query complete)
      if (message.type === 'result') {
        break;
      }
    }

    logger.debug({ resultLength: result.length }, 'Next-step prompt generated');

    // Return the recommendations as a string
    return `## 💡 下一步建议

${result}`;
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate next-step prompt');
    // Return empty string on error (no recommendations)
    return '';
  }
}
