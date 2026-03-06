/**
 * Next Step Prompt Generator - Generates next-step candidates using LLM.
 *
 * Issue #834: Refactor to use simple prompt instead of skill agent.
 * This module uses a simple LLM prompt to analyze chat history and
 * generate next-step candidates, which are then passed to ChatAgent
 * for display.
 *
 * Architecture:
 * ```
 * triggerNextStepRecommendation
 *     └── generateNextStepCandidates (LLM call)
 *             └── Returns NextStepResult with candidates
 *                     └── ChatAgent decides how to display
 * ```
 */

import { Config } from '../config/index.js';
import { getProvider } from '../sdk/index.js';
import type { IAgentSDKProvider } from '../sdk/interface.js';
import type { AgentQueryOptions } from '../sdk/types.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { createLogger } from '../utils/logger.js';
import type { NextStepCandidate, NextStepResult } from './next-step-types.js';

const logger = createLogger('NextStepPrompt');

/**
 * System prompt for next-step generation.
 */
const NEXT_STEP_SYSTEM_PROMPT = `You are a follow-up action recommendation specialist. When a task completes, analyze the chat history and suggest relevant next steps.

## Your Task

1. Analyze the chat history to understand what was accomplished
2. Identify the task type (coding, research, bug fix, documentation, etc.)
3. Generate 2-4 relevant follow-up actions

## Output Format

You MUST respond with a JSON object in this exact format:
\`\`\`json
{
  "taskSummary": "Brief summary of what was accomplished",
  "taskType": "bug_fix|feature|refactor|research|documentation|test|github|general",
  "candidates": [
    {
      "id": "create_issue",
      "label": "提交 GitHub Issue",
      "description": "Create a GitHub issue to track this work",
      "icon": "📋",
      "category": "github"
    }
  ]
}
\`\`\`

## Task Type Detection

Identify the task type from patterns in the conversation:

| Task Type | Patterns |
|-----------|----------|
| bug_fix | "fix", "bug", "error", "issue", "crash" |
| feature | "implement", "add", "create", "feature" |
| refactor | "refactor", "clean up", "restructure" |
| research | "analyze", "investigate", "research", "explore" |
| documentation | "document", "readme", "docs", "comment" |
| test | "test", "coverage", "spec", "verify" |
| github | "issue", "pr", "commit", "merge" |
| general | Default if no specific pattern |

## Recommendation Rules

Based on task type, suggest relevant follow-ups:

### Bug Fix
- 📋 Create GitHub issue for tracking
- 📝 Document the fix in changelog
- 🧪 Add regression tests

### Feature Implementation
- 📋 Create GitHub issue/PR
- 📝 Update documentation
- 🧪 Add unit tests
- 🔄 Code review request

### Refactor
- 🧪 Run test suite to verify
- 📊 Check code coverage
- 📝 Update related docs

### Research/Analysis
- 📝 Create summary document
- 📋 Create GitHub issue with findings
- 🔄 Share with team

### GitHub Related
- 🔄 Check PR status
- 📝 Update issue comments
- 🏷️ Add labels/milestones

### General
- 📋 Create GitHub issue
- 📝 Summarize changes
- 🔄 Continue with related work

## Important Rules

1. Always respond with valid JSON
2. Generate 2-4 candidates (not more, not less)
3. Each candidate must have id and label
4. Icons should be single emoji characters
5. Keep labels concise (max 20 characters)
6. Descriptions should be brief (max 50 characters)`;

/**
 * Build the user prompt with chat history.
 */
function buildUserPrompt(chatHistory: string, chatId: string): string {
  return `## Context

**Chat ID**: \`${chatId}\`

## Recent Chat History

${chatHistory}

---

Based on the chat history above, generate next-step recommendations in JSON format.`;
}

/**
 * Parse LLM response to extract NextStepResult.
 */
function parseNextStepResponse(response: string): NextStepResult {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonStr);

    // Validate the structure
    if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
      throw new Error('Missing or invalid candidates array');
    }

    // Ensure each candidate has required fields
    const candidates: NextStepCandidate[] = parsed.candidates.map((c: Record<string, unknown>, index: number) => ({
      id: typeof c.id === 'string' ? c.id : `candidate-${index}`,
      label: typeof c.label === 'string' ? c.label : `Option ${index + 1}`,
      description: typeof c.description === 'string' ? c.description : undefined,
      icon: typeof c.icon === 'string' ? c.icon : '📌',
      category: typeof c.category === 'string' ? c.category : 'general',
    }));

    return {
      candidates,
      taskSummary: typeof parsed.taskSummary === 'string' ? parsed.taskSummary : undefined,
      taskType: typeof parsed.taskType === 'string' ? parsed.taskType : 'general',
    };
  } catch (error) {
    logger.warn({ error, response: response.substring(0, 500) }, 'Failed to parse next-step response, using defaults');

    // Return default candidates if parsing fails
    return {
      candidates: [
        { id: 'create_issue', label: '📋 提交 Issue', description: '创建 GitHub Issue', category: 'github' },
        { id: 'summarize', label: '📝 总结文档', description: '生成工作总结', category: 'docs' },
        { id: 'continue', label: '🔄 继续工作', description: '继续相关任务', category: 'general' },
      ],
      taskSummary: '任务已完成',
      taskType: 'general',
    };
  }
}

/**
 * Options for generating next-step candidates.
 */
export interface GenerateNextStepOptions {
  /** Chat ID for context */
  chatId: string;
  /** Recent chat history */
  chatHistory: string;
  /** Override API key */
  apiKey?: string;
  /** Override model */
  model?: string;
}

/**
 * Generate next-step candidates using LLM.
 *
 * This function uses a simple LLM call (not SkillAgent) to analyze
 * chat history and generate next-step recommendations.
 *
 * @param options - Generation options
 * @returns NextStepResult with candidates
 */
export async function generateNextStepCandidates(
  options: GenerateNextStepOptions
): Promise<NextStepResult> {
  const { chatId, chatHistory } = options;

  logger.info({ chatId, historyLength: chatHistory.length }, 'Generating next-step candidates');

  // Get configuration
  const agentConfig = Config.getAgentConfig();
  const apiKey = options.apiKey || agentConfig.apiKey;
  const model = options.model || agentConfig.model;
  const loggingConfig = Config.getLoggingConfig();

  // Build SDK options
  const sdkOptions: AgentQueryOptions = {
    cwd: Config.getWorkspaceDir(),
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    env: buildSdkEnv(
      apiKey,
      agentConfig.apiBaseUrl,
      Config.getGlobalEnv(),
      loggingConfig.sdkDebug
    ),
    model,
  };

  // Get SDK provider
  const sdkProvider: IAgentSDKProvider = getProvider();

  // Build the prompt
  const userPrompt = buildUserPrompt(chatHistory, chatId);
  const fullPrompt = `${NEXT_STEP_SYSTEM_PROMPT}\n\n${userPrompt}`;

  let responseText = '';

  try {
    // Execute LLM query
    for await (const message of sdkProvider.queryOnce(fullPrompt, sdkOptions)) {
      if (message.type === 'text' || message.type === 'result') {
        responseText += message.content || '';
      }
    }

    logger.debug({ chatId, responseLength: responseText.length }, 'LLM response received');

    // Parse the response
    const result = parseNextStepResponse(responseText);

    logger.info(
      { chatId, candidateCount: result.candidates.length, taskType: result.taskType },
      'Next-step candidates generated'
    );

    return result;
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to generate next-step candidates');

    // Return default candidates on error
    return {
      candidates: [
        { id: 'create_issue', label: '📋 提交 Issue', description: '创建 GitHub Issue', category: 'github' },
        { id: 'summarize', label: '📝 总结文档', description: '生成工作总结', category: 'docs' },
        { id: 'continue', label: '🔄 继续工作', description: '继续相关任务', category: 'general' },
      ],
      taskSummary: '任务已完成',
      taskType: 'general',
    };
  }
}

/**
 * Format candidates for display in ChatAgent context.
 *
 * This function formats the candidates as a prompt that can be
 * injected into ChatAgent's context, allowing ChatAgent to decide
 * how to present them to the user based on the channel type.
 *
 * @param result - NextStepResult from generation
 * @param chatId - Chat ID for context
 * @returns Formatted prompt string
 */
export function formatCandidatesForPrompt(result: NextStepResult, chatId: string): string {
  const { candidates, taskSummary, taskType } = result;

  const candidatesList = candidates
    .map((c) => `- ${c.icon || '📌'} **${c.label}**${c.description ? `: ${c.description}` : ''}`)
    .join('\n');

  return `## ✅ 任务完成

${taskSummary ? `**完成内容**: ${taskSummary}` : ''}

**任务类型**: ${taskType || 'general'}

### 接下来您可以：

${candidatesList}

---
*Chat ID: \`${chatId}\`*
*请根据用户的 channel 类型，选择合适的方式展示这些建议（如卡片、按钮、文本等）*`;
}
