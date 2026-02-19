/**
 * Evaluator - Task completion evaluation specialist.
 *
 * **Single Responsibility**: Evaluate if a task is complete and output evaluation.md.
 * When task is COMPLETE, also creates final_result.md to signal completion.
 *
 * **Output**:
 * - `evaluation.md` in the iteration directory (always)
 * - `final_result.md` in the task directory (when status=COMPLETE)
 *
 * **Tools Available**:
 * - Read, Grep, Glob: For reading task files and verifying completion
 * - Write: For creating evaluation.md and final_result.md
 *
 * **Tools NOT Available (intentionally restricted)**:
 * - send_user_feedback: Reporter's job, not Evaluator's
 *
 * **Completion Detection**:
 * - Evaluator creates final_result.md when it determines the task is COMPLETE
 * - The system detects completion by checking for final_result.md presence
 */

import { Config } from '../config/index.js';
import type { AgentMessage, AgentInput } from '../types/agent.js';
import { loadSkillOrThrow, type ParsedSkill } from '../task/skill-loader.js';
import { TaskFileManager } from '../task/file-manager.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';

/**
 * Evaluator-specific configuration.
 */
export interface EvaluatorConfig extends BaseAgentConfig {
  /** Optional subdirectory for task files (e.g., 'regular' for CLI tasks) */
  subdirectory?: string;
}

/**
 * Input type for Evaluator queries.
 */
export type EvaluatorInput = AgentInput;

/**
 * Evaluator - Task completion evaluation specialist.
 *
 * Simplified architecture:
 * - No JSON output - writes evaluation.md directly
 * - No structured result parsing
 * - File-driven workflow
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration
 * - GLM logging
 * - Error handling
 */
export class Evaluator extends BaseAgent {
  private skill?: ParsedSkill;
  private fileManager: TaskFileManager;

  constructor(config: EvaluatorConfig) {
    super(config);
    this.fileManager = new TaskFileManager(Config.getWorkspaceDir(), config.subdirectory);
  }

  protected getAgentName(): string {
    return 'Evaluator';
  }

  /**
   * Initialize the Evaluator agent.
   * Loads the evaluator skill which defines allowed tools.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load skill (required)
    this.skill = await loadSkillOrThrow('evaluator');
    this.logger.debug(
      {
        skillName: this.skill.name,
        toolCount: this.skill.allowedTools.length,
      },
      'Evaluator skill loaded'
    );

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

    // Skill is required, so allowedTools is always defined after initialize()
    if (!this.skill) {
      throw new Error('Evaluator skill not initialized - call initialize() first');
    }

    // Note: send_user_feedback, send_file_to_feishu are intentionally NOT included (Reporter's job)
    const sdkOptions = this.createSdkOptions({
      allowedTools: this.skill.allowedTools,
      // No MCP servers needed - Evaluator only uses file reading/writing tools
    });

    try {
      for await (const { parsed } of this.queryOnce(input, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'query');
    }
  }

  /**
   * Evaluate if the task is complete (streaming version).
   *
   * The Evaluator will create evaluation.md in the iteration directory.
   * No structured result is returned - callers should check the file.
   *
   * @param taskId - Task identifier
   * @param iteration - Current iteration number
   * @returns Async iterable of agent messages
   */
  async *evaluate(taskId: string, iteration: number): AsyncIterable<AgentMessage> {
    // Ensure iteration directory exists
    await this.fileManager.createIteration(taskId, iteration);

    // Build the prompt
    const prompt = this.buildEvaluationPrompt(taskId, iteration);

    this.logger.debug(
      {
        taskId,
        iteration,
      },
      'Starting evaluation'
    );

    // Stream messages from queryStream
    for await (const msg of this.queryStream(prompt)) {
      yield msg;
    }

    this.logger.debug(
      {
        taskId,
        iteration,
      },
      'Evaluation completed'
    );
  }

  /**
   * Build evaluation prompt for Evaluator.
   */
  private buildEvaluationPrompt(taskId: string, iteration: number): string {
    const taskMdPath = this.fileManager.getTaskSpecPath(taskId);
    const evaluationPath = this.fileManager.getEvaluationPath(taskId, iteration);

    let previousExecutionPath: string | null = null;
    if (iteration > 1) {
      previousExecutionPath = this.fileManager.getExecutionPath(taskId, iteration - 1);
    }

    let prompt = `# Evaluator Task

## Context
- Task ID: ${taskId}
- Iteration: ${iteration}

## Your Job

1. Read the task specification:
   \`${taskMdPath}\`
`;

    if (previousExecutionPath) {
      prompt += `
2. Read the previous execution output:
   \`${previousExecutionPath}\`
`;
    } else {
      prompt += `
2. This is the first iteration - no previous execution exists.
`;
    }

    prompt += `
3. Evaluate if the task is complete based on Expected Results

4. Write your evaluation to:
   \`${evaluationPath}\`

## Output Format for evaluation.md

\`\`\`markdown
# Evaluation: Iteration ${iteration}

## Status
[COMPLETE | NEED_EXECUTE]

## Assessment
(Your evaluation reasoning)

## Next Actions (only if NEED_EXECUTE)
- Action 1
- Action 2
\`\`\`

## Status Rules

### COMPLETE
When ALL conditions are met:
- ✅ All Expected Results satisfied
- ✅ Code actually modified (not just explained)
- ✅ Build passed (if required)
- ✅ Tests passed (if required)

### NEED_EXECUTE
When ANY condition is true:
- ❌ First iteration (no previous execution)
- ❌ Executor only explained (no code changes)
- ❌ Build failed or tests failed
- ❌ Expected Results not fully satisfied

## Important Notes

- Write the evaluation file to \`${evaluationPath}\`
- Do NOT output JSON - write markdown directly
- **When status=COMPLETE**: You MUST also create \`final_result.md\` to signal task completion

**If status is COMPLETE, also create final_result.md:**

Create this file: \`${this.fileManager.getFinalResultPath(taskId)}\`

\`\`\`markdown
# Final Result

Task completed successfully.

## Summary
(Brief summary of what was accomplished)

## Deliverables
- Deliverable 1
- Deliverable 2
\`\`\`

**Now start your evaluation.**`;

    return prompt;
  }
}
