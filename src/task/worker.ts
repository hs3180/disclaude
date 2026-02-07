/**
 * Worker Agent - Task execution specialist.
 *
 * NEW Responsibilities (Flow 2):
 * - Receives user requests FIRST (from Task.md)
 * - Executes tasks with full tool access
 * - Returns results to Manager for evaluation
 *
 * This agent has FULL tools - focused on getting work done.
 * It works in an isolated context, separate from user chat.
 *
 * IMPORTANT: This agent does NOT send messages to users directly.
 * The Manager agent handles all user communication.
 *
 * NEW Dialogue Flow:
 * - User request from Task.md → this agent FIRST
 * - This agent's output → Manager (evaluation)
 * - Manager's next instructions → this agent
 * - Loop continues until Manager signals completion
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import type { AgentMessage } from '../types/agent.js';
import { createLogger } from '../utils/logger.js';
import { loadSkill, getSkillMcpServers, type ParsedSkill } from './skill-loader.js';
import { buildWorkerPrompt, type WorkerTaskContext } from './prompt-builder.js';

// Re-export extractText for convenience
export { extractText } from '../utils/sdk.js';

/**
 * Worker agent configuration.
 */
export interface WorkerConfig {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
}

/**
 * Worker agent for task execution.
 *
 * This agent relies entirely on skill files for behavior definition.
 * No fallback prompts are used - if the skill fails to load, an error is thrown.
 */
export class Worker {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl: string | undefined;
  readonly workingDirectory: string;
  private skill?: ParsedSkill;
  private initialized = false;
  private logger = createLogger('Worker', { model: '' });

  constructor(config: WorkerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.workingDirectory = Config.getWorkspaceDir();
    this.logger = createLogger('Worker', { model: this.model });
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
   * Load skill file for this agent.
   * Skill loading is required - throws error if it fails.
   */
  private async loadSkill(): Promise<void> {
    const result = await loadSkill('worker');
    if (!result.success || !result.skill) {
      throw new Error(
        'Worker skill is required but failed to load. ' +
        `Error: ${result.error || 'Unknown error'}. ` +
        'Please ensure .claude/skills/worker/SKILL.md exists and is valid.'
      );
    }
    this.skill = result.skill;
    this.logger.debug({
      skillName: result.skill.name,
      toolCount: result.skill.allowedTools.length,
      contentLength: result.skill.content.length,
    }, 'Worker skill loaded');
  }

  /**
   * Create SDK options for worker agent.
   * Tool configuration comes from the skill file.
   */
  private createSdkOptions(): Record<string, unknown> {
    // Tool configuration from skill file
    const allowedTools = this.skill?.allowedTools || [
      'Skill',
      'WebSearch',
      'Task',
      // File operations
      'Read',
      'Write',
      'Edit',
      // Search
      'Glob',
      'Grep',
      // Execution
      'Bash',
      'LSP',
      // Browser automation
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_snapshot',
      'mcp__playwright__browser_run_code',
      'mcp__playwright__browser_close',
      'mcp__playwright__browser_type',
      'mcp__playwright__browser_press_key',
      'mcp__playwright__browser_hover',
      'mcp__playwright__browser_tabs',
      'mcp__playwright__browser_take_screenshot',
      'mcp__playwright__browser_wait_for',
      'mcp__playwright__browser_evaluate',
      'mcp__playwright__browser_fill_form',
      'mcp__playwright__browser_select_option',
      'mcp__playwright__browser_drag',
      'mcp__playwright__browser_handle_dialog',
      'mcp__playwright__browser_network_requests',
      'mcp__playwright__browser_console_messages',
      'mcp__playwright__browser_install',
    ];

    // MCP server configuration
    const mcpServers = getSkillMcpServers('worker') || {
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest'],
      },
    };

    const sdkOptions: Record<string, unknown> = {
      cwd: this.workingDirectory,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
      allowedTools,
      mcpServers,
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

    this.logger.debug({ promptLength: prompt.length }, 'Starting worker query');

    try {
      const sdkOptions = this.createSdkOptions();

      const queryResult = query({
        prompt,
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
      this.logger.error({ err: error }, 'Worker query failed');
      yield {
        content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    }
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    this.logger.debug('Cleaning up Worker agent');
  }

  /**
   * Build Worker prompt with concise task context.
   *
   * NEW: Uses prompt builder to inject important context (chatId, messageId, etc.)
   * instead of passing the full Task.md content. This reduces verbosity and
   * focuses Worker on the immediate task.
   *
   * @param userPrompt - User's original request
   * @param managerInstruction - Manager's instruction for this iteration
   * @param chatId - Chat ID for context
   * @param messageId - Message ID for context
   * @param taskPath - Task path for context
   * @param skillContent - Optional skill file content for template extraction
   * @returns Formatted prompt string
   */
  static buildPrompt(
    userPrompt: string,
    managerInstruction: string,
    chatId: string,
    messageId: string,
    taskPath: string,
    skillContent?: string
  ): string {
    const workerContext: WorkerTaskContext = {
      chatId,
      messageId,
      taskPath,
      userPrompt,
      managerInstruction,
    };

    return buildWorkerPrompt(workerContext, skillContent);
  }
}
