/**
 * Claude Agent SDK client wrapper.
 * Uses the official @anthropic-ai/claude-agent-sdk for full tool support.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, getNodeBinDir } from '../utils/sdk.js';
import { Config } from '../config/index.js';
import type {
  AgentMessage,
  AgentOptions,
  SessionInfo,
} from '../types/agent.js';
import { createLogger } from '../utils/logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';

/**
 * Agent SDK client with full tool support.
 */
export class AgentClient {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl: string | undefined;
  readonly permissionMode: AgentOptions['permissionMode'];
  readonly bypassPermissions: boolean | undefined;

  // Session tracking for conversation continuity
  private currentSessionId?: string;
  private logger = createLogger('AgentClient', { model: '' }); // Model set in constructor

  constructor(options: AgentOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.apiBaseUrl = options.apiBaseUrl;
    this.permissionMode = options.permissionMode;
    this.bypassPermissions = options.bypassPermissions;

    // Update logger with actual model
    this.logger = createLogger('AgentClient', { model: this.model });
  }

  /**
   * Create SDK options from agent configuration.
   */
  private createSdkOptions(resume?: string) {
    // Get node bin directory for PATH - needed for SDK subprocess spawning
    const nodeBinDir = getNodeBinDir();
    const newPath = `${nodeBinDir}:${process.env.PATH || ''}`;

    const sdkOptions: Record<string, unknown> = {
      cwd: Config.getWorkspaceDir(),
      permissionMode: this.permissionMode || 'default',
      // Load settings from .claude/ directory (skills, agents, etc.)
      settingSources: ['project'],
      // Enable Skill tool, WebSearch, Task, and Playwright MCP tools
      allowedTools: [
        'Skill',
        'WebSearch',
        'Task',
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
      ],
      // Configure Playwright MCP server
      mcpServers: {
        playwright: {
          type: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp@latest'],
        },
      },
    };

    // Set API key via environment
    if (this.apiKey) {
      sdkOptions.env = {
        ANTHROPIC_API_KEY: this.apiKey,
        PATH: newPath, // Ensure subprocess can find node
      };
    } else {
      // Always set PATH even without API key
      sdkOptions.env = {
        PATH: newPath,
      };
    }

    // Include all environment variables from .disclauderc/.env.sh
    // This ensures conda environments and other custom vars are available to subprocesses
    sdkOptions.env = {
      ...(sdkOptions.env as Record<string, string | undefined>),
      ...(process.env as Record<string, string | undefined>),
    };

    // Set model
    if (this.model) {
      sdkOptions.model = this.model;
    }

    // Set base URL if using custom endpoint (e.g., GLM)
    if (this.apiBaseUrl) {
      sdkOptions.env = {
        ...(sdkOptions.env as Record<string, string> | undefined),
        ANTHROPIC_BASE_URL: this.apiBaseUrl,
      };
    }

    // Resume session if provided
    if (resume) {
      sdkOptions.resume = resume;
    } else if (this.currentSessionId) {
      sdkOptions.resume = this.currentSessionId;
    }

    // Note: Not setting systemPrompt here so SDK uses project's CLAUDE.md
    // If needed, you can set: systemPrompt: { type: 'preset', preset: 'claude_code' }

    return sdkOptions;
  }

  /**
   * Stream agent response using Agent SDK.
   */
  async *queryStream(prompt: string, sessionId?: string): AsyncIterable<AgentMessage> {
    this.logger.debug({ sessionId, promptLength: prompt.length }, 'Starting query stream');

    try {
      const sdkOptions = this.createSdkOptions(sessionId);

      // Create query using Agent SDK
      const queryResult = query({
        prompt,
        options: sdkOptions,
      });

      // Process messages from SDK
      for await (const message of queryResult) {
        const parsed = parseSDKMessage(message);

        // Update session ID from parsed message
        if (parsed.sessionId) {
          this.currentSessionId = parsed.sessionId;
        }

        // Skip empty content
        if (!parsed.content) {
          continue;
        }

        // Yield structured message with type and metadata
        yield {
          content: parsed.content,
          role: 'assistant',
          messageType: parsed.type,
          metadata: parsed.metadata,
        };
      }

    } catch (error) {
      const enriched = handleError(error, {
        category: ErrorCategory.SDK,
        sessionId,
        promptLength: prompt.length,
        userMessage: 'Agent query failed. Please try again.'
      }, {
        log: true,
        customLogger: this.logger
      });

      // Yield error message
      yield {
        content: `❌ ${enriched.userMessage || enriched.message}`,
        role: 'assistant',
        messageType: 'error',
      };
    }
  }

  /**
   * Get session info for resuming conversations.
   */
  getSessionInfo(): SessionInfo {
    return {
      sessionId: this.currentSessionId,
      resume: this.currentSessionId,
    };
  }

  /**
   * Get environment variables for agent.
   */
  getEnvDict(): Record<string, string> {
    const envDict: Record<string, string> = {
      ANTHROPIC_API_KEY: this.apiKey,
      ANTHROPIC_MODEL: this.model,
      WORKSPACE_DIR: Config.getWorkspaceDir(),
    };

    if (this.apiBaseUrl) {
      envDict.ANTHROPIC_BASE_URL = this.apiBaseUrl;
    }

    return envDict;
  }

  /**
   * Extract text from agent message.
   */
  extractText(message: AgentMessage): string {
    const { content } = message;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if ('text' in block && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      return parts.join('');
    }

    return '';
  }
}
