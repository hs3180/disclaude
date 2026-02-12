/**
 * Reporter - Communication and instruction generation specialist.
 *
 * **Single Responsibility**: Generate Executor instructions and format user feedback.
 *
 * **Key Differences from Manager:**
 * - Manager: Evaluates AND generates instructions AND formats output
 * - Reporter: ONLY generates instructions and formats output, does NOT evaluate
 *
 * **Tools Available:**
 * - send_user_feedback: Send formatted feedback to user
 * - send_file_to_feishu: Send files to user (e.g., reports, logs, generated content)
 *
 * **Tools NOT Available (intentionally restricted):**
 * - task_done: Evaluator's job, not Reporter's
 *
 * **Workflow:**
 * 1. Receive evaluation result from Evaluator
 * 2. Read Task.md and Executor output
 * 3. Generate Executor instructions (if not complete)
 * 4. Format user feedback
 * 5. Send files to user (if applicable)
 * 6. Call send_user_feedback
 *
 * **Output Format:**
 * Reporter generates user-facing messages:
 * - Executor instructions (clear, actionable)
 * - Progress updates (what was accomplished)
 * - Next steps (what needs to be done)
 * - File attachments (reports, logs, etc.)
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import type { AgentMessage, AgentInput } from '../types/agent.js';
import { feishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';
import { createLogger } from '../utils/logger.js';
import { loadSkillOrThrow, type ParsedSkill } from '../task/skill-loader.js';
import type { EvaluationResult } from './evaluator.js';
import { AgentExecutionError, TimeoutError, formatError } from '../utils/errors.js';

/**
 * Input type for Reporter queries.
 */
export type ReporterInput = AgentInput;

/**
 * Reporter agent configuration.
 */
export interface ReporterConfig {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
  permissionMode?: 'default' | 'bypassPermissions';
}

/**
 * Type for permission mode.
 */
export type ReporterPermissionMode = 'default' | 'bypassPermissions';

/**
 * Reporter - Communication and instruction generation specialist.
 */
export class Reporter {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl?: string;
  readonly permissionMode: ReporterPermissionMode;
  protected skill?: ParsedSkill;
  protected initialized = false;
  private readonly provider: 'anthropic' | 'glm';

  private readonly logger = createLogger('Reporter');

  constructor(config: ReporterConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissionMode = config.permissionMode || 'bypassPermissions';

    // Detect provider from API base URL
    const agentConfig = Config.getAgentConfig();
    this.provider = agentConfig.provider;
  }

  /**
   * Initialize the Reporter agent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load skill (required)
    this.skill = await loadSkillOrThrow('reporter');
    this.logger.debug({
      skillName: this.skill.name,
      toolCount: this.skill.allowedTools.length,
    }, 'Reporter skill loaded');

    this.initialized = true;
    this.logger.debug('Reporter initialized');
  }

  /**
   * Query the Reporter agent with streaming response.
   *
   * @param input - Prompt or message array
   * @returns Async iterable of agent messages
   */
  async *queryStream(input: ReporterInput): AsyncIterable<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Create SDK options for Reporter
    // Skill is required, so allowedTools is always defined
    const allowedTools = this.skill!.allowedTools;
    // Note: task_done is intentionally NOT included (Evaluator's job)

    const sdkOptions: Record<string, unknown> = {
      cwd: Config.getWorkspaceDir(),
      permissionMode: this.permissionMode,
      allowedTools,
      settingSources: ['project'],
      mcpServers: {
        'feishu-context': feishuSdkMcpServer,
      },
    };

    // Set environment
    sdkOptions.env = buildSdkEnv(this.apiKey, this.apiBaseUrl);

    // Set model
    if (this.model) {
      sdkOptions.model = this.model;
    }

    const ITERATOR_TIMEOUT_MS = 30000; // 30 seconds timeout for Reporter

    try {
      // Query SDK with timeout protection
      const queryResult = query({ prompt: input, options: sdkOptions as any });
      const iterator = queryResult[Symbol.asyncIterator]();

      while (true) {
        // Race between next message and timeout
        const nextPromise = iterator.next();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Iterator timeout')), ITERATOR_TIMEOUT_MS)
        );

        const result = await Promise.race([nextPromise, timeoutPromise]) as IteratorResult<unknown>;

        if (result.done) {
          break;
        }

        const message = result.value as SDKMessage;
        const parsed = parseSDKMessage(message);

        // GLM-specific logging to monitor streaming behavior
        if (this.provider === 'glm') {
          this.logger.debug({
            provider: 'GLM',
            messageType: parsed.type,
            contentLength: parsed.content?.length || 0,
            toolName: parsed.metadata?.toolName,
            stopReason: (message as any).stop_reason,
            stopSequence: (message as any).stop_sequence,
            rawMessagePreview: JSON.stringify(message).substring(0, 500),
          }, 'SDK message received (GLM)');
        }

        // Yield formatted message
        yield {
          content: parsed.content,
          role: 'assistant',
          messageType: parsed.type,
          metadata: parsed.metadata,
        };
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Iterator timeout') {
        const timeoutError = new TimeoutError(
          'Reporter query timeout - unable to generate report',
          ITERATOR_TIMEOUT_MS,
          'queryStream'
        );
        this.logger.warn({ err: formatError(timeoutError) }, 'Reporter iterator timeout - unable to complete reporting');
        yield {
          content: '⚠️ Query timeout - unable to generate report',
          role: 'assistant',
          messageType: 'error',
        };
      } else {
        const agentError = new AgentExecutionError(
          'Reporter query failed',
          {
            cause: error instanceof Error ? error : new Error(String(error)),
            agent: 'Reporter',
            recoverable: true,
          }
        );
        this.logger.error({ err: formatError(agentError) }, 'Reporter query failed');
        yield {
          content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          role: 'assistant',
          messageType: 'error',
        };
      }
    }
  }

  /**
   * Generate Executor instructions and user feedback.
   *
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @param workerOutput - Executor's output from previous iteration (if any)
   * @param evaluation - Evaluation result from Evaluator
   * @returns Generated messages
   */
  async report(
    taskMdContent: string,
    iteration: number,
    workerOutput: string | undefined,
    evaluation: EvaluationResult
  ): Promise<AgentMessage[]> {
    const prompt = Reporter.buildReportPrompt(taskMdContent, iteration, workerOutput, evaluation);
    const messages: AgentMessage[] = [];

    // Collect all messages from queryStream
    for await (const msg of this.queryStream(prompt)) {
      messages.push(msg);
    }

    return messages;
  }

  /**
   * Build report prompt for Reporter.
   */
  static buildReportPrompt(
    taskMdContent: string,
    iteration: number,
    workerOutput: string | undefined,
    evaluation: EvaluationResult
  ): string {
    let prompt = `${taskMdContent}

---

## Current Iteration: ${iteration}

`;

    // Add Executor output if available
    const hasExecutorOutput = workerOutput && workerOutput.trim().length > 0;
    if (hasExecutorOutput) {
      prompt += `## Executor's Previous Output (Iteration ${iteration - 1})

\`\`\`
${workerOutput}
\`\`\`

---

`;
    } else {
      prompt += `## Executor's Previous Output

*No Executor output yet - this is the first iteration.*

---

`;
    }

    // Add evaluation result
    prompt += `## Evaluator's Assessment

\`\`\`json
{
  "is_complete": ${evaluation.is_complete},
  "reason": "${evaluation.reason}",
  "missing_items": ${JSON.stringify(evaluation.missing_items)},
  "confidence": ${evaluation.confidence}
}
\`\`\`

---

`;

    // Add report instructions
    if (!hasExecutorOutput) {
      prompt += `### Your Reporting Task

**⚠️ FIRST ITERATION - Executor has NOT executed yet**

**Evaluator determined: Task is NOT complete**
- Reason: ${evaluation.reason}
- Missing items: ${evaluation.missing_items.join(', ')}

**Your Job:**
1. Read Task.md Expected Results
2. Generate clear, actionable Executor instructions
3. Use send_user_feedback to send instructions to user

**What to include in Executor instructions:**
- Primary objective (what to do)
- Key requirements (constraints, success criteria)
- Reference materials (files to read, patterns to follow)
- Testing approach (if applicable)

**Instruction Style:**
- Be concise and specific
- Focus on WHAT to do, not HOW to do it
- Use clear language (avoid ambiguity)
- Organize with bullet points or numbered steps

**What NOT to do:**
❌ DO NOT evaluate if task is complete (Evaluator's job)
❌ DO NOT call task_done (Evaluator's job)
❌ DO NOT judge Executor's performance
✅ DO generate clear instructions for Executor
✅ DO use send_user_feedback to format output

**Remember**: You are the REPORTER.
You ONLY generate instructions and format output.
You do NOT evaluate completion (Evaluator does that).
`;
    } else {
      prompt += `### Your Reporting Task

**Evaluator determined: Task is ${evaluation.is_complete ? 'COMPLETE' : 'NOT COMPLETE'}**

**Evaluator's Reason:** ${evaluation.reason}

${!evaluation.is_complete ? `
**Missing Items:**
${evaluation.missing_items.map(item => `- ${item}`).join('\n')}

**Your Job:**
1. Generate specific Executor instructions to address missing items
2. Organize progress update for user
3. Use send_user_feedback to send formatted feedback

**What to include in Executor instructions:**
- What still needs to be done (from missing_items)
- Specific actions to take
- Expected outcomes
- Testing/validation steps

**What to include in user feedback:**
- What Executor accomplished in this iteration
- What still needs to be done
- Next steps

` : `
**Your Job:**
- Organize final summary of what was accomplished
- Use send_user_feedback to send completion message to user
- Highlight key achievements and outcomes

**What to include in completion message:**
- Summary of what was done
- Key changes made
- Testing results (if applicable)
- Next steps for user (if any)

**DO NOT:**
❌ Generate more Executor instructions (task is complete)
❌ Call task_done yourself (Evaluator will do that)

`}

**DO NOT:**
❌ Evaluate if task is complete (Evaluator already did)
❌ Call task_done (Evaluator will do that when ready)
❌ Judge Executor's work negatively

**DO:**
✅ Provide constructive guidance
✅ Acknowledge progress made
✅ Focus on next steps

**Remember**: You are the REPORTER.
You ONLY generate instructions and format feedback.
You do NOT evaluate completion (Evaluator does that).
`;
    }

    return prompt;
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    this.logger.debug('Reporter cleaned up');
    this.initialized = false;
  }
}
