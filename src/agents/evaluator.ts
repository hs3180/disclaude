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
 * - task_done: Signal task completion (ONLY when truly complete)
 *
 * **Tools NOT Available (intentionally restricted):**
 * - send_user_feedback: Reporter's job, not Evaluator's
 *
 * **Decision Logic:**
 * 1. Read Task.md Expected Results
 * 2. Read Worker output (if any)
 * 3. Check completion criteria:
 *    - First iteration? → Cannot be complete (no Worker execution yet)
 *    - Code modification required? → Worker must modify files
 *    - Testing required? → Worker must run tests
 * 4. Decision:
 *    - IF complete → Call task_done tool
 *    - IF not complete → Return JSON with evaluation result
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

import { query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { EVALUATOR } from '../config/constants.js';
import { Config } from '../config/index.js';
import type { AgentMessage, AgentInput } from '../types/agent.js';
import { createLogger } from '../utils/logger.js';
import { loadSkillOrThrow, type ParsedSkill } from '../task/skill-loader.js';
import { TaskFileManager } from '../task/file-manager.js';

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

  private readonly logger = createLogger('Evaluator');

  constructor(config: EvaluatorConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissionMode = config.permissionMode || 'bypassPermissions';
    this.fileManager = new TaskFileManager(Config.getWorkspaceDir(), config.subdirectory);
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
   * Inline tool: Signal task completion.
   *
   * This tool is called by the Evaluator agent when it determines the task is complete.
   * The completion signal is detected by the dialogue bridge to end the iteration loop.
   *
   * @param params - Tool parameters
   * @returns Tool result
   */
  private taskDoneTool = tool(
    'task_done',
    'Signal that the task is done and end the dialogue loop. Use send_user_feedback BEFORE calling this to provide a final message to the user.',
    {
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
      taskId: z.string().optional().describe('Optional task ID for tracking'),
    },
    // eslint-disable-next-line require-await
    async ({ chatId, taskId }) => {
      this.logger.info({
        chatId,
        taskId,
      }, 'Task completion signaled (task_done called)');

      return {
        content: [{ type: 'text' as const, text: 'Task completed.' }],
      };
    }
  );

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
    // Note: send_user_feedback and send_file_to_feishu are intentionally NOT included (Reporter's job)

    const sdkOptions: Record<string, unknown> = {
      cwd: Config.getWorkspaceDir(),
      permissionMode: this.permissionMode,
      allowedTools,
      settingSources: ['project'],
      // No MCP servers needed - Evaluator only uses inline tools
      // Add inline tools
      tools: [this.taskDoneTool],
    };

    // Set environment
    sdkOptions.env = buildSdkEnv(this.apiKey, this.apiBaseUrl);

    // Set model
    if (this.model) {
      sdkOptions.model = this.model;
    }

    try {
      // Query SDK
      for await (const message of query({ prompt: input, options: sdkOptions as any })) {
        const parsed = parseSDKMessage(message);

        // Yield formatted message
        yield {
          content: parsed.content,
          role: 'assistant',
          messageType: parsed.type,
          metadata: parsed.metadata,
        };
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Evaluator query failed');
      yield {
        content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    }
  }

  /**
   * Evaluate if the task is complete.
   *
   * @param taskMdContent - Full Task.md content
   * @param iteration - Current iteration number
   * @param workerOutput - Worker's output from previous iteration (if any)
   * @returns Evaluation result
   */
  async evaluate(
    taskMdContent: string,
    iteration: number,
    workerOutput?: string,
    taskId?: string
  ): Promise<{
    result: EvaluationResult;
    messages: AgentMessage[];
  }> {
    const prompt = Evaluator.buildEvaluationPrompt(taskMdContent, iteration, workerOutput);
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
   */
  static parseEvaluationResult(messages: AgentMessage[], iteration: number): EvaluationResult {
    // Try to extract JSON from messages
    for (const msg of messages) {
      if (msg.messageType === 'tool_use' && msg.metadata?.toolName === 'task_done') {
        // Evaluator called task_done, so task is complete
        return {
          is_complete: true,
          reason: 'Evaluator called task_done',
          missing_items: [],
          confidence: 1.0,
        };
      }

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
        reason: 'First iteration - Worker has not executed yet',
        missing_items: ['Worker execution', 'Code modification'],
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
    workerOutput?: string
  ): string {
    let prompt = `${taskMdContent}

---

## Current Iteration: ${iteration}

`;

    // Add Worker output if available
    const hasWorkerOutput = workerOutput && workerOutput.trim().length > 0;
    if (hasWorkerOutput) {
      const preparedWorkerOutput = Evaluator.prepareWorkerOutputForEvaluation(workerOutput!);
      prompt += `## Worker's Previous Output (Iteration ${iteration - 1})

${preparedWorkerOutput}

---

`;
    } else {
      prompt += `## Worker's Previous Output

*No Worker output yet - this is the first iteration.*

---

`;
    }

    // Add evaluation instructions
    if (!hasWorkerOutput) {
      prompt += `### Your Evaluation Task

**⚠️⚠️⚠️ CRITICAL: FIRST ITERATION ⚠️⚠️⚠️**

**You MUST return:**
\`\`\`json
{
  "is_complete": false,
  "reason": "This is the first iteration. Worker has not executed yet.",
  "missing_items": ["Worker execution", "Code modification", "Testing"],
  "confidence": 1.0
}
\`\`\`

**Why CANNOT be complete on first iteration:**
- ❌ Worker has NOT executed yet
- ❌ NO code has been modified
- ❌ NO tests have been run
- ❌ Expected Results require implementation, not just planning

**Your ONLY job:**
✅ Evaluate the task completion status
✅ Return structured JSON result
❌ DO NOT generate instructions for Worker
❌ DO NOT format user-facing messages
❌ DO NOT call task_done on first iteration

**Remember**: You are the EVALUATOR, not the REPORTER.
You ONLY judge completion, you do NOT generate instructions.
`;
    } else {
      prompt += `### Your Evaluation Task

**🔍 EVALUATION CHECKLIST:**

Check if Worker satisfied ALL Expected Results from Task.md:

**For tasks requiring CODE CHANGES:**
□ Worker actually modified the code files (not just read them)
□ Build succeeded (if required)
□ Tests passed (if required)
□ All Expected Results satisfied

**DO NOT mark complete if:**
❌ Worker only explained what to do
❌ Worker only created a plan
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
   * Prepare worker output for evaluator prompt with bounded size.
   *
   * For large outputs, keep high-signal lines and the latest tail window.
   * This keeps completion evidence while reducing token growth across iterations.
   */
  private static prepareWorkerOutputForEvaluation(workerOutput: string): string {
    const maxChars = EVALUATOR.MAX_WORKER_OUTPUT_CHARS;
    const tailChars = EVALUATOR.WORKER_OUTPUT_TAIL_CHARS;
    const maxSignalLines = EVALUATOR.MAX_SIGNAL_LINES;

    if (workerOutput.length <= maxChars) {
      return `\`\`\`\n${workerOutput}\n\`\`\``;
    }

    const signalPatterns: RegExp[] = [
      /expected results?/i,
      /verification/i,
      /\btest(s|ing)?\b/i,
      /\bbuild\b/i,
      /\berror\b/i,
      /\bfailed\b/i,
      /\bsuccess\b/i,
      /\bcreated\b/i,
      /\bmodified\b/i,
      /\bedit(ed|ing)?\b/i,
      /\bwrite\b/i,
      /\bsummary\b/i,
      /✅|❌|⚠️/,
    ];

    const signalLines: string[] = [];
    const seen = new Set<string>();
    for (const line of workerOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (!signalPatterns.some((pattern) => pattern.test(trimmed))) {
        continue;
      }
      if (seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      signalLines.push(trimmed);
      if (signalLines.length >= maxSignalLines) {
        break;
      }
    }

    const tail = workerOutput.slice(-tailChars);
    const signalBlock = signalLines.length > 0
      ? signalLines.map((line, index) => `${index + 1}. ${line}`).join('\n')
      : '(No high-signal lines extracted)';

    return [
      '> Worker output was truncated for evaluation to control token usage.',
      `> Original length: ${workerOutput.length} chars`,
      '',
      '### Extracted Signals',
      signalBlock,
      '',
      `### Tail Window (last ${tailChars} chars)`,
      '```',
      tail,
      '```',
    ].join('\n');
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    this.logger.debug('Evaluator cleaned up');
    this.initialized = false;
  }
}
