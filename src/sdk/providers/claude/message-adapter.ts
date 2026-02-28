/**
 * Claude SDK 消息适配器
 *
 * 将 Claude SDK 的 SDKMessage 转换为统一的 AgentMessage 类型。
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

      // 定义 SDK 内容块类型（包含 tool_use）
      type SdkContentBlock = { type: string; [key: string]: unknown };

      // 提取工具使用块
      const toolBlocks = apiMessage.content.filter(
        (block: SdkContentBlock) => block.type === 'tool_use'
      );

      // 提取文本块
      const textBlocks = apiMessage.content.filter(
        (block: SdkContentBlock) => block.type === 'text' && 'text' in block
      );

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

        if ('usage' in message && message.usage) {
          const usage = message.usage as {
            total_cost?: number;
            total_tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
          };

          const parts: string[] = [];

          if (usage.total_cost !== undefined) {
            metadata.costUsd = usage.total_cost;
            parts.push(`Cost: $${usage.total_cost.toFixed(4)}`);
          }
          if (usage.total_tokens !== undefined) {
            parts.push(`Tokens: ${(usage.total_tokens / 1000).toFixed(1)}k`);
          }
          if (usage.input_tokens !== undefined) {
            metadata.inputTokens = usage.input_tokens;
          }
          if (usage.output_tokens !== undefined) {
            metadata.outputTokens = usage.output_tokens;
          }

          if (parts.length > 0) {
            statsText += ` | ${parts.join(' | ')}`;
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

      if (message.subtype === 'error_during_execution' && 'errors' in message) {
        const errors = message.errors as string[];
        return {
          type: 'error',
          content: `❌ Error: ${errors.join(', ')}`,
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
      content: input.content,
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
