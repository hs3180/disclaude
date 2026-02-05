/**
 * Manager Agent - Task evaluation and user communication agent.
 *
 * NEW Responsibilities (Flow 2):
 * - Receives output from Worker (what was done)
 * - Evaluates if the work meets requirements
 * - Plans next steps if incomplete
 * - Signals completion via send_complete tool
 * - Sends progress updates to user during loop
 *
 * NEW Dialogue Flow:
 * - Worker works FIRST on user request
 * - Worker output → Manager (you evaluate)
 * - Manager output → Worker (next instructions)
 * - Loop continues until Manager calls send_complete
 *
 * IMPORTANT: This agent uses send_user_feedback/send_user_card to communicate
 * with users. The chatId should be included in the task context.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import type { AgentMessage, SessionInfo } from '../types/agent.js';
import { feishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';
import { createLogger } from '../utils/logger.js';
import { loadSkill, type ParsedSkill } from './skill-loader.js';

// Re-export extractText for convenience
export { extractText } from '../utils/sdk.js';

/**
 * Manager agent configuration.
 */
export interface ManagerConfig {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
  permissionMode?: 'default' | 'bypassPermissions';
}

/**
 * Type for permission mode.
 */
type PermissionMode = 'default' | 'bypassPermissions';

/**
 * Manager agent for user-facing conversations.
 *
 * This agent relies entirely on skill files for behavior definition.
 * No fallback prompts are used - if the skill fails to load, an error is thrown.
 */
export class Manager {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl: string | undefined;
  readonly permissionMode: PermissionMode;
  private currentSessionId?: string;
  private customSystemPrompt?: string;
  private skill?: ParsedSkill;
  private initialized = false;
  private logger = createLogger('Manager', { model: '' });

  constructor(config: ManagerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissionMode = config.permissionMode ?? 'bypassPermissions';
    this.logger = createLogger('Manager', { model: this.model });
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
    const result = await loadSkill('manager');
    if (!result.success || !result.skill) {
      throw new Error(
        'Manager skill is required but failed to load. ' +
        `Error: ${result.error || 'Unknown error'}. ` +
        'Please ensure .claude/skills/manager/SKILL.md exists and is valid.'
      );
    }
    this.skill = result.skill;
    this.logger.debug({
      skillName: result.skill.name,
      toolCount: result.skill.allowedTools.length,
      contentLength: result.skill.content.length,
    }, 'Manager skill loaded');
  }

  /**
   * Set custom system prompt (e.g., Task.md content).
   * This will be prepended to the base system prompt.
   */
  setSystemPrompt(prompt: string): void {
    this.customSystemPrompt = prompt;
  }

  /**
   * Clear custom system prompt.
   */
  clearSystemPrompt(): void {
    this.customSystemPrompt = undefined;
  }

  /**
   * Create SDK options for manager agent.
   * Tool configuration comes from the skill file.
   */
  private createSdkOptions(resume?: string): Record<string, unknown> {
    // Tool configuration from skill file
    const allowedTools = this.skill?.allowedTools || [
      'WebSearch',             // For information lookup
      'send_user_feedback',    // Send text messages to user
      'send_user_card',        // Send rich interactive cards
      'send_complete',         // Signal task completion
      'send_file_to_feishu',   // Send files to user
    ];

    const sdkOptions: Record<string, unknown> = {
      cwd: Config.getWorkspaceDir(),
      permissionMode: this.permissionMode,
      settingSources: ['project'],
      // Register Feishu context tools as inline MCP server
      mcpServers: {
        'feishu-context': feishuSdkMcpServer,
      },
    };

    // Debug: Log tool configuration
    this.logger.debug({
      allowedTools,
      mcpServers: ['feishu-context'],
    }, 'Manager SDK tool configuration');

    // Set environment using unified helper
    sdkOptions.env = buildSdkEnv(this.apiKey, this.apiBaseUrl);

    // Set model
    if (this.model) {
      sdkOptions.model = this.model;
    }

    // Resume session
    if (resume) {
      sdkOptions.resume = resume;
    } else if (this.currentSessionId) {
      sdkOptions.resume = this.currentSessionId;
    }

    return sdkOptions;
  }

  /**
   * Build prompt with custom system prompt prepended.
   * Task.md content (customSystemPrompt) is added to the beginning of the user prompt.
   */
  private buildPromptWithCustomPrompt(userPrompt: string): string {
    if (!this.customSystemPrompt) {
      return userPrompt;
    }

    return `${this.customSystemPrompt}

---

${userPrompt}`;
  }

  /**
   * Stream agent response.
   */
  async *queryStream(prompt: string, sessionId?: string): AsyncIterable<AgentMessage> {
    // Ensure skill is loaded before processing
    if (!this.initialized) {
      await this.initialize();
    }

    this.logger.debug({ sessionId, promptLength: prompt.length }, 'Starting manager query');

    try {
      const sdkOptions = this.createSdkOptions(sessionId);

      this.logger.debug({
        customPromptSet: !!this.customSystemPrompt,
      }, 'Manager query config');

      // Build prompt with custom prompt prepended
      const fullPrompt = this.buildPromptWithCustomPrompt(prompt);

      const queryResult = query({
        prompt: fullPrompt,
        options: sdkOptions,
      });

      for await (const message of queryResult) {
        const parsed = parseSDKMessage(message);

        if (parsed.sessionId) {
          this.currentSessionId = parsed.sessionId;
        }

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
      this.logger.error({ err: error }, 'Manager query failed');
      yield {
        content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant',
        messageType: 'error',
      };
    }
  }

  /**
   * Get session info.
   */
  getSessionInfo(): SessionInfo {
    return {
      sessionId: this.currentSessionId,
      resume: this.currentSessionId,
    };
  }

  /**
   * Cleanup resources and clear session.
   *
   * Call this method when the agent is no longer needed to:
   * - Clear session ID to release SDK resources
   * - Clear custom system prompt
   * - Allow SDK to clean up MCP server instances associated with the session
   *
   * **Memory Management:**
   * - Session IDs are cleared, allowing SDK to release conversation context
   * - MCP server instances (feishu-context) are managed by the SDK lifecycle
   * - The feishuSdkMcpServer singleton is created once per process and reused
   * - SDK handles cleanup of per-query MCP server instances automatically
   *
   * Note: The feishuSdkMcpServer is a module-level singleton and intentionally
   * not cleaned up here. It persists for the lifetime of the process.
   */
  cleanup(): void {
    this.logger.debug({ sessionId: this.currentSessionId }, 'Cleaning up Manager agent');
    this.currentSessionId = undefined;
    this.customSystemPrompt = undefined;
  }
}
