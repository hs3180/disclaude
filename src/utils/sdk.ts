/**
 * Shared utilities for Claude Agent SDK integration.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ParsedSDKMessage,
} from '../types/agent.js';

/**
 * Get directory containing node executable.
 * This is needed for SDK subprocess spawning to find node.
 */
export function getNodeBinDir(): string {
  const execPath = process.execPath;
  return execPath.substring(0, execPath.lastIndexOf('/'));
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

            // Build tool input preview
            let inputPreview = '';
            if (input) {
              if (toolName === 'Bash' && 'command' in input) {
                inputPreview = String(input.command);
              } else if (toolName === 'Edit' && 'filePath' in input) {
                inputPreview = String(input.filePath);
              } else if (toolName === 'Read' && 'file_path' in input) {
                inputPreview = String(input.file_path);
              } else if (toolName === 'Write' && 'file_path' in input) {
                inputPreview = String(input.file_path);
              } else {
                inputPreview = safeStringify(input, 60);
              }
            }

            result.type = 'tool_use';
            result.content = `🔧 Using ${toolName}${inputPreview ? `: ${inputPreview}` : ''}`;
            result.metadata = {
              toolName,
              toolInput: inputPreview,
            };
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
      if ('name' in message && 'elapsed' in message) {
        const toolName = message.name as string;
        const elapsed = message.elapsed as number;
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
      if ('name' in message) {
        const toolName = message.name as string;
        result.type = 'tool_result';
        result.content = `✓ ${toolName} completed`;
        result.metadata = { toolName };
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
