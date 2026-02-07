/**
 * Scout Agent - Task initialization specialist.
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
import { buildScoutPrompt, type TaskContext } from './prompt-builder.js';

// Re-export extractText for convenience
export { extractText } from '../utils/sdk.js';

/**
 * Scout agent configuration.
 */
export interface ScoutConfig {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
}

/**
 * Scout agent for task initialization.
 *
 * This agent relies entirely on skill files for behavior definition.
 * No fallback prompts are used - if the skill fails to load, an error is thrown.
 */
export class Scout {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl: string | undefined;
  readonly workingDirectory: string;
  private taskContext?: TaskContext;
  private skill?: ParsedSkill;
  private initialized = false;
  private logger = createLogger('Scout', { model: '' });

  constructor(config: ScoutConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.workingDirectory = Config.getWorkspaceDir();
    this.logger = createLogger('Scout', { model: this.model });
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
    const result = await loadSkill('scout');
    if (!result.success || !result.skill) {
      throw new Error(
        'Scout skill is required but failed to load. ' +
        `Error: ${result.error || 'Unknown error'}. ` +
        'Please ensure .claude/skills/scout/SKILL.md exists and is valid.'
      );
    }
    this.skill = result.skill;
    this.logger.debug({
      skillName: result.skill.name,
      toolCount: result.skill.allowedTools.length,
      contentLength: result.skill.content.length,
    }, 'Scout skill loaded');
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
    }, 'Scout SDK options');

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
   * Stream agent response.
   */
  async *queryStream(prompt: string): AsyncIterable<AgentMessage> {
    // Ensure skill is loaded before processing
    if (!this.initialized) {
      await this.initialize();
    }

    this.logger.debug({ promptLength: prompt.length }, 'Starting scout query');

    try {
      const sdkOptions = this.createSdkOptions();

      this.logger.debug({
        hasTaskContext: !!this.taskContext,
        model: sdkOptions.model,
        allowedTools: (sdkOptions as { allowedTools?: string[] }).allowedTools,
        hasEnv: !!(sdkOptions as { env?: Record<string, unknown> }).env,
        baseUrl: (sdkOptions as { env?: Record<string, unknown> }).env?.ANTHROPIC_BASE_URL,
      }, 'Scout SDK query config');

      // Build prompt with context prepended using prompt builder
      const skillContent = this.skill?.content;
      const fullPrompt = this.taskContext
        ? buildScoutPrompt(prompt, this.taskContext, skillContent)
        : prompt;

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
      this.logger.error({ err: error }, 'Scout query failed');
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
    this.logger.debug('Cleaning up Scout agent');
    this.taskContext = undefined;
  }
}
