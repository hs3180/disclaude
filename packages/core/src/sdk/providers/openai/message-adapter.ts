/**
 * OpenAI Agents SDK 消息适配器
 *
 * 将 OpenAI Agents SDK 的 RunStreamEvent/RunItem 转换为统一的 AgentMessage 类型。
 */

import type {
  AgentMessage,
  AgentMessageMetadata,
} from '../../types.js';
import type {
  RunItem,
  RunItemStreamEvent,
  RunStreamEvent,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '@openai/agents';


/**
 * 适配 OpenAI RunStreamEvent 为统一的 AgentMessage
 */
export function adaptStreamEvent(event: RunStreamEvent): AgentMessage | null {
  switch (event.type) {
    case 'run_item_stream_event': {
      return adaptRunItemEvent(event as RunItemStreamEvent);
    }
    case 'agent_updated_stream_event': {
      return null;
    }
    case 'raw_model_stream_event': {
      return adaptRawModelEvent(event);
    }
    default:
      return null;
  }
}

/**
 * 适配原始模型流事件
 */
function adaptRawModelEvent(event: { data: { type?: string; delta?: string } }): AgentMessage | null {
  if (event.data.type === 'output_text.delta' && event.data.delta) {
    return {
      type: 'text',
      content: event.data.delta,
      role: 'assistant',
    };
  }
  return null;
}

/**
 * 适配 RunItemStreamEvent
 */
function adaptRunItemEvent(event: RunItemStreamEvent): AgentMessage | null {
  const { item } = event;

  switch (item.type) {
    case 'message_output_item': {
      return adaptMessageOutput(item as RunMessageOutputItem);
    }
    case 'tool_call_item': {
      return adaptToolCall(item as RunToolCallItem);
    }
    case 'tool_call_output_item': {
      return adaptToolCallOutput(item as RunToolCallOutputItem);
    }
    default:
      return null;
  }
}

/**
 * 适配消息输出
 */
function adaptMessageOutput(item: RunMessageOutputItem): AgentMessage | null {
  const rawItem = item.rawItem as {
    content?: Array<{ type: string; text?: string }>;
  };

  if (!rawItem.content || rawItem.content.length === 0) {
    return null;
  }

  const contentParts: string[] = [];
  for (const block of rawItem.content) {
    if (block.type === 'output_text' && block.text) {
      contentParts.push(block.text);
    }
  }

  if (contentParts.length === 0) {
    return null;
  }

  return {
    type: 'text',
    content: contentParts.join(''),
    role: 'assistant',
    metadata: {},
    raw: item,
  };
}

/**
 * 适配工具调用
 */
function adaptToolCall(item: RunToolCallItem): AgentMessage | null {
  const rawItem = item.rawItem as {
    name?: string;
    callId?: string;
    arguments?: string;
  };

  if (!rawItem.name) {
    return null;
  }

  const metadata: AgentMessageMetadata = {
    toolName: rawItem.name,
    toolInput: rawItem.arguments,
    messageId: rawItem.callId,
  };

  let content = `🔧 ${rawItem.name}`;
  if (rawItem.arguments) {
    try {
      const args = JSON.parse(rawItem.arguments);
      content = `🔧 ${rawItem.name}: ${safeStringify(args, 60)}`;
    } catch {
      content = `🔧 ${rawItem.name}: ${rawItem.arguments.substring(0, 60)}`;
    }
  }

  return {
    type: 'tool_use',
    content,
    role: 'assistant',
    metadata,
    raw: item,
  };
}

/**
 * 适配工具调用输出
 */
function adaptToolCallOutput(item: RunToolCallOutputItem): AgentMessage | null {
  const rawItem = item.rawItem as {
    callId?: string;
    output?: unknown;
  };

  const metadata: AgentMessageMetadata = {
    toolOutput: rawItem.output,
    messageId: rawItem.callId,
  };

  const outputStr = typeof rawItem.output === 'string'
    ? rawItem.output
    : safeStringify(rawItem.output, 100);

  return {
    type: 'tool_result',
    content: `✓ ${outputStr.substring(0, 200)}${outputStr.length > 200 ? '...' : ''}`,
    role: 'assistant',
    metadata,
    raw: item,
  };
}

/**
 * 适配运行结果为最终 AgentMessage
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptRunResult(result: any): AgentMessage {
  const metadata: AgentMessageMetadata = {};

  try {
    const state = result.state;
    if (state?.usage) {
      const usage = state.usage as { inputTokens?: number; outputTokens?: number; totalCost?: number };
      metadata.inputTokens = usage.inputTokens;
      metadata.outputTokens = usage.outputTokens;
      if (usage.totalCost !== undefined) {
        metadata.costUsd = usage.totalCost;
      } else {
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        metadata.costUsd = (inputTokens / 1_000_000) * 2.5 + (outputTokens / 1_000_000) * 10;
      }
    }
  } catch {
    // Ignore state access errors
  }

  const parts: string[] = ['✅ Complete'];

  if (metadata.inputTokens !== undefined || metadata.outputTokens !== undefined) {
    const costParts: string[] = [];
    if (metadata.costUsd !== undefined) {
      costParts.push(`Cost: $${metadata.costUsd.toFixed(4)}`);
    }
    const totalTokens = (metadata.inputTokens ?? 0) + (metadata.outputTokens ?? 0);
    if (totalTokens > 0) {
      costParts.push(`Tokens: ${(totalTokens / 1000).toFixed(1)}k`);
    }
    if (costParts.length > 0) {
      parts.push(` | ${costParts.join(' | ')}`);
    }
  }

  try {
    const finalOutput = result.finalOutput;
    if (finalOutput !== undefined) {
      const outputStr = typeof finalOutput === 'string'
        ? finalOutput
        : safeStringify(finalOutput, 80);
      if (outputStr) {
        parts.push(`\n${outputStr}`);
      }
    }
  } catch {
    // Ignore
  }

  return {
    type: 'result',
    content: parts.join(''),
    role: 'assistant',
    metadata,
    raw: result,
  };
}

/**
 * 将 RunResult 的 newItems 转换为 AgentMessage 数组
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptRunItems(result: any): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const item of (result.newItems as RunItem[])) {
    const message = adaptRunItem(item);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function adaptRunItem(item: RunItem): AgentMessage | null {
  switch (item.type) {
    case 'message_output_item':
      return adaptMessageOutput(item as RunMessageOutputItem);
    case 'tool_call_item':
      return adaptToolCall(item as RunToolCallItem);
    case 'tool_call_output_item':
      return adaptToolCallOutput(item as RunToolCallOutputItem);
    default:
      return null;
  }
}

function safeStringify(obj: unknown, maxLength: number = 100): string {
  try {
    const str = JSON.stringify(obj);
    return str.length <= maxLength ? str : `${str.slice(0, maxLength - 3)}...`;
  } catch {
    return String(obj);
  }
}
