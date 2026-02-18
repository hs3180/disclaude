/**
 * Shared utilities for Claude Agent SDK integration.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentMessage,
  ContentBlock,
  ParsedSDKMessage,
} from '../types/agent.js';

/**
 * Get directory containing node executable.
 * This is needed for SDK subprocess spawning to find node.
 */
export function getNodeBinDir(): string {
  const {execPath} = process;
  return execPath.substring(0, execPath.lastIndexOf('/'));
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLength: number = 100): string {
  if (str.length <= maxLength) {return str;}
  return `${str.slice(0, maxLength - 3)  }...`;
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
 * Format tool input for display, showing intent rather than raw parameters.
 */
function formatToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) {return '';}

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

    case 'Write': {
      const writePath = input.file_path as string | undefined;
      const writeContent = input.content as string | undefined;
      const lineCount = writeContent ? writeContent.split('\n').length : 0;
      return writePath
        ? `Writing: ${writePath} (${lineCount} lines)`
        : 'Writing: <unknown file>';
    }

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
      ? `${oldString.substring(0, maxPreview)  }...`
      : oldString;
    const newPreview = newString.length > maxPreview
      ? `${newString.substring(0, maxPreview)  }...`
      : newString;

    // Before (dim for removal)
    lines.push(`\x1b[90m  Before: ${oldPreview}\x1b[0m`);

    // After (green for addition)
    lines.push(`\x1b[92m  After:  ${newPreview}\x1b[0m`);
  }

  return lines.join('\n');
}

/**
 * Parse SDK message into structured format with type and metadata.
 * Handles tool use, progress, results, and other message types.
 *
 * IMPORTANT: Accumulates ALL content blocks from assistant messages,
 * not just the first one. This ensures all tool uses and text are sent.
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

      // Accumulate all content blocks (tool uses + text)
      const contentParts: string[] = [];

      // Process all tool use blocks
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
            contentParts.push(formatEditToolUse(input));
          } else {
            contentParts.push(`🔧 ${formatToolInput(toolName, input)}`);
          }
        }
      }

      // Extract all text content
      const textParts = textBlocks
        .filter((block) => 'text' in block)
        .map((block) => (block as { text: string }).text);

      if (textParts.length > 0) {
        contentParts.push(textParts.join(''));
      }

      // Return all accumulated content
      if (contentParts.length > 0) {
        result.content = contentParts.join('\n');
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
            statsText += ` | ${  parts.join(' | ')}`;
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

/**
 * Extract text from AgentMessage.
 * Handles both string content and array content with text blocks.
 *
 * This is the canonical extractText function - use this instead of
 * duplicating the logic in agent classes.
 *
 * @param message - AgentMessage to extract text from
 * @returns Extracted text content
 */
export function extractText(message: AgentMessage): string {
  const { content } = message;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block): block is ContentBlock & { text: string } =>
        'text' in block && typeof block.text === 'string'
      )
      .map(block => block.text)
      .join('');
  }

  return '';
}

/**
 * Build SDK environment variables with unified apiBaseUrl handling.
 * This function centralizes environment variable setup for all agents.
 *
 * @param apiKey - API key for authentication
 * @param apiBaseUrl - Optional base URL for API requests (e.g., for GLM)
 * @param extraEnv - Optional extra environment variables to merge
 * @returns Environment object for SDK options
 */
export function buildSdkEnv(
  apiKey: string,
  apiBaseUrl?: string,
  extraEnv?: Record<string, string | undefined>
): Record<string, string | undefined> {
  const nodeBinDir = getNodeBinDir();
  const newPath = `${nodeBinDir}:${process.env.PATH || ''}`;

  const env: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: apiKey,
    PATH: newPath,
    ...extraEnv,
    ...(process.env as Record<string, string | undefined>),
  };

  // Set base URL if provided (for GLM or custom endpoints)
  if (apiBaseUrl) {
    env.ANTHROPIC_BASE_URL = apiBaseUrl;
  }

  return env;
}
