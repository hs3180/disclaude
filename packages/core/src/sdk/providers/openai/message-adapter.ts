/**
 * OpenAI SDK 消息适配器
 *
 * 将 OpenAI Agents SDK 的流事件转换为统一的 AgentMessage 类型。
 *
 * OpenAI Agents SDK 的 StreamedRunResult 是 AsyncIterable<RunStreamEvent>，
 * 其中 RunStreamEvent 有三种类型：
 * - RunRawModelStreamEvent (type: "raw_model_stream_event") - 原始模型流事件
 * - RunItemStreamEvent (type: "run_item_stream_event") - 运行项事件
 * - RunAgentUpdatedStreamEvent (type: "agent_updated_stream_event") - Agent 更新事件
 */

import type {
  RunStreamEvent,
  StreamedRunResult,
} from '@openai/agents';
import type {
  AgentMessage,
  AgentMessageMetadata,
} from '../../types.js';

/**
 * 适配 OpenAI SDK 流事件为统一的 AgentMessage
 *
 * @param event - OpenAI SDK 流事件
 * @returns 统一的 AgentMessage，如果事件应被忽略则返回 null
 */
export function adaptStreamEvent(event: RunStreamEvent): AgentMessage | null {
  const e = event as unknown as Record<string, unknown>;

  switch (e.type) {
    // ==========================================================================
    // 原始模型流事件 - 用于流式文本输出
    // ==========================================================================
    case 'raw_model_stream_event': {
      const data = e.data as Record<string, unknown> | undefined;
      if (!data) return null;

      // 文本增量事件
      if (data.type === 'response.output_text.delta') {
        const delta = data.delta as string;
        return {
          type: 'text',
          content: delta || '',
          role: 'assistant',
          raw: event,
        };
      }

      // 忽略其他原始事件（如 function_call_arguments.delta 等）
      return null;
    }

    // ==========================================================================
    // 运行项事件 - 工具调用、消息完成等
    // ==========================================================================
    case 'run_item_stream_event': {
      const name = e.name as string | undefined;
      const item = e.item as Record<string, unknown> | undefined;
      if (!name || !item) return null;

      switch (name) {
        case 'tool_called': {
          // 工具调用开始
          const toolName = (item.name as string) || 'unknown';
          return {
            type: 'tool_use',
            content: formatToolEvent(toolName, item),
            role: 'assistant',
            metadata: {
              toolName,
              toolInput: parseToolArguments(item.arguments as string | undefined),
            },
            raw: event,
          };
        }

        case 'tool_output': {
          // 工具调用完成，输出可用
          return {
            type: 'tool_result',
            content: '✓ Tool completed',
            role: 'assistant',
            raw: event,
          };
        }

        case 'message_output_created': {
          // 消息输出创建（完整消息，非增量）
          // 注意：流式文本已通过 raw_model_stream_event 处理，
          // 这里可以忽略以避免重复
          return null;
        }

        case 'tool_approval_requested': {
          // 工具需要审批
          const toolName = (item.name as string) || 'tool';
          return {
            type: 'tool_progress',
            content: `⏳ Approval required for ${toolName}`,
            role: 'assistant',
            metadata: { toolName },
            raw: event,
          };
        }

        case 'reasoning_item_created': {
          // 推理项创建
          return null;
        }

        default:
          return null;
      }
    }

    // ==========================================================================
    // Agent 更新事件
    // ==========================================================================
    case 'agent_updated_stream_event': {
      // Agent 状态变更（如 handoff），通常可以忽略
      return null;
    }

    default:
      return null;
  }
}

/**
 * 适配 OpenAI SDK 流式运行结果为统一的 AgentMessage（result 类型）
 *
 * 从 StreamedRunResult 中提取使用统计信息。
 *
 * @param streamResult - OpenAI SDK 流式运行结果
 * @returns 统一的 AgentMessage（包含使用统计）
 */
export function adaptStreamResult(
  streamResult: StreamedRunResult<unknown, any>
): AgentMessage {
  const metadata: AgentMessageMetadata = {};
  let statsText = '✅ Complete';

  // 从 rawResponses 中提取使用统计
  const rawResponses = streamResult.rawResponses as Array<Record<string, unknown>> | undefined;
  if (rawResponses && rawResponses.length > 0) {
    const lastResponse = rawResponses[rawResponses.length - 1];
    const usage = lastResponse.usage as Record<string, unknown> | undefined;

    if (usage) {
      const parts: string[] = [];

      const inputTokens = usage.input_tokens as number | undefined;
      const outputTokens = usage.output_tokens as number | undefined;
      const totalTokens = usage.total_tokens as number | undefined;

      if (inputTokens !== undefined) {
        metadata.inputTokens = inputTokens;
      }
      if (outputTokens !== undefined) {
        metadata.outputTokens = outputTokens;
      }
      if (totalTokens !== undefined) {
        parts.push(`Tokens: ${(totalTokens / 1000).toFixed(1)}k`);
      }

      if (parts.length > 0) {
        statsText += ` | ${parts.join(' | ')}`;
      }
    }
  }

  // 提取最终输出
  const finalOutput = streamResult.finalOutput;
  if (typeof finalOutput === 'string' && finalOutput) {
    // 如果有最终输出，附加到统计文本
    const outputPreview = finalOutput.length > 100
      ? `${finalOutput.slice(0, 100)}...`
      : finalOutput;
    statsText += `\n${outputPreview}`;
  }

  return {
    type: 'result',
    content: statsText,
    role: 'assistant',
    metadata,
    raw: streamResult,
  };
}

/**
 * 解析工具调用的 JSON 参数
 */
function parseToolArguments(args: string | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 格式化工具调用事件用于显示
 */
function formatToolEvent(toolName: string, item: Record<string, unknown>): string {
  const args = parseToolArguments(item.arguments as string | undefined);
  if (!args) {
    return `🔧 ${toolName}`;
  }

  switch (toolName) {
    case 'bash':
    case 'shell': {
      const cmd = args.command as string | undefined;
      return `🔧 Running: ${cmd || '<no command>'}`;
    }
    case 'edit_file':
    case 'write_file': {
      const filePath = args.path as string | undefined || args.file_path as string | undefined;
      return `🔧 Editing: ${filePath || '<unknown file>'}`;
    }
    case 'read_file': {
      const readPath = args.path as string | undefined || args.file_path as string | undefined;
      return `🔧 Reading: ${readPath || '<unknown file>'}`;
    }
    case 'search':
    case 'grep': {
      const pattern = args.pattern as string | undefined || args.query as string | undefined;
      return pattern ? `🔧 Searching for "${pattern}"` : '🔧 Searching';
    }
    case 'glob':
    case 'list_files': {
      const globPattern = args.pattern as string | undefined;
      return `🔧 Finding files: ${globPattern || '<no pattern>'}`;
    }
    default: {
      const str = safeStringify(args, 60);
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
