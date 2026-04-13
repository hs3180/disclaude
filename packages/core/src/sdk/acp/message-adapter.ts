/**
 * ACP 消息适配器
 *
 * 将 ACP 协议的 session/update 通知映射为统一的 AgentMessage。
 * 遵循与 claude/message-adapter.ts 相同的设计模式。
 *
 * 映射关系（Issue #2310）：
 * | ACP sessionUpdate              | AgentMessage.type |
 * |--------------------------------|-------------------|
 * | agent_message_chunk            | text              |
 * | tool_call                      | tool_use          |
 * | tool_call_update (in_progress) | tool_progress     |
 * | tool_call_update (completed)   | tool_result       |
 * | plan                           | status            |
 *
 * @module sdk/acp/message-adapter
 */

import type { AgentMessage, AgentMessageMetadata } from '../types.js';
import type {
  AcpSessionUpdate,
  AcpAgentMessageChunkUpdate,
  AcpToolCallUpdate,
  AcpPlanUpdate,
  AcpContentBlock,
  AcpPromptResult,
} from './types.js';

// ============================================================================
// 类型守卫
// ============================================================================

/** 判断是否为 agent_message_chunk 更新 */
function isAgentMessageChunk(
  update: AcpSessionUpdate,
): update is AcpAgentMessageChunkUpdate {
  return update.sessionUpdate === 'agent_message_chunk';
}

/** 判断是否为 tool_call / tool_call_update 更新 */
function isToolCallUpdate(
  update: AcpSessionUpdate,
): update is AcpToolCallUpdate {
  return (
    update.sessionUpdate === 'tool_call' ||
    update.sessionUpdate === 'tool_call_update'
  );
}

/** 判断是否为 plan 更新 */
function isPlanUpdate(update: AcpSessionUpdate): update is AcpPlanUpdate {
  return update.sessionUpdate === 'plan';
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 从 ACP 内容块中提取文本 */
function extractText(content?: AcpContentBlock): string {
  if (!content) {
    return '';
  }
  if (content.type === 'text') {
    return content.text;
  }
  // 图像块：返回占位符
  if (content.type === 'image') {
    return `[image: ${content.mimeType}, ${content.data.length} bytes]`;
  }
  return '';
}

/**
 * 安全地序列化对象用于显示
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

// ============================================================================
// 消息映射
// ============================================================================

/**
 * 将 ACP session/update 中的 update 映射为 AgentMessage。
 *
 * @param update - ACP session/update 的 update 字段
 * @returns AgentMessage，如果 update 类型未知则返回 undefined
 */
export function adaptSessionUpdate(update: AcpSessionUpdate): AgentMessage | undefined {
  if (isAgentMessageChunk(update)) {
    return adaptAgentMessageChunk(update);
  }

  if (isToolCallUpdate(update)) {
    return adaptToolCallUpdate(update);
  }

  if (isPlanUpdate(update)) {
    return adaptPlanUpdate(update);
  }

  // 未知 sessionUpdate 类型 — 安全忽略
  return undefined;
}

/**
 * 将 ACP prompt result（session/prompt 的 result 响应）映射为 AgentMessage。
 */
export function adaptPromptResult(result: AcpPromptResult): AgentMessage {
  const metadata: AgentMessageMetadata = {};

  const parts: string[] = ['✅ Complete'];

  if (result.usage) {
    metadata.inputTokens = result.usage.inputTokens;
    metadata.outputTokens = result.usage.outputTokens;
    parts.push(`Input: ${(result.usage.inputTokens / 1000).toFixed(1)}k tokens`);
    parts.push(`Output: ${(result.usage.outputTokens / 1000).toFixed(1)}k tokens`);
  }

  if (result.stopReason) {
    metadata.stopReason = result.stopReason;
  }

  return {
    type: 'result',
    content: parts.join(' | '),
    role: 'assistant',
    metadata,
  };
}

// ============================================================================
// 内部适配函数
// ============================================================================

/** 适配 agent_message_chunk */
function adaptAgentMessageChunk(update: AcpAgentMessageChunkUpdate): AgentMessage {
  return {
    type: 'text',
    content: extractText(update.content),
    role: 'assistant',
    raw: update,
  };
}

/** 适配 tool_call / tool_call_update */
function adaptToolCallUpdate(update: AcpToolCallUpdate): AgentMessage {
  const metadata: AgentMessageMetadata = {};

  if (update.toolName) {
    metadata.toolName = update.toolName;
  }
  if (update.toolCallId) {
    metadata.messageId = update.toolCallId;
  }

  // tool_call（新工具调用开始）
  if (update.sessionUpdate === 'tool_call') {
    const toolName = update.toolName || 'unknown';
    const toolInput = update.content?.type === 'text'
      ? update.content.text
      : undefined;

    if (toolInput) {
      // 尝试解析为 JSON 以获取更好的显示
      try {
        const parsed = JSON.parse(toolInput);
        metadata.toolInput = parsed;
      } catch {
        metadata.toolInput = toolInput;
      }
    }

    return {
      type: 'tool_use',
      content: `🔧 ${toolName}`,
      role: 'assistant',
      metadata,
      raw: update,
    };
  }

  // tool_call_update
  const {state} = update;

  // in_progress → tool_progress
  if (state === 'in_progress') {
    const toolName = update.toolName || 'unknown';
    return {
      type: 'tool_progress',
      content: `⏳ Running ${toolName}...`,
      role: 'assistant',
      metadata,
      raw: update,
    };
  }

  // completed → tool_result
  if (state === 'completed') {
    const toolName = update.toolName || 'unknown';
    const outputText = extractText(update.content);

    if (outputText) {
      metadata.toolOutput = outputText;
    }

    return {
      type: 'tool_result',
      content: outputText ? `✓ ${toolName}: ${safeStringify(outputText, 80)}` : `✓ ${toolName}`,
      role: 'assistant',
      metadata,
      raw: update,
    };
  }

  // 其他 state（如 pending、error 等）— 作为 tool_progress 显示
  return {
    type: 'tool_progress',
    content: extractText(update.content) || `🔧 ${update.toolName || 'tool'}: ${state || 'unknown state'}`,
    role: 'assistant',
    metadata,
    raw: update,
  };
}

/** 适配 plan 更新 */
function adaptPlanUpdate(update: AcpPlanUpdate): AgentMessage {
  const title = update.title || 'Plan';
  const content = extractText(update.content);

  return {
    type: 'status',
    content: content || `📋 ${title}`,
    role: 'system',
    raw: update,
  };
}
