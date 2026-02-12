/**
 * Scout Agent - Task initialization specialist.
 *
 * Responsibilities:
 * - Analyze user requests
 * - Create Task.md file with metadata
 *
 * This agent runs BEFORE the execution dialogue loop.
 * It focuses ONLY on creating the Task.md file that will be used
 * by the Executor and Evaluator agents.
 *
 * Key behaviors:
 * - Uses Write tool to create Task.md at the specified taskPath
 * - Task.md contains metadata (Task ID, Chat ID, User ID, timestamp)
 * - Task.md contains the original request
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import type { AgentMessage } from '../types/agent.js';
import { createLogger } from '../utils/logger.js';
import { buildScoutPrompt, type TaskContext } from '../task/prompt-builder.js';
import { TaskFileManager } from '../task/file-manager.js';
import { ALLOWED_TOOLS } from '../config/tool-configuration.js';
import { AgentExecutionError, formatError } from '../utils/errors.js';

// Re-export extractText for convenience
export { extractText } from '../utils/sdk.js';

/**
 * Scout agent configuration.
 */
export interface ScoutConfig {
  /**
   * Name of the skill to use.
   * Defaults to 'scout' if not provided.
   * The skill file should be available in workspace/.claude/skills/{skillName}/
   */
  skillName?: string;
}

/**
 * Scout agent for task initialization.
 *
 * This agent uses SDK's built-in skill loading via settingSources: ['project'].
 * Skills are copied to workspace/.claude/skills during service startup.
 *
 * The agent activates the skill using a command prefix in the prompt.
 */
export class Scout {
  readonly workingDirectory: string;
  readonly skillName: string;
  private readonly provider: 'anthropic' | 'glm';
  private taskContext?: TaskContext;
  private logger: ReturnType<typeof createLogger>;
  private fileManager: TaskFileManager;

  constructor(config: ScoutConfig) {
    this.skillName = config.skillName || 'scout';
    this.workingDirectory = Config.getWorkspaceDir();
    // Get model from Config for logger initialization
    const agentConfig = Config.getAgentConfig();
    this.provider = agentConfig.provider;
    this.logger = createLogger('Scout', { model: agentConfig.model });
    this.fileManager = new TaskFileManager(this.workingDirectory);
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
   * Create SDK options for interaction agent.
   * Uses settingSources: ['project'] to load skills from workspace/.claude/skills
   */
  private createSdkOptions(): Record<string, unknown> {
    // Get agent configuration from Config (delayed loading)
    const agentConfig = Config.getAgentConfig();

    this.logger.debug({
      skillName: this.skillName,
      workingDirectory: this.workingDirectory,
      provider: agentConfig.provider,
      model: agentConfig.model,
    }, 'Scout SDK options');

    return {
      cwd: this.workingDirectory,
      permissionMode: 'bypassPermissions',
      // Load skills from workspace/.claude/skills via settingSources
      settingSources: ['project'],
      // Use default tool configuration
      allowedTools: ALLOWED_TOOLS,
      // Set model
      model: agentConfig.model,
      // Set environment using unified helper
      env: buildSdkEnv(agentConfig.apiKey, agentConfig.apiBaseUrl),
    };
  }

  /**
   * Stream agent response.
   */
  async *queryStream(prompt: string): AsyncIterable<AgentMessage> {
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

      // Build prompt with skill activation command and context
      const fullPrompt = this.buildFullPrompt(prompt);

      this.logger.debug({
        fullPrompt: fullPrompt.substring(0, 500),
        promptLength: fullPrompt.length,
      }, 'Scout full prompt with skill activation');

      const queryResult = query({
        prompt: fullPrompt,
        options: sdkOptions,
      });
      const iterator = queryResult[Symbol.asyncIterator]();

      while (true) {
        // No timeout - let GLM-5 deep thinking complete naturally
        const result = await iterator.next() as IteratorResult<unknown>;

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

        if (!parsed.content) {
          continue;
        }

        // ✨ NEW: Write task.md via TaskFileManager when Write tool is used
        if (parsed.metadata?.toolName === 'Write' && this.taskContext?.messageId) {
          try {
            // Extract file content from metadata
            const toolInput = parsed.metadata.toolInput as { filePath?: string; content?: string } | undefined;
            if (toolInput?.content && typeof toolInput.content === 'string') {
              await this.fileManager.initializeTask(this.taskContext.messageId);
              await this.fileManager.writeTaskSpec(this.taskContext.messageId, toolInput.content);
              this.logger.debug({ taskId: this.taskContext.messageId }, 'Task spec written via TaskFileManager');
            }
          } catch (error) {
            this.logger.error({ err: error }, 'Failed to write task spec via TaskFileManager');
          }
        }

        yield {
          content: parsed.content,
          role: 'assistant',
          messageType: parsed.type,
          metadata: parsed.metadata,
        };
      }
    } catch (error) {
      const agentError = new AgentExecutionError(
        'Scout query failed',
        {
          cause: error instanceof Error ? error : new Error(String(error)),
          agent: 'Scout',
          recoverable: true,
        }
      );
      this.logger.error({ err: formatError(agentError) }, 'Scout query failed');
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

  /**
   * Build full prompt with skill activation command and task context.
   *
   * The prompt structure is:
   * 1. Skill activation command (uses SDK's Skill tool)
   * 2. Task context (if available)
   * 3. Original user prompt
   *
   * @param userPrompt - Original user prompt
   * @returns Full prompt with skill activation and context
   */
  private buildFullPrompt(userPrompt: string): string {
    const parts: string[] = [];

    // 1. Skill activation command - tells SDK to load and use the skill
    parts.push(`/skill:${this.skillName}`);

    // 2. Task context (if available)
    if (this.taskContext) {
      const contextPrompt = buildScoutPrompt(userPrompt, this.taskContext);
      parts.push(contextPrompt);
    } else {
      // 3. Original prompt (if no context)
      parts.push(userPrompt);
    }

    return parts.join('\n\n');
  }
}
