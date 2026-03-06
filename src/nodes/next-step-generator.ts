/**
 * NextStepGenerator - Generates next step recommendations using simple LLM prompt.
 *
 * Issue #834: Replaces SkillAgent-based next-step recommendations with
 * a simple LLM prompt approach. This decouples the recommendation logic
 * from the presentation layer (ChatAgent).
 *
 * Architecture:
 * ```
 * PrimaryNode.onTaskDone
 *     → NextStepGenerator.generateCandidates()
 *         → Returns structured candidates
 *     → ChatAgent.promptNextSteps(candidates)
 *         → ChatAgent decides how to present (card, text, etc.)
 * ```
 *
 * @module nodes/next-step-generator
 */

import { Config } from '../config/index.js';
import { BaseAgent } from '../agents/base-agent.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('NextStepGenerator');

/**
 * A single next step candidate/recommendation.
 */
export interface NextStepCandidate {
  /** Unique identifier for the action */
  id: string;
  /** Display label for the action button */
  label: string;
  /** Emoji icon for the action */
  emoji: string;
  /** Description of what this action does */
  description: string;
}

/**
 * Result from generating next step candidates.
 */
export interface NextStepResult {
  /** List of recommended next steps */
  candidates: NextStepCandidate[];
  /** Optional context message */
  contextMessage?: string;
}

/**
 * System prompt for next step generation.
 * Instructs the LLM to analyze chat history and suggest follow-up actions.
 */
const NEXT_STEP_SYSTEM_PROMPT = `You are a helpful assistant that analyzes completed tasks and suggests relevant follow-up actions.

Based on the chat history, identify what was accomplished and generate 2-4 relevant next steps.

## Response Format

You MUST respond with a valid JSON object in this exact format:
{
  "candidates": [
    {
      "id": "action_id",
      "label": "Action Label",
      "emoji": "emoji",
      "description": "What this action does"
    }
  ],
  "contextMessage": "Optional context about what was done"
}

## Action Types

Generate actions based on what was accomplished:

### If code was changed:
- Create GitHub PR
- Run tests
- Code review request

### If bug was fixed:
- Create GitHub issue for tracking
- Document the fix
- Add regression tests

### If feature was implemented:
- Create GitHub PR
- Update documentation
- Add unit tests

### If research/analysis was done:
- Create summary document
- Create GitHub issue with findings
- Share with team

### If GitHub operations:
- Check PR status
- Update issue comments
- Add labels/milestones

### General:
- Create GitHub issue
- Summarize changes
- Continue with related work

## Rules
- Generate 2-4 relevant actions
- Use appropriate emojis (📋, 📝, 🧪, 🔄, 📊, 🏷️, etc.)
- Keep labels short (2-4 words)
- Make descriptions actionable
- If unsure, suggest general useful actions`;

/**
 * User prompt template for next step generation.
 */
const NEXT_STEP_USER_PROMPT = `Analyze the following chat history and suggest relevant next steps.

## Chat History (most recent messages)

{chatHistory}

## Instructions

1. Identify what was accomplished in this conversation
2. Generate 2-4 relevant follow-up actions
3. Respond ONLY with valid JSON in the required format`;

/**
 * NextStepGenerator - Generates next step candidates using LLM.
 *
 * This class uses a simple LLM prompt to analyze chat history and
 * generate structured next step recommendations. The candidates are
 * then passed to ChatAgent for presentation.
 *
 * @example
 * ```typescript
 * const generator = new NextStepGenerator();
 * const result = await generator.generateCandidates(chatHistory);
 * // result.candidates contains NextStepCandidate[]
 * ```
 */
export class NextStepGenerator extends BaseAgent {
  constructor() {
    const agentConfig = Config.getAgentConfig();
    super({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
      provider: agentConfig.provider,
      permissionMode: 'bypassPermissions',
    });
  }

  protected getAgentName(): string {
    return 'NextStepGenerator';
  }

  /**
   * Generate next step candidates from chat history.
   *
   * @param chatHistory - Recent chat history to analyze
   * @returns Promise resolving to next step candidates
   */
  async generateCandidates(chatHistory: string): Promise<NextStepResult> {
    logger.debug({ historyLength: chatHistory.length }, 'Generating next step candidates');

    // Truncate history if too long (keep last ~4000 chars)
    const truncatedHistory = chatHistory.length > 4000
      ? chatHistory.slice(-4000)
      : chatHistory;

    const userPrompt = NEXT_STEP_USER_PROMPT.replace('{chatHistory}', truncatedHistory);

    const sdkOptions = this.createSdkOptions({
      // No tools needed - just generate text
      disallowedTools: ['*'],
    });

    let responseText = '';

    try {
      for await (const { parsed } of this.queryOnce(
        `${NEXT_STEP_SYSTEM_PROMPT}\n\n${userPrompt}`,
        sdkOptions
      )) {
        if (parsed.type === 'text' && parsed.content) {
          responseText += parsed.content;
        }
        if (parsed.type === 'result') {
          break;
        }
      }

      // Parse the JSON response
      const result = this.parseResponse(responseText);
      logger.debug({ candidateCount: result.candidates.length }, 'Generated next step candidates');
      return result;

    } catch (error) {
      logger.error({ err: error }, 'Failed to generate next step candidates');
      // Return default candidates on error
      return this.getDefaultCandidates();
    }
  }

  /**
   * Parse LLM response into structured result.
   */
  private parseResponse(responseText: string): NextStepResult {
    try {
      // Try to extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('No JSON found in response, using defaults');
        return this.getDefaultCandidates();
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate structure
      if (!Array.isArray(parsed.candidates)) {
        logger.warn('Invalid response structure, using defaults');
        return this.getDefaultCandidates();
      }

      // Validate and normalize candidates
      const candidates: NextStepCandidate[] = parsed.candidates
        .filter((c: unknown) => c && typeof c === 'object')
        .map((c: Record<string, unknown>, index: number) => ({
          id: typeof c.id === 'string' ? c.id : `action_${index}`,
          label: typeof c.label === 'string' ? c.label : 'Action',
          emoji: typeof c.emoji === 'string' ? c.emoji : '📋',
          description: typeof c.description === 'string' ? c.description : '',
        }));

      return {
        candidates,
        contextMessage: typeof parsed.contextMessage === 'string' ? parsed.contextMessage : undefined,
      };

    } catch (parseError) {
      logger.warn({ err: parseError }, 'Failed to parse response, using defaults');
      return this.getDefaultCandidates();
    }
  }

  /**
   * Get default candidates when generation fails.
   */
  private getDefaultCandidates(): NextStepResult {
    return {
      candidates: [
        { id: 'create_issue', label: '提交 GitHub Issue', emoji: '📋', description: '创建一个 GitHub issue 来跟踪这个任务' },
        { id: 'summarize', label: '总结文档', emoji: '📝', description: '生成任务总结文档' },
        { id: 'continue', label: '继续优化', emoji: '🔄', description: '继续改进和完善' },
      ],
      contextMessage: '任务已完成，您可以选择以下操作：',
    };
  }
}
