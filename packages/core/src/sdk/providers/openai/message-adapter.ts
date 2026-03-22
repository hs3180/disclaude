/**
 * OpenAI Agents SDK 消息适配器
 *
 * 将 OpenAI Agents SDK 的 RunStreamEvent / RunItem 转换为统一的 AgentMessage 类型。
 */

import type {
  AgentMessage,
  AgentMessageMetadata,
  UserInput,
} from '../../types.js';

// ============================================================================
// OpenAI SDK 类型定义（最小化本地类型，保持与 SDK 解耦）
// ============================================================================

/** OpenAI 原始模型流事件 */
export interface OpenAIRawModelStreamEvent {
  readonly type: 'raw_model_stream_event';
  data: OpenAIStreamEvent;
}

/** OpenAI StreamEvent（SDK 级别的流事件抽象） */
export interface OpenAIStreamEvent {
  type: string;
  delta?: string;
  event?: unknown;
  [key: string]: unknown;
}

/** OpenAI RunItem 流事件 */
export interface OpenAIRunItemStreamEvent {
  readonly type: 'run_item_stream_event';
  name: OpenAIRunItemStreamEventName;
  item: OpenAIRunItem;
}

/** OpenAI RunItemStreamEvent 事件名称 */
export type OpenAIRunItemStreamEventName =
  | 'message_output_created'
  | 'handoff_requested'
  | 'handoff_occurred'
  | 'tool_called'
  | 'tool_output'
  | 'reasoning_item_created'
  | 'tool_approval_requested';

/** OpenAI RunItem 基础类型 */
export interface OpenAIRunItem {
  readonly type: string;
  rawItem?: {
    name?: string;
    arguments?: string;
    output?: unknown;
    [key: string]: unknown;
  };
  content?: string;
  output?: string | unknown;
  agent?: unknown;
  [key: string]: unknown;
}

/** OpenAI StreamedRunResult */
export interface OpenAIStreamedRunResult extends AsyncIterable<unknown> {
  readonly completed: Promise<void>;
  readonly finalOutput: Promise<unknown>;
  readonly newItems: OpenAIRunItem[];
  readonly history: unknown[];
  readonly input: string | unknown[];
}

/** OpenAI 使用统计（camelCase 格式） */
export interface OpenAIUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** OpenAI RunStreamEvent 联合类型 */
export type OpenAIRunStreamEvent =
  | OpenAIRawModelStreamEvent
  | OpenAIRunItemStreamEvent
  | { type: 'agent_updated_stream_event' };

// ============================================================================
// 流事件适配
// ============================================================================

/**
 * 适配 OpenAI stream event 为统一的 AgentMessage
 *
 * @param event - OpenAI RunStreamEvent
 * @returns 统一的 AgentMessage，如果事件不应生成消息则返回 null
 */
export function adaptStreamEvent(event: unknown): AgentMessage | null {
  if (!event || typeof event !== 'object' || !('type' in event)) {
    return null;
  }

  const e = event as OpenAIRunStreamEvent;

  switch (e.type) {
    case 'raw_model_stream_event': {
      const rawEvent = e as OpenAIRawModelStreamEvent;
      // SDK 级别的 text delta 事件类型为 'output_text_delta'
      if (rawEvent.data?.type === 'output_text_delta' && typeof rawEvent.data.delta === 'string') {
        return {
          type: 'text',
          content: rawEvent.data.delta,
          role: 'assistant',
        };
      }
      return null;
    }

    case 'run_item_stream_event': {
      const itemEvent = e as OpenAIRunItemStreamEvent;
      return adaptRunItem(itemEvent.item, itemEvent.name);
    }

    default:
      return null;
  }
}

/**
 * 适配 OpenAI RunItem 为统一的 AgentMessage
 */
function adaptRunItem(item: OpenAIRunItem, eventName: OpenAIRunItemStreamEventName): AgentMessage | null {
  const metadata: AgentMessageMetadata = {};

  switch (item.type) {
    case 'message_output_item': {
      // 消息输出（RunMessageOutputItem）
      if (typeof item.content === 'string' && item.content) {
        return {
          type: 'text',
          content: item.content,
          role: 'assistant',
          raw: item,
        };
      }
      return null;
    }

    case 'tool_call_item': {
      // 工具调用（RunToolCallItem）
      if (eventName === 'tool_called') {
        const toolName = item.rawItem?.name;
        let toolInput: unknown;
        // 工具参数以 JSON 字符串形式存储在 rawItem.arguments 中
        if (item.rawItem?.arguments) {
          try {
            toolInput = JSON.parse(item.rawItem.arguments);
          } catch {
            toolInput = item.rawItem.arguments;
          }
        }
        metadata.toolName = toolName;
        metadata.toolInput = toolInput;
        return {
          type: 'tool_use',
          content: formatToolInfo(toolName, toolInput),
          role: 'assistant',
          metadata,
          raw: item,
        };
      }
      return null;
    }

    case 'tool_call_output_item': {
      // 工具执行结果（RunToolCallOutputItem）
      metadata.toolName = item.rawItem?.name;
      const output = typeof item.output === 'string'
        ? item.output
        : safeStringify(item.output, 200);
      return {
        type: 'tool_result',
        content: `✓ ${output}`,
        role: 'assistant',
        metadata,
        raw: item,
      };
    }

    default:
      return null;
  }
}

// ============================================================================
// 最终结果适配
// ============================================================================

/**
 * 适配最终运行结果为统一的 result 消息
 */
export function adaptFinalResult(result: OpenAIStreamedRunResult): AgentMessage {
  const metadata: AgentMessageMetadata = {};
  const parts: string[] = ['✅ Complete'];

  // 从 newItems 中提取使用统计
  const usage = extractUsage(result);
  if (usage) {
    metadata.inputTokens = usage.inputTokens;
    metadata.outputTokens = usage.outputTokens;
    parts.push(`Tokens: ${(usage.totalTokens / 1000).toFixed(1)}k`);
  }

  return {
    type: 'result',
    content: parts.join(' | '),
    role: 'assistant',
    metadata,
    raw: result,
  };
}

/**
 * 从运行结果中提取使用统计
 */
function extractUsage(result: OpenAIStreamedRunResult): OpenAIUsage | null {
  // 尝试从 rawResponses 或 message_output 项中提取 usage
  // rawResponses 中包含 response_started/response_done 事件，其中有 usage 数据
  const rawResponses = (result as unknown as Record<string, unknown>).rawResponses as Array<Record<string, unknown>> | undefined;
  if (rawResponses) {
    for (const resp of rawResponses) {
      const usage = resp.usage as OpenAIUsage | undefined;
      if (usage) return usage;
    }
  }

  // 回退：检查 newItems 中的 message_output_item
  for (const item of result.newItems) {
    if (item.type === 'message_output_item') {
      const rawItem = item.rawItem as Record<string, unknown> | undefined;
      if (rawItem?.usage) {
        const usage = rawItem.usage as OpenAIUsage;
        if (usage) return usage;
      }
    }
  }
  return null;
}

// ============================================================================
// 用户输入适配
// ============================================================================

/**
 * 适配统一 UserInput 为 OpenAI Message 格式
 */
export function adaptUserInput(input: UserInput): { role: 'user'; content: string | unknown[] } {
  return {
    role: 'user',
    content: input.content as string | unknown[],
  };
}

// ============================================================================
// 工具辅助函数
// ============================================================================

/**
 * 格式化工具信息用于显示
 */
function formatToolInfo(toolName: string | undefined, input: unknown): string {
  if (!toolName) return '🔧 Running tool';

  if (input && typeof input === 'object') {
    const inp = input as Record<string, unknown>;
    switch (toolName) {
      case 'Bash':
      case 'bash':
        return `🔧 Running: ${inp.command || '<no command>'}`;
      case 'Edit':
      case 'edit':
        return `🔧 Editing: ${inp.file_path || inp.filePath || '<unknown file>'}`;
      case 'Read':
      case 'read':
        return `🔧 Reading: ${inp.file_path || '<unknown file>'}`;
      case 'Write':
      case 'write':
        return `🔧 Writing: ${inp.file_path || '<unknown file>'}`;
      case 'Grep':
      case 'grep':
        return `🔧 Searching for "${inp.pattern || ''}"`;
      case 'Glob':
      case 'glob':
        return `🔧 Finding files: ${inp.pattern || '<no pattern>'}`;
      default: {
        const str = safeStringify(input, 60);
        return `🔧 ${toolName}: ${str}`;
      }
    }
  }

  return `🔧 ${toolName}`;
}

/**
 * 安全地序列化对象
 */
function safeStringify(obj: unknown, maxLength: number = 100): string {
  try {
    const str = JSON.stringify(obj);
    if (str.length <= maxLength) return str;
    return `${str.slice(0, maxLength - 3)}...`;
  } catch {
    return String(obj);
  }
}
