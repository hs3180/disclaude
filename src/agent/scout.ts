/**
 * Planner Agent - Task initialization specialist.
 *
 * Responsibilities:
 * - Analyze user requests
 * - Create Task.md file with metadata
 *
 * This agent runs BEFORE the execution dialogue loop.
 * It focuses ONLY on creating the Task.md file that will be used
 * by the Worker and Manager agents.
 *
 * Key behaviors:
 * - Uses Write tool to create Task.md at the specified taskPath
 * - Task.md contains metadata (Task ID, Chat ID, User ID, timestamp)
 * - Task.md contains the original request
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import type { AgentMessage } from '../types/agent.js';
import { createLogger } from '../utils/logger.js';
import { loadSkill, type ParsedSkill } from './skill-loader.js';

// Re-export extractText for convenience
export { extractText } from '../utils/sdk.js';

/**
 * Planner agent configuration.
 */
export interface PlannerConfig {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
}

/**
 * Task context for planner agent.
 */
export interface TaskContext {
  chatId: string;
  userId?: string;
  messageId: string;
  taskPath: string;
  /** Conversation history (optional) */
  conversationHistory?: string;
}

/**
 * Planner agent for task initialization.
 *
 * This agent relies entirely on skill files for behavior definition.
 * No fallback prompts are used - if the skill fails to load, an error is thrown.
 */
export class Planner {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl: string | undefined;
  readonly workingDirectory: string;
  private taskContext?: TaskContext;
  private skill?: ParsedSkill;
  private initialized = false;
  private logger = createLogger('Planner', { model: '' });

  constructor(config: PlannerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.workingDirectory = Config.getWorkspaceDir();
    this.logger = createLogger('Planner', { model: this.model });
  }

  /**
   * Initialize agent by loading skill file.
   * Must be called before queryStream().
   */
  async initialize(): Promise<void> {
    if (this.initialized) {return;}
    await this.loadSkill();
    this.initialized = true;
  }

  /**
   * Set task context for Task.md creation.
   * Includes chatId, messageId, and taskPath.
   */
  setTaskContext(context: TaskContext): void {
    this.taskContext = context;
    this.logger.debug({ chatId: context.chatId, messageId: context.messageId, taskPath: context.taskPath }, 'Task context set');
  }

  /**
   * Load skill file for this agent.
   * Skill loading is required - throws error if it fails.
   */
  private async loadSkill(): Promise<void> {
    const result = await loadSkill('planner');
    if (!result.success || !result.skill) {
      throw new Error(
        'Planner skill is required but failed to load. ' +
        `Error: ${result.error || 'Unknown error'}. ` +
        'Please ensure .claude/skills/planner/SKILL.md exists and is valid.'
      );
    }
    this.skill = result.skill;
    this.logger.debug({
      skillName: result.skill.name,
      toolCount: result.skill.allowedTools.length,
      contentLength: result.skill.content.length,
    }, 'Planner skill loaded');
  }

  /**
   * Create SDK options for interaction agent.
   * Tool configuration comes from the skill file.
   */
  private createSdkOptions(): Record<string, unknown> {
    const allowedTools = this.skill?.allowedTools || ['Write', 'WebSearch'];

    this.logger.debug({
      hasSkill: !!this.skill,
      skillName: this.skill?.name,
      allowedTools,
      toolCount: allowedTools.length,
    }, 'Planner SDK options');

    const sdkOptions: Record<string, unknown> = {
      cwd: this.workingDirectory,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
      // Tool configuration from skill file
      allowedTools,
    };

    // Set environment using unified helper
    sdkOptions.env = buildSdkEnv(this.apiKey, this.apiBaseUrl);

    // Set model
    if (this.model) {
      sdkOptions.model = this.model;
    }

    return sdkOptions;
  }

  /**
   * Build prompt with context prepended.
   * Task context is added to the beginning of the user prompt.
   */
  private buildPromptWithContext(userPrompt: string): string {
    if (!this.taskContext) {
      return userPrompt;
    }

    let prompt = `## Task Context

- **Message ID**: ${this.taskContext.messageId}
- **Task Path**: ${this.taskContext.taskPath}
- **Chat ID**: ${this.taskContext.chatId}
${this.taskContext.userId ? `- **User ID**: ${this.taskContext.userId}` : ''}
`;

    prompt += `

---

## User Request

\`\`\`
${userPrompt}
\`\`\`

---

## Your Instruction

You are a **task initialization specialist**. Your workflow:

1. **Explore first** (for code-related tasks): Use Read, Glob, Grep to understand the codebase
2. **Create Task.md**: Use the Write tool to create a Task.md file at the exact taskPath

**CRITICAL - Task.md Format:**
Task.md must contain ONLY these sections:
- **Metadata header** (Task ID, Created, Chat ID, User ID)
- **Original Request** (preserved exactly)
- **Expected Results** (what Worker should produce)

**DO NOT add to Task.md:**
- ❌ Context Discovery
- ❌ Intent Analysis
- ❌ Completion Instructions
- ❌ Task Type field
- ❌ Any other sections

Use your exploration and analysis INTERNALLY to inform the Expected Results section, but do NOT write those sections to the file.

**Remember**: You are creating a task specification for Worker to execute, not answering directly.
`;

    return prompt;
  }

  /**
   * Stream agent response.
   */
  async *queryStream(prompt: string): AsyncIterable<AgentMessage> {
    // Ensure skill is loaded before processing
    if (!this.initialized) {
      await this.initialize();
    }

    this.logger.debug({ promptLength: prompt.length }, 'Starting planner query');

    try {
      const sdkOptions = this.createSdkOptions();

      this.logger.debug({
        hasTaskContext: !!this.taskContext,
        model: sdkOptions.model,
        allowedTools: (sdkOptions as { allowedTools?: string[] }).allowedTools,
        hasEnv: !!(sdkOptions as { env?: Record<string, unknown> }).env,
        baseUrl: (sdkOptions as { env?: Record<string, unknown> }).env?.ANTHROPIC_BASE_URL,
      }, 'Planner SDK query config');

      // Build prompt with context prepended
      const fullPrompt = this.buildPromptWithContext(prompt);

      const queryResult = query({
        prompt: fullPrompt,
        options: sdkOptions,
      });

      for await (const message of queryResult) {
        const parsed = parseSDKMessage(message);

        if (!parsed.content) {
          continue;
        }

        yield {
          content: parsed.content,
          role: 'assistant',
          messageType: parsed.type,
          metadata: parsed.metadata,
        };
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Planner query failed');
      yield {
        content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    }
  }

  /**
   * Cleanup resources.
   *
   * Call this method when the agent is no longer needed to:
   * - Clear task context
   */
  cleanup(): void {
    this.logger.debug('Cleaning up Planner agent');
    this.taskContext = undefined;
  }
}
