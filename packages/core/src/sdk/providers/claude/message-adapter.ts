/**
 * Claude SDK 消息适配器
 *
 * 将 Claude SDK 的 SDKMessage 转换为统一的 AgentMessage 类型。
 *
 * Issue #2890: Enhanced to handle additional message types:
 * - thinking blocks (extended thinking responses from Claude)
 * - auth_status messages (authentication errors/status)
 * - Improved result message handling (total_cost_usd, duration_ms)
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentMessage,
  AgentMessageMetadata,
  UserInput,
} from '../../types.js';

/**
 * 适配 Claude SDK 消息为统一的 AgentMessage
 *
 * @param message - Claude SDK 消息
 * @returns 统一的 AgentMessage
 */
export function adaptSDKMessage(message: SDKMessage): AgentMessage {
  const metadata: AgentMessageMetadata = {};

  // 提取 session_id
  if ('session_id' in message && message.session_id) {
    metadata.sessionId = message.session_id;
  }

  switch (message.type) {
    case 'assistant': {
      const apiMessage = message.message;
      if (!apiMessage || !Array.isArray(apiMessage.content)) {
        return {
          type: 'text',
          content: '',
          role: 'assistant',
          raw: message,
        };
      }

      // 定义 SDK 内容块类型（包含 tool_use, thinking）
      type SdkContentBlock = { type: string; [key: string]: unknown };

      // 提取工具使用块
      const toolBlocks = (apiMessage.content as unknown[] as SdkContentBlock[]).filter(
        (block: SdkContentBlock) => block.type === 'tool_use'
      );

      // 提取文本块
      const textBlocks = (apiMessage.content as unknown[] as SdkContentBlock[]).filter(
        (block: SdkContentBlock) => block.type === 'text' && 'text' in block
      );

      // Issue #2890: 提取 thinking 块（extended thinking）
      const thinkingBlocks = (apiMessage.content as unknown[] as SdkContentBlock[]).filter(
        (block: SdkContentBlock) => block.type === 'thinking' && 'thinking' in block
      );

      // Issue #2890: 提取 usage 信息
      if (apiMessage.usage) {
        const usage = apiMessage.usage as { input_tokens?: number; output_tokens?: number };
        if (usage.input_tokens !== undefined) {metadata.inputTokens = usage.input_tokens;}
        if (usage.output_tokens !== undefined) {metadata.outputTokens = usage.output_tokens;}
      }

      // 构建内容
      const contentParts: string[] = [];

      // 处理工具使用
      if (toolBlocks.length > 0) {
        const [block] = toolBlocks; // 取第一个工具使用
        if ('name' in block && 'input' in block) {
          metadata.toolName = block.name as string;
          metadata.toolInput = block.input;
          contentParts.push(formatToolInput(block.name as string, block.input as Record<string, unknown>));
        }
      }

      // 处理文本
      const textParts = textBlocks
        .filter((block: SdkContentBlock) => 'text' in block)
        .map((block: SdkContentBlock) => String((block as unknown as { text: string }).text));

      if (textParts.length > 0) {
        contentParts.push(textParts.join(''));
      }

      // Issue #2890: 处理 thinking（如果只有 thinking 块没有文本，标记为 status 类型）
      if (thinkingBlocks.length > 0 && textParts.length === 0 && toolBlocks.length === 0) {
        const thinkingContent = thinkingBlocks
          .map((block: SdkContentBlock) => String((block as unknown as { thinking: string }).thinking))
          .join('\n');
        return {
          type: 'status' as const,
          content: `💭 ${thinkingContent.slice(0, 200)}${thinkingContent.length > 200 ? '...' : ''}`,
          role: 'assistant',
          metadata,
          raw: message,
        };
      }

      return {
        type: toolBlocks.length > 0 ? 'tool_use' : 'text',
        content: contentParts.join('\n'),
        role: 'assistant',
        metadata,
        raw: message,
      };
    }

    case 'tool_progress': {
      if ('tool_name' in message && 'elapsed_time_seconds' in message) {
        const toolName = message.tool_name as string;
        const elapsed = message.elapsed_time_seconds as number;
        metadata.toolName = toolName;
        metadata.elapsedMs = elapsed * 1000;
        return {
          type: 'tool_progress',
          content: `⏳ Running ${toolName} (${elapsed.toFixed(1)}s)`,
          role: 'assistant',
          metadata,
          raw: message,
        };
      }
      return {
        type: 'text',
        content: '',
        role: 'assistant',
        raw: message,
      };
    }

    case 'tool_use_summary': {
      if ('summary' in message) {
        return {
          type: 'tool_result',
          content: `✓ ${message.summary as string}`,
          role: 'assistant',
          metadata,
          raw: message,
        };
      }
      return {
        type: 'text',
        content: '',
        role: 'assistant',
        raw: message,
      };
    }

    case 'result': {
      if (message.subtype === 'success') {
        let statsText = '✅ Complete';

        // Issue #2890: Use total_cost_usd (SDK v0.2.x field name)
        if ('total_cost_usd' in message && typeof message.total_cost_usd === 'number') {
          metadata.costUsd = message.total_cost_usd;
          statsText += ` | Cost: $${message.total_cost_usd.toFixed(4)}`;
        }

        // Issue #2890: Use duration_ms for elapsed time
        if ('duration_ms' in message && typeof message.duration_ms === 'number') {
          metadata.elapsedMs = message.duration_ms;
          const durationSec = (message.duration_ms / 1000).toFixed(1);
          statsText += ` | Time: ${durationSec}s`;
        }

        if ('usage' in message && message.usage) {
          const usage = message.usage as {
            input_tokens?: number;
            output_tokens?: number;
          };

          if (usage.input_tokens !== undefined) {
            metadata.inputTokens = usage.input_tokens;
          }
          if (usage.output_tokens !== undefined) {
            metadata.outputTokens = usage.output_tokens;
          }
        }

        return {
          type: 'result',
          content: statsText,
          role: 'assistant',
          metadata,
          raw: message,
        };
      }

      // Issue #2890: Handle all error subtypes
      if ('is_error' in message && message.is_error && 'errors' in message) {
        const errors = message.errors as string[];
        return {
          type: 'error',
          content: `❌ Error: ${errors.join(', ')}`,
          role: 'assistant',
          metadata,
          raw: message,
        };
      }

      // Handle other result subtypes (error_max_turns, error_max_budget_usd)
      if ('is_error' in message && message.is_error) {
        const subtype = message.subtype as string;
        return {
          type: 'error',
          content: `❌ Error: ${subtype.replace(/_/g, ' ')}`,
          role: 'assistant',
          metadata,
          raw: message,
        };
      }

      return {
        type: 'text',
        content: '',
        role: 'assistant',
        raw: message,
      };
    }

    case 'system': {
      if (message.subtype === 'status') {
        if ('status' in message && message.status === 'compacting') {
          return {
            type: 'status',
            content: '🔄 Compacting conversation history...',
            role: 'system',
            metadata,
            raw: message,
          };
        }
      }

      // 忽略其他系统消息
      return {
        type: 'text',
        content: '',
        role: 'system',
        raw: message,
      };
    }

    case 'user':
    case 'stream_event':
    default:
      // Issue #2890: Handle auth_status messages
      if (message.type === 'auth_status') {
        if ('error' in message && message.error) {
          return {
            type: 'error',
            content: `🔐 Authentication error: ${message.error as string}`,
            role: 'assistant',
            metadata,
            raw: message,
          };
        }
        // Ignore non-error auth status messages
        return {
          type: 'text',
          content: '',
          role: 'assistant',
          raw: message,
        };
      }
      // 忽略用户消息回显和流事件
      return {
        type: 'text',
        content: '',
        role: 'user',
        raw: message,
      };
  }
}

/**
 * 适配统一 UserInput 为 Claude SDK SDKUserMessage
 *
 * @param input - 统一的用户输入
 * @returns Claude SDK SDKUserMessage
 */
export function adaptUserInput(input: UserInput): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: input.content as unknown as string,
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * 格式化工具输入用于显示
 */
function formatToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) {
    return `🔧 ${toolName}`;
  }

  switch (toolName) {
    case 'Bash': {
      const cmd = input.command as string | undefined;
      return `🔧 Running: ${cmd || '<no command>'}`;
    }
    case 'Edit': {
      const filePath = (input.file_path as string | undefined) || (input.filePath as string | undefined);
      return `🔧 Editing: ${filePath || '<unknown file>'}`;
    }
    case 'Read': {
      const readPath = input.file_path as string | undefined;
      return `🔧 Reading: ${readPath || '<unknown file>'}`;
    }
    case 'Write': {
      const writePath = input.file_path as string | undefined;
      return `🔧 Writing: ${writePath || '<unknown file>'}`;
    }
    case 'Grep': {
      const pattern = input.pattern as string | undefined;
      return pattern ? `🔧 Searching for "${pattern}"` : '🔧 Searching';
    }
    case 'Glob': {
      const globPattern = input.pattern as string | undefined;
      return `🔧 Finding files: ${globPattern || '<no pattern>'}`;
    }
    default: {
      const str = safeStringify(input, 60);
      return `🔧 ${toolName}: ${str}`;
    }
  }
}

/**
 * 安全地序列化对象
 */
function safeStringify(obj: unknown, maxLength: number = 100): string {
  try {
    const str = JSON.stringify(obj);
    if (str.length <= maxLength) {
      return str;
    }
    return `${str.slice(0, maxLength - 3)}...`;
  } catch {
    return String(obj);
  }
}
