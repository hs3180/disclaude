/**
 * Shared utilities for Claude Agent SDK integration.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ParsedSDKMessage,
} from '../types/agent.js';

/**
 * Parameters for creating agent SDK options.
 */
export interface CreateAgentSdkOptionsParams {
  /** API key for authentication */
  apiKey: string;
  /** Model identifier */
  model: string;
  /** Optional API base URL (e.g., for custom endpoints like GLM) */
  apiBaseUrl?: string;
  /** Working directory for the agent */
  cwd?: string;
  /** Permission mode for tool execution */
  permissionMode?: 'default' | 'bypassPermissions';
  /** Optional session ID to resume */
  resume?: string;
}

/**
 * Get directory containing node executable.
 * This is needed for SDK subprocess spawning to find node.
 */
export function getNodeBinDir(): string {
  const execPath = process.execPath;
  return execPath.substring(0, execPath.lastIndexOf('/'));
}

/**
 * Create SDK options for agent execution.
 * This shared function ensures consistent configuration across all agent instances.
 *
 * @param params - Configuration parameters
 * @returns SDK options object compatible with @anthropic-ai/claude-agent-sdk query()
 */
export function createAgentSdkOptions(params: CreateAgentSdkOptionsParams): Record<string, unknown> {
  const {
    apiKey,
    model,
    apiBaseUrl,
    cwd = process.cwd(),
    permissionMode = 'bypassPermissions',
    resume,
  } = params;

  // Get node bin directory for PATH - needed for SDK subprocess spawning
  const nodeBinDir = getNodeBinDir();
  const newPath = `${nodeBinDir}:${process.env.PATH || ''}`;

  const sdkOptions: Record<string, unknown> = {
    cwd,
    permissionMode,
    // Load settings from .claude/ directory (skills, agents, etc.)
    settingSources: ['project'],
    // Enable Skill tool, WebSearch, Task, and Playwright MCP tools
    allowedTools: [
      'Skill',
      'WebSearch',
      'Task',
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
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

  // Set environment variables
  sdkOptions.env = {
    ANTHROPIC_API_KEY: apiKey,
    PATH: newPath,
  };

  // Set model
  if (model) {
    sdkOptions.model = model;
  }

  // Set base URL if using custom endpoint (e.g., GLM)
  if (apiBaseUrl) {
    (sdkOptions.env as Record<string, string>).ANTHROPIC_BASE_URL = apiBaseUrl;
  }

  // Resume session if provided
  if (resume) {
    sdkOptions.resume = resume;
  }

  return sdkOptions;
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLength: number = 100): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Safely stringify an object for display.
 */
function safeStringify(obj: unknown, maxLength: number = 100): string {
  try {
    const str = JSON.stringify(obj);
    return truncate(str, maxLength);
  } catch {
    return String(obj);
  }
}

/**
 * Extract text from SDK message.
 * Handles both assistant messages (streaming responses) and error messages.
 * @deprecated Use parseSDKMessage() for enhanced message type support.
 */
export function extractTextFromSDKMessage(message: SDKMessage): string {
  const parsed = parseSDKMessage(message);
  return parsed.content;
}

/**
 * Format tool input for display, showing intent rather than raw parameters.
 */
function formatToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';

  switch (toolName) {
    case 'Bash':
      const cmd = input.command as string | undefined;
      return `Running: ${cmd || '<no command>'}`;

    case 'Edit':
      const editPath = (input.file_path as string | undefined) || (input.filePath as string | undefined);
      return `Editing: ${editPath || '<unknown file>'}`;

    case 'Read':
      const readPath = input.file_path as string | undefined;
      return `Reading: ${readPath || '<unknown file>'}`;

    case 'Write':
      const writePath = input.file_path as string | undefined;
      return `Writing: ${writePath || '<unknown file>'}`;

    case 'Grep': {
      const pattern = input.pattern as string | undefined;
      const type = input.type as string | undefined;
      if (pattern) {
        return type ? `Searching for "${pattern}" in ${type} files` : `Searching for "${pattern}"`;
      }
      return `Searching: ${safeStringify(input, 60)}`;
    }

    case 'Glob':
      const globPattern = input.pattern as string | undefined;
      return `Finding files: ${globPattern || '<no pattern>'}`;

    case 'WebSearch':
      const query = input.query as string | undefined;
      return `Searching web: "${query || '<no query>'}"`;

    case 'WebFetch':
      const url = input.url as string | undefined;
      return `Fetching: ${url || '<no url>'}`;

    case 'LSP':
      const operation = input.operation as string | undefined;
      return `LSP: ${operation || '<unknown operation>'}`;

    default:
      return safeStringify(input, 60);
  }
}

/**
 * Format Edit tool use with rich details showing what will be changed.
 * Uses ANSI colors for console output.
 */
function formatEditToolUse(input: Record<string, unknown>): string {
  // SDK uses snake_case for Edit tool parameters
  const filePath = (input.file_path as string | undefined) || (input.filePath as string | undefined);
  const oldString = (input.old_string as string | undefined) || (input.oldString as string | undefined);
  const newString = (input.new_string as string | undefined) || (input.newString as string | undefined);

  if (!filePath) {
    return '🔧 Editing: <unknown file>';
  }

  // Build rich formatted output
  const lines: string[] = [];

  // Header with file path (cyan for file)
  lines.push(`\x1b[36m📝 Editing:\x1b[0m \x1b[1;34m${filePath}\x1b[0m`);

  // Show content preview if available
  if (oldString !== undefined && newString !== undefined) {
    // Truncate long strings for display
    const maxPreview = 100;
    const oldPreview = oldString.length > maxPreview
      ? oldString.substring(0, maxPreview) + '...'
      : oldString;
    const newPreview = newString.length > maxPreview
      ? newString.substring(0, maxPreview) + '...'
      : newString;

    // Before (dim for removal)
    lines.push(`\x1b[90m  Before: ${oldPreview}\x1b[0m`);

    // After (green for addition)
    lines.push(`\x1b[92m  After:  ${newPreview}\x1b[0m`);
  }

  return lines.join('\n');
}

/**
 * Format Edit tool use with markdown for rich text platforms (e.g., Feishu).
 * Uses markdown code blocks and formatting instead of ANSI colors.
 */
export function formatEditToolUseMarkdown(input: Record<string, unknown>): string {
  // SDK uses snake_case for Edit tool parameters
  const filePath = (input.file_path as string | undefined) || (input.filePath as string | undefined);
  const oldString = (input.old_string as string | undefined) || (input.oldString as string | undefined);
  const newString = (input.new_string as string | undefined) || (input.newString as string | undefined);

  if (!filePath) {
    return '🔧 Editing: <unknown file>';
  }

  // Build markdown formatted output
  const lines: string[] = [];

  // Header with file path
  lines.push(`**📝 Editing:** ${filePath}`);

  // Show content preview if available
  if (oldString !== undefined && newString !== undefined) {
    // Truncate long strings for display
    const maxPreview = 100;
    const oldPreview = oldString.length > maxPreview
      ? oldString.substring(0, maxPreview) + '...'
      : oldString;
    const newPreview = newString.length > maxPreview
      ? newString.substring(0, maxPreview) + '...'
      : newString;

    // Use code blocks for before/after content
    lines.push('');
    lines.push(`**Before:**`);
    lines.push(`\`\`\``);
    lines.push(oldPreview);
    lines.push(`\`\`\``);
    lines.push('');
    lines.push(`**After:**`);
    lines.push(`\`\`\``);
    lines.push(newPreview);
    lines.push(`\`\`\``);
  }

  return lines.join('\n');
}

/**
 * Parse SDK message into structured format with type and metadata.
 * Handles tool use, progress, results, and other message types.
 */
export function parseSDKMessage(message: SDKMessage): ParsedSDKMessage {
  const result: ParsedSDKMessage = {
    type: 'text',
    content: '',
    metadata: {},
  };

  // Extract session_id from any message that has it
  if ('session_id' in message && message.session_id) {
    result.sessionId = message.session_id;
  }

  switch (message.type) {
    case 'assistant': {
      const apiMessage = message.message;
      if (!apiMessage || !Array.isArray(apiMessage.content)) {
        return { type: 'text', content: '' };
      }

      // Check for tool_use blocks in content
      const toolBlocks = apiMessage.content.filter(
        (block) => block.type === 'tool_use'
      );

      // Check for text blocks
      const textBlocks = apiMessage.content.filter(
        (block) => block.type === 'text' && 'text' in block
      );

      if (toolBlocks.length > 0) {
        // Process each tool use block
        for (const block of toolBlocks) {
          if ('name' in block && 'input' in block) {
            const toolName = block.name as string;
            const input = block.input as Record<string, unknown> | undefined;

            result.type = 'tool_use';
            result.metadata = {
              toolName,
              toolInput: formatToolInput(toolName, input),
              toolInputRaw: input,  // Save raw input for processing (e.g., building diff cards)
            };

            // Use rich formatting for Edit tool
            if (toolName === 'Edit' && input) {
              result.content = formatEditToolUse(input);
            } else {
              result.content = `🔧 ${formatToolInput(toolName, input)}`;
            }

            return result;
          }
        }
      }

      // Extract text content
      const textParts = textBlocks
        .filter((block) => 'text' in block)
        .map((block) => (block as { text: string }).text);

      if (textParts.length > 0) {
        result.type = 'text';
        result.content = textParts.join('');
        return result;
      }

      return { type: 'text', content: '' };
    }

    case 'tool_progress': {
      // Tool execution progress update
      // SDKToolProgressMessage has tool_name and elapsed_time_seconds fields
      if ('tool_name' in message && 'elapsed_time_seconds' in message) {
        const toolName = message.tool_name as string;
        const elapsed = message.elapsed_time_seconds as number;
        result.type = 'tool_progress';
        result.content = `⏳ Running ${toolName} (${elapsed.toFixed(1)}s)`;
        result.metadata = {
          toolName,
          elapsed,
        };
        return result;
      }
      return { type: 'text', content: '' };
    }

    case 'tool_use_summary': {
      // Tool execution completed
      // SDKToolUseSummaryMessage has summary field, not name
      if ('summary' in message) {
        const summary = message.summary as string;
        result.type = 'tool_result';
        result.content = `✓ ${summary}`;
        return result;
      }
      return { type: 'text', content: '' };
    }

    case 'result': {
      if (message.subtype === 'success') {
        // Successful completion with usage stats
        let statsText = '✅ Complete';

        if ('usage' in message && message.usage) {
          const usage = message.usage as { total_cost?: number; total_tokens?: number };
          const parts: string[] = [];

          if (usage.total_cost !== undefined) {
            parts.push(`Cost: $${usage.total_cost.toFixed(4)}`);
          }
          if (usage.total_tokens !== undefined) {
            parts.push(`Tokens: ${(usage.total_tokens / 1000).toFixed(1)}k`);
          }

          if (parts.length > 0) {
            statsText += ' | ' + parts.join(' | ');
          }
        }

        result.type = 'result';
        result.content = statsText;
        result.metadata = {
          cost: (message.usage as { total_cost?: number })?.total_cost,
          tokens: (message.usage as { total_tokens?: number })?.total_tokens,
        };
        return result;
      }

      if (message.subtype === 'error_during_execution' && 'errors' in message) {
        const errors = message.errors as string[];
        result.type = 'error';
        result.content = `❌ Error: ${errors.join(', ')}`;
        return result;
      }

      return { type: 'text', content: '' };
    }

    case 'system': {
      if (message.subtype === 'status') {
        // System status update (e.g., compacting)
        if ('status' in message && message.status === 'compacting') {
          result.type = 'status';
          result.content = '🔄 Compacting conversation history...';
          return result;
        }
      }

      if (message.subtype === 'hook_started') {
        // Hook execution started
        if ('hook' in message && 'event' in message) {
          const hook = message.hook as string;
          result.type = 'notification';
          result.content = `🪝 Hook: ${hook}`;
          result.metadata = { status: hook };
          return result;
        }
      }

      if (message.subtype === 'hook_response') {
        // Hook execution completed
        if ('hook' in message && 'outcome' in message) {
          const hook = message.hook as string;
          const outcome = message.outcome as string;
          result.type = 'notification';
          result.content = `🪝 Hook ${hook}: ${outcome}`;
          result.metadata = { status: outcome };
          return result;
        }
      }

      if (message.subtype === 'task_notification') {
        // Task completion notification
        if ('status' in message && 'task_id' in message) {
          const status = message.status as string;
          result.type = 'notification';
          result.content = `📋 Task ${message.task_id as string}: ${status}`;
          result.metadata = { status };
          return result;
        }
      }

      // Ignore other system messages (init, etc.)
      return { type: 'text', content: '' };
    }

    case 'user':
    case 'stream_event':
    default:
      // Ignore user messages (echoes) and stream events
      return { type: 'text', content: '' };
  }
}
