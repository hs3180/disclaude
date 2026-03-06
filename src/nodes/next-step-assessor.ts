/**
 * Next Step Assessor - Simple LLM-based next step recommendation.
 *
 * Issue #834: Replaces SkillAgent with simple LLM prompt.
 * Uses BaseAgent.queryOnce for one-shot LLM calls.
 *
 * Key Design:
 * - No SkillAgent dependency
 * - Simple prompt-based assessment
 * - Returns structured candidates
 * - No MCP tools needed
 *
 * @module nodes/next-step-assessor
 */

import { Config } from '../config/index.js';
import { BaseAgent, type BaseAgentConfig } from '../agents/base-agent.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('NextStepAssessor');

/**
 * Represents a single next step recommendation.
 */
export interface NextStepCandidate {
  /** Unique identifier for the candidate */
  id: string;
  /** Display title with emoji */
  title: string;
  /** Brief description of the action */
  description: string;
  /** Action type for routing (e.g., 'create_github_issue', 'run_tests') */
  action: string;
}

/**
 * Result of next step assessment.
 */
export interface NextStepAssessment {
  /** Task type detected from chat history */
  taskType: string;
  /** List of recommended next steps (2-4 items) */
  candidates: NextStepCandidate[];
  /** Brief summary of what was accomplished */
  summary: string;
}

/**
 * Prompt template for next step assessment.
 */
const NEXT_STEP_PROMPT = `You are a follow-up action recommendation specialist. Analyze the completed task from chat history and suggest relevant next steps.

## Input

You will receive:
- **Chat History**: Recent conversation showing what was accomplished
- **Task Type**: The category of the completed task (if detected)

## Task

1. **Analyze** the chat history to understand what was done
2. **Identify** the task type (coding, research, bug fix, documentation, etc.)
3. **Generate** 2-4 relevant follow-up actions
4. **Output** a JSON response with your recommendations

## Output Format

Output ONLY valid JSON (no markdown, no code blocks):

{
  "taskType": "bug_fix|feature|refactor|research|documentation|test|github|general",
  "summary": "Brief summary of what was accomplished",
  "candidates": [
    {
      "id": "action_1",
      "title": "📋 Title with emoji",
      "description": "What this action does",
      "action": "action_type"
    }
  ]
}

## Recommendation Rules

Based on task type, suggest relevant follow-ups:

- **Bug Fix**: Create GitHub issue, Add regression tests, Document the fix
- **Feature**: Create GitHub PR, Add unit tests, Update documentation
- **Refactor**: Run test suite, Check code coverage, Update related docs
- **Research**: Create summary document, Create GitHub issue with findings
- **Documentation**: Review changes, Publish/merge docs
- **Test**: Run full test suite, Check coverage report
- **GitHub**: Check PR status, Update issue comments
- **General**: Summarize changes, Continue with related work

## Chat History

`;

/**
 * Next Step Assessor - Simple LLM-based assessment without SkillAgent.
 *
 * Issue #834: Uses simple prompt instead of SkillAgent for:
 * - Lower latency (no process communication)
 * - Simpler architecture
 * - Shared process resources
 */
export class NextStepAssessor extends BaseAgent {
  readonly type = 'assessor' as const;
  readonly name = 'NextStepAssessor';

  protected getAgentName(): string {
    return 'NextStepAssessor';
  }

  constructor(config?: Partial<BaseAgentConfig>) {
    const defaultConfig = Config.getAgentConfig();
    super({
      apiKey: config?.apiKey ?? defaultConfig.apiKey,
      model: config?.model ?? defaultConfig.model,
      provider: config?.provider ?? defaultConfig.provider,
      apiBaseUrl: config?.apiBaseUrl ?? defaultConfig.apiBaseUrl,
      permissionMode: config?.permissionMode ?? 'bypassPermissions',
    });
  }

  /**
   * Assess chat history and generate next step recommendations.
   *
   * @param chatHistory - Recent chat messages
   * @param taskTypeHint - Optional hint about task type
   * @returns Assessment with candidates or null on error
   */
  async assess(chatHistory: string, taskTypeHint?: string): Promise<NextStepAssessment | null> {
    const prompt = this.buildPrompt(chatHistory, taskTypeHint);

    logger.debug({ promptLength: prompt.length }, 'Assessing next steps');

    try {
      const sdkOptions = this.createSdkOptions({
        // No MCP tools needed for simple assessment
      });

      let responseText = '';

      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        if (parsed.content) {
          responseText += parsed.content;
        }
      }

      const assessment = this.parseResponse(responseText);
      if (assessment) {
        logger.info({
          taskType: assessment.taskType,
          candidateCount: assessment.candidates.length,
        }, 'Next step assessment completed');
      }

      return assessment;
    } catch (error) {
      logger.error({ err: error }, 'Failed to assess next steps');
      return null;
    }
  }

  /**
   * Build the assessment prompt.
   */
  private buildPrompt(chatHistory: string, taskTypeHint?: string): string {
    let prompt = NEXT_STEP_PROMPT;

    if (taskTypeHint) {
      prompt += `\n\n**Task Type Hint**: ${taskTypeHint}`;
    }

    prompt += `\n\n---\n\n${chatHistory}`;

    return prompt;
  }

  /**
   * Parse LLM response into structured assessment.
   */
  private parseResponse(responseText: string): NextStepAssessment | null {
    try {
      // Try to extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn({ responseLength: responseText.length }, 'No JSON found in response');
        return this.getDefaultAssessment();
      }

      const parsed = JSON.parse(jsonMatch[0]) as NextStepAssessment;

      // Validate structure
      if (!parsed.taskType || !Array.isArray(parsed.candidates)) {
        logger.warn({ parsed }, 'Invalid assessment structure');
        return this.getDefaultAssessment();
      }

      // Ensure candidates have required fields
      parsed.candidates = parsed.candidates.map((c, i) => ({
        id: c.id || `action_${i + 1}`,
        title: c.title || `Action ${i + 1}`,
        description: c.description || '',
        action: c.action || `action_${i + 1}`,
      }));

      return parsed;
    } catch (error) {
      logger.warn({ err: error, responseLength: responseText.length }, 'Failed to parse assessment response');
      return this.getDefaultAssessment();
    }
  }

  /**
   * Get default assessment when parsing fails.
   */
  private getDefaultAssessment(): NextStepAssessment {
    return {
      taskType: 'general',
      summary: 'Task completed',
      candidates: [
        {
          id: 'continue',
          title: '🔄 继续工作',
          description: 'Continue with related tasks',
          action: 'continue',
        },
      ],
    };
  }
}

/**
 * Create a NextStepAssessor instance.
 *
 * @param config - Optional configuration overrides
 * @returns NextStepAssessor instance
 */
export function createNextStepAssessor(config?: Partial<BaseAgentConfig>): NextStepAssessor {
  return new NextStepAssessor(config);
}
