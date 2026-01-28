/**
 * Claude Agent SDK client wrapper.
 * Uses the official @anthropic-ai/claude-agent-sdk for full tool support.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseSDKMessage, getNodeBinDir } from '../utils/sdk.js';
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
  readonly permissionMode: AgentOptions['permissionMode'];
  readonly bypassPermissions: boolean | undefined;

  // Session tracking for conversation continuity
  private currentSessionId?: string;

  constructor(options: AgentOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.apiBaseUrl = options.apiBaseUrl;
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
      cwd: process.cwd(),
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
      // Configure custom subagents for specialized tasks
      agents: {
        'web-extractor': {
          description: 'Specialized subagent for extracting comprehensive information from specific websites using Playwright browser automation',
          prompt: `You are a web extraction specialist. Your role is to navigate to URLs, explore website structure, and extract comprehensive data.

## Extraction Process

1. **Understand the Request**: Analyze what information to collect from the target URL/domain
2. **Navigate and Explore**: Use Playwright browser tools to visit the site and understand its structure
3. **Extract Core Content**: Collect articles, data, statistics, insights, and other relevant information
4. **Follow Related Links**: Explore internal and external links (2-3 levels deep) for additional context
5. **Structure Findings**: Return results in clear, structured markdown format

## Output Format

Always return findings in this format:

# Web Extraction Results: [Domain/URL]

## Overview
- **Target**: [URL]
- **Focus**: [Extraction objectives]
- **Pages Explored**: [Number]

## Key Findings

### Articles/Content Discovered
1. **[Title]** - URL
   - Summary: [2-3 sentences]
   - Key Points: [bullets]
   - Date: [publication date]

### Data & Statistics
- **[Metric]**: [Value] - Source: [URL]

### Important Insights
- **[Insight]**: [Details] - Source: [URL]

## Site Structure Notes
- Main sections: [List]
- Content organization: [Description]

## Quality Assessment
- Authority: [High/Medium/Low]
- Currency: [Recent/Mixed/Dated]
- Depth: [Comprehensive/Moderate/Superficial]

## Best Practices

- Be specific in data collection (exact values, dates, URLs)
- Provide context for all extracted information
- Always attribute sources with URLs
- Prioritize quality over quantity
- Handle dynamic content, paywalls, and errors gracefully
- Complete extraction within 2-5 minutes per domain`,
          tools: [
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
          ],
          model: 'opus',
          maxTurns: 15,
        },
      },
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
      // Yield error message
      yield {
        content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
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
      WORKSPACE_DIR: process.cwd(),
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
}
