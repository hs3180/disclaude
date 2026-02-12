/**
 * Evaluator - Task completion evaluation specialist.
 *
 * **Single Responsibility**: Evaluate if a task is complete.
 *
 * **Key Differences from Manager:**
 * - Manager: Evaluates AND generates instructions AND formats output
 * - Evaluator: ONLY evaluates, does NOT generate instructions
 *
 * **Tools Available:**
 * - Read, Grep, Glob: For reading task files and verifying completion
 *
 * **Tools NOT Available (intentionally restricted):**
 * - send_user_feedback: Reporter's job, not Evaluator's
 * - task_done: No longer needed - completion detected via final_result.md
 *
 * **Simplified Decision Logic:**
 * 1. Read Task.md Expected Results
 * 2. Read Executor output (if any)
 * 3. Check completion criteria:
 *    - First iteration? → Cannot be complete (no Executor execution yet)
 *    - Code modification required? → Executor must modify files
 *    - Testing required? → Executor must run tests
 * 4. Decision:
 *    - IF complete → Return JSON with is_complete: true AND write evaluation.md
 *    - IF not complete → Return JSON with is_complete: false
 *
 * **Completion Detection:**
 * - Task completion is determined by the presence of final_result.md (created by Executor)
 * - Evaluator's evaluation.md is used for tracking evaluation history
 * - No explicit task_done tool call needed
 *
 * **Output Format:**
 * Evaluator returns structured JSON (not user-facing text):
 * {
 *   "is_complete": boolean,
 *   "reason": string,
 *   "missing_items": string[],
 *   "confidence": number
 * }
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import type { AgentMessage, AgentInput } from '../types/agent.js';
import { createLogger } from '../utils/logger.js';
import { loadSkillOrThrow, type ParsedSkill } from '../task/skill-loader.js';
import { TaskFileManager } from '../task/file-manager.js';
import { AgentExecutionError, TimeoutError, formatError } from '../utils/errors.js';

const logger = createLogger('Evaluator');

/**
 * Input type for Evaluator queries.
 */
export type EvaluatorInput = AgentInput;

/**
 * Evaluator agent configuration.
 */
export interface EvaluatorConfig {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
  permissionMode?: 'default' | 'bypassPermissions';
  /** Optional subdirectory for task files (e.g., 'regular' for CLI tasks) */
  subdirectory?: string;
}

/**
 * Type for permission mode.
 */
export type EvaluatorPermissionMode = 'default' | 'bypassPermissions';

/**
 * Evaluation result from Evaluator.
 */
export interface EvaluationResult {
  /** Whether the task is complete */
  is_complete: boolean;
  /** Reason for the decision */
  reason: string;
  /** Missing items that prevent completion (if any) */
  missing_items: string[];
  /** Confidence in the decision (0-1) */
  confidence: number;
}

/**
 * Evaluator - Task completion evaluation specialist.
 */
export class Evaluator {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl?: string;
  readonly permissionMode: EvaluatorPermissionMode;
  protected skill?: ParsedSkill;
  protected initialized = false;
  private fileManager: TaskFileManager;
  private readonly provider: 'anthropic' | 'glm';

  private readonly logger = createLogger('Evaluator');

  constructor(config: EvaluatorConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissionMode = config.permissionMode || 'bypassPermissions';
    this.fileManager = new TaskFileManager(Config.getWorkspaceDir(), config.subdirectory);

    // Detect provider from API base URL
    const agentConfig = Config.getAgentConfig();
    this.provider = agentConfig.provider;
  }

  /**
   * Initialize the Evaluator agent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load skill (required)
    this.skill = await loadSkillOrThrow('evaluator');
    this.logger.debug({
      skillName: this.skill.name,
      toolCount: this.skill.allowedTools.length,
    }, 'Evaluator skill loaded');

    this.initialized = true;
    this.logger.debug('Evaluator initialized');
  }

  /**
   * Query the Evaluator agent with streaming response.
   *
   * @param input - Prompt or message array
   * @returns Async iterable of agent messages
   */
  async *queryStream(input: EvaluatorInput): AsyncIterable<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Create SDK options for Evaluator
    // Skill is required, so allowedTools is always defined
    const allowedTools = this.skill!.allowedTools;
    // Note: send_user_feedback, send_file_to_feishu are intentionally NOT included (Reporter's job)
    // Note: task_done tool removed - completion detected via final_result.md instead

    const sdkOptions: Record<string, unknown> = {
      cwd: Config.getWorkspaceDir(),
      permissionMode: this.permissionMode,
      allowedTools,
      settingSources: ['project'],
      // No MCP servers needed - Evaluator only uses file reading tools
      // No inline tools needed - task_done removed
    };

    // Set environment
    sdkOptions.env = buildSdkEnv(this.apiKey, this.apiBaseUrl);

    // Set model
    if (this.model) {
      sdkOptions.model = this.model;
    }

    const ITERATOR_TIMEOUT_MS = 30000; // 30 seconds timeout for iterator

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
          'Evaluator query timeout - unable to complete evaluation',
          ITERATOR_TIMEOUT_MS,
          'queryStream'
        );
        this.logger.warn({ err: formatError(timeoutError) }, 'Iterator timeout - returning partial results');
        yield {
          content: '⚠️ Query timeout - unable to complete evaluation',
          role: 'assistant',
          messageType: 'error',
        };
      } else {
        const agentError = new AgentExecutionError(
          'Evaluator query failed',
          {
            cause: error instanceof Error ? error : new Error(String(error)),
            agent: 'Evaluator',
            recoverable: true,
          }
        );
        this.logger.error({ err: formatError(agentError) }, 'Evaluator query failed');
        yield {
          content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          role: 'assistant',
          messageType: 'error',
        };
      }
    }
  }

  /**
   * Evaluate if the task is complete.
   *
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @param executorOutput - Executor's output from previous iteration (if any)
   * @returns Evaluation result
   */
  async evaluate(
    taskMdContent: string,
    iteration: number,
    executorOutput?: string,
    taskId?: string
  ): Promise<{
    result: EvaluationResult;
    messages: AgentMessage[];
  }> {
    const prompt = Evaluator.buildEvaluationPrompt(taskMdContent, iteration, executorOutput);
    const messages: AgentMessage[] = [];

    // Collect all messages from queryStream
    for await (const msg of this.queryStream(prompt)) {
      messages.push(msg);
    }

    // Parse evaluation result from messages
    const result = Evaluator.parseEvaluationResult(messages, iteration);

    // ✨ NEW: Write evaluation.md via TaskFileManager
    if (taskId) {
      try {
        await this.fileManager.createIteration(taskId, iteration);
        const evalContent = this.formatEvaluationMarkdown(result, iteration);
        await this.fileManager.writeEvaluation(taskId, iteration, evalContent);
        this.logger.debug({ taskId, iteration }, 'Evaluation written via TaskFileManager');
      } catch (error) {
        this.logger.error({ err: error, taskId, iteration }, 'Failed to write evaluation via TaskFileManager');
      }
    }

    return {
      result,
      messages,
    };
  }

  /**
   * Format evaluation result as markdown.
   */
  private formatEvaluationMarkdown(result: EvaluationResult, iteration: number): string {
    const timestamp = new Date().toISOString();

    return `# Evaluation: Iteration ${iteration}

**Timestamp**: ${timestamp}
**Iteration**: ${iteration}

## Completion Status

**Is Complete**: ${result.is_complete}
**Confidence**: ${result.confidence.toFixed(2)}

## Assessment

${result.reason}

## Missing Items

${result.missing_items.length > 0 ? result.missing_items.map(item => `- [ ] ${item}`).join('\n') : '(None - task is complete)'}

## Recommendations

${result.is_complete ? 'Task is complete. No further action needed.' : 'Task requires additional work. See missing items above.'}
`;
  }

  /**
   * Parse evaluation result from messages.
   *
   * Static method to allow external use (e.g., by IterationBridge).
   *
   * NOTE: task_done tool detection removed - completion is now determined
   * by the presence of final_result.md in the task directory.
   */
  static parseEvaluationResult(messages: AgentMessage[], iteration: number): EvaluationResult {
    // Try to extract JSON from messages
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        // Try to extract JSON from content
        const jsonMatch = msg.content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            return {
              is_complete: parsed.is_complete || false,
              reason: parsed.reason || 'No reason provided',
              missing_items: parsed.missing_items || [],
              confidence: parsed.confidence || 0.5,
            };
          } catch (e) {
            logger.warn({ err: e }, 'Failed to parse evaluation JSON');
          }
        }
      }
    }

    // Fallback: if first iteration, assume not complete
    if (iteration === 1) {
      return {
        is_complete: false,
        reason: 'First iteration - Executor has not executed yet',
        missing_items: ['Executor execution', 'Code modification'],
        confidence: 1.0,
      };
    }

    // Default: assume not complete
    return {
      is_complete: false,
      reason: 'Unable to determine completion status',
      missing_items: ['Unknown'],
      confidence: 0.0,
    };
  }

  /**
   * Build evaluation prompt for Evaluator.
   */
  static buildEvaluationPrompt(
    taskMdContent: string,
    iteration: number,
    executorOutput?: string
  ): string {
    let prompt = `${taskMdContent}

---

## Current Iteration: ${iteration}

`;

    // Add Executor output if available
    const hasExecutorOutput = executorOutput && executorOutput.trim().length > 0;
    if (hasExecutorOutput) {
      prompt += `## Executor's Previous Output (Iteration ${iteration - 1})

\`\`\`
${executorOutput}
\`\`\`

---

`;
    } else {
      prompt += `## Executor's Previous Output

*No Executor output yet - this is the first iteration.*

---

`;
    }

    // Add evaluation instructions
    if (!hasExecutorOutput) {
      prompt += `### Your Evaluation Task

**⚠️⚠️⚠️ CRITICAL: FIRST ITERATION ⚠️⚠️⚠️**

**You MUST return:**
\`\`\`json
{
  "is_complete": false,
  "reason": "This is the first iteration. Executor has not executed yet.",
  "missing_items": ["Executor execution", "Code modification", "Testing"],
  "confidence": 1.0
}
\`\`\`

**Why CANNOT be complete on first iteration:**
- ❌ Executor has NOT executed yet
- ❌ NO code has been modified
- ❌ NO tests have been run
- ❌ Expected Results require implementation, not just planning

**Your ONLY job:**
✅ Evaluate the task completion status
✅ Return structured JSON result
❌ DO NOT generate instructions for Executor
❌ DO NOT format user-facing messages
❌ DO NOT call task_done on first iteration

**Remember**: You are the EVALUATOR, not the REPORTER.
You ONLY judge completion, you do NOT generate instructions.
`;
    } else {
      prompt += `### Your Evaluation Task

**🔍 EVALUATION CHECKLIST:**

Check if Executor satisfied ALL Expected Results from Task.md:

**For tasks requiring CODE CHANGES:**
□ Executor actually modified the code files (not just read them)
□ Build succeeded (if required)
□ Tests passed (if required)
□ All Expected Results satisfied

**DO NOT mark complete if:**
❌ Executor only explained what to do
❌ Executor only created a plan
❌ Build failed or tests failed
❌ Expected Results not satisfied

**Your Output Format:**

\`\`\`json
{
  "is_complete": true/false,
  "reason": "Explanation of your decision",
  "missing_items": ["item1", "item2"],
  "confidence": 0.0-1.0
}
\`\`\`

**IF complete:**
- Call the task_done tool
- Then STOP

**IF NOT complete:**
- Return JSON with is_complete: false
- List missing items
- DO NOT call task_done
- DO NOT generate instructions (Reporter will do that)

**Remember**: You are the EVALUATOR.
You ONLY evaluate, you do NOT generate instructions.
`;
    }

    return prompt;
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    this.logger.debug('Evaluator cleaned up');
    this.initialized = false;
  }
}
