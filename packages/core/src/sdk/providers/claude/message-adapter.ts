/**
 * Claude SDK 消息适配器
 *
 * 将 Claude SDK 的 SDKMessage 转换为统一的 AgentMessage 类型。
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type {
  AgentMessage,
  AgentMessageMetadata,
  UserInput,
  TextContentBlock,
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

      // apiMessage.content 已由上方 Array.isArray 守卫确认为数组。
      // TypeScript 通过 switch 将 message 收窄为 SDKAssistantMessage，
      // 因此 apiMessage (BetaMessage) 的 content 类型为 Array<BetaContentBlock>。
      // Array.isArray() 返回类型为 `x is any[]`，丢失了元素类型信息，
      // 这里使用类型注解（非 as 断言）恢复精确类型。
      const { content }: { content: BetaContentBlock[] } = apiMessage;

      // 提取工具使用块 — BetaContentBlock 是可辨识联合类型，
      // block.type === 'tool_use' 时 TypeScript 自动收窄为 BetaToolUseBlock
      const toolBlocks = content.filter(
        (block): block is Extract<BetaContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use' && 'name' in block && 'input' in block
      );

      // 提取文本块 — block.type === 'text' 时 TypeScript 自动收窄为 BetaTextBlock
      const textBlocks = content.filter(
        (block): block is Extract<BetaContentBlock, { type: 'text'; text: string }> =>
          block.type === 'text' && 'text' in block
      );

      // 构建内容
      const contentParts: string[] = [];

      // 处理工具使用
      if (toolBlocks.length > 0) {
        const [block] = toolBlocks; // 取第一个工具使用
        metadata.toolName = block.name;
        metadata.toolInput = block.input;
        contentParts.push(formatToolInput(block.name, block.input as Record<string, unknown>));
      }

      // 处理文本
      const textParts = textBlocks.map((block) => block.text);

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
      // TypeScript 通过 switch 将 message 收窄为 SDKToolProgressMessage，
      // tool_name (string) 和 elapsed_time_seconds (number) 已有明确类型。
      // 保留属性守卫以防御运行时数据与 SDK 类型不一致的情况。
      if (message.tool_name !== undefined && message.tool_name !== null
          && message.elapsed_time_seconds !== undefined && message.elapsed_time_seconds !== null) {
        const toolName = message.tool_name;
        const elapsed = message.elapsed_time_seconds;
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
      // TypeScript 通过 switch 将 message 收窄为 SDKToolUseSummaryMessage，
      // summary 字段类型为 string，无需类型断言。
      // 保留属性守卫以防御运行时数据与 SDK 类型不一致的情况。
      if (message.summary !== undefined && message.summary !== null) {
        return {
          type: 'tool_result',
          content: `✓ ${message.summary}`,
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
        // TypeScript 通过 subtype === 'success' 将 message 收窄为 SDKResultSuccess。
        // SDKResultSuccess 包含 usage: NonNullableUsage 和 total_cost_usd: number。
        let statsText = '✅ Complete';

        if ('usage' in message && message.usage) {
          const { usage } = message;

          const parts: string[] = [];

          // SDKResultSuccess.total_cost_usd 是 SDK 标准字段；
          // 部分运行时数据可能将 cost 放在 usage.total_cost 中（非 SDK 类型定义）。
          // 使用运行时检查优先读取 total_cost_usd，回退到 usage.total_cost。
          const costUsd = message.total_cost_usd
            ?? ('total_cost' in usage ? usage.total_cost as number : undefined);
          if (costUsd !== undefined && costUsd > 0) {
            metadata.costUsd = costUsd;
            parts.push(`Cost: $${costUsd.toFixed(4)}`);
          }

          // NonNullableUsage 提供 input_tokens 和 output_tokens (number 类型)
          const inputTokens = usage.input_tokens as number | undefined;
          const outputTokens = usage.output_tokens as number | undefined;
          const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
          if (totalTokens > 0) {
            parts.push(`Tokens: ${(totalTokens / 1000).toFixed(1)}k`);
          }
          if (inputTokens !== undefined) {
            metadata.inputTokens = inputTokens;
          }
          if (outputTokens !== undefined) {
            metadata.outputTokens = outputTokens;
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

      // SDKResultError.subtype 包含 'error_during_execution' 等多种错误类型，
      // errors 字段类型为 string[]，无需类型断言。
      if (message.subtype === 'error_during_execution' && 'errors' in message) {
        return {
          type: 'error',
          content: `❌ Error: ${message.errors.join(', ')}`,
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
  // UserInput.content: `string | ContentBlock[]`
  // MessageParam.content: `string | Array<ContentBlockParam>`
  //
  // Runtime guard: string values pass through directly. For ContentBlock[]
  // we extract text from text blocks — ImageContentBlock has no equivalent
  // in the SDK's ContentBlockParam union, so non-text blocks are dropped.
  const content = typeof input.content === 'string'
    ? input.content
    : input.content
        .filter((block): block is TextContentBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');

  return {
    type: 'user',
    message: {
      role: 'user',
      content,
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
