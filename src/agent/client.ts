/**
 * Claude Agent SDK client wrapper.
 * Uses the official @anthropic-ai/claude-agent-sdk for full tool support.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'fs';
import { extractTextFromSDKMessage, getNodeBinDir } from '../utils/sdk.js';
import type {
  AgentMessage,
  AgentOptions,
  SessionInfo,
} from '../types/agent.js';

/**
 * Agent SDK client with full tool support.
 */
export class AgentClient {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBaseUrl: string | undefined;
  readonly workspace: string;
  readonly permissionMode: AgentOptions['permissionMode'];
  readonly bypassPermissions: boolean | undefined;

  // Session tracking for conversation continuity
  private currentSessionId?: string;

  constructor(options: AgentOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.apiBaseUrl = options.apiBaseUrl;
    this.workspace = options.workspace;
    this.permissionMode = options.permissionMode;
    this.bypassPermissions = options.bypassPermissions;
  }

  /**
   * Create SDK options from agent configuration.
   */
  private createSdkOptions(resume?: string) {
    // Get node bin directory for PATH - needed for SDK subprocess spawning
    const nodeBinDir = getNodeBinDir();
    const newPath = `${nodeBinDir}:${process.env.PATH || ''}`;

    const sdkOptions: Record<string, unknown> = {
      cwd: this.workspace,
      permissionMode: this.permissionMode || 'default',
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

    // Use Claude Code system prompt for best agentic behavior
    sdkOptions.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
    };

    return sdkOptions;
  }

  /**
   * Stream agent response using Agent SDK.
   */
  async *queryStream(prompt: string, sessionId?: string): AsyncIterable<AgentMessage> {
    try {
      const sdkOptions = this.createSdkOptions(sessionId);

      // Create query using Agent SDK
      const queryResult = query({
        prompt,
        options: sdkOptions,
      });

      // Process messages from SDK
      for await (const message of queryResult) {
        const text = extractTextFromSDKMessage(message);
        if (text) {
          // Update session ID from SDK messages
          if ('session_id' in message && message.session_id) {
            this.currentSessionId = message.session_id;
          }

          // Yield partial updates for streaming
          yield { content: text, role: 'assistant' };
        }
      }

    } catch (error) {
      // Yield error message
      yield {
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        role: 'assistant'
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
      WORKSPACE_DIR: this.workspace,
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
    const content = message.content;

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

  /**
   * Ensure workspace directory exists.
   */
  async ensureWorkspace(): Promise<void> {
    await fs.mkdir(this.workspace, { recursive: true }).catch(() => {
      // Ignore if already exists
    });
  }
}
