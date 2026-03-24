/**
 * ACP Message Adapter
 *
 * 将 ACP SessionNotification 转换为统一的 AgentMessage 格式。
 * 处理 ACP 协议的各种更新类型（文本块、工具调用、工具更新等）。
 */

import type {
  SessionNotification,
  ContentChunk,
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  Plan as AcpPlan,
  UsageUpdate as AcpUsageUpdate,
} from '@agentclientprotocol/sdk';
import type { AgentMessage, AgentMessageMetadata } from '../sdk/types.js';

/**
 * 将 ACP SessionNotification 转换为 AgentMessage
 *
 * @param notification - ACP session 通知
 * @returns AgentMessage 或 null（如果通知不产生消息）
 */
export function adaptAcpNotification(notification: SessionNotification): AgentMessage | null {
  const { sessionId, update } = notification;
  const baseMetadata: AgentMessageMetadata = {
    sessionId,
  };

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return adaptContentChunk(update, 'assistant', baseMetadata);

    case 'user_message_chunk':
      return adaptContentChunk(update, 'user', baseMetadata);

    case 'agent_thought_chunk':
      // Agent thinking/reasoning - map to text message
      return adaptContentChunk(update, 'assistant', {
        ...baseMetadata,
        toolName: '__thinking__',
      });

    case 'tool_call':
      return adaptToolCall(update, baseMetadata);

    case 'tool_call_update':
      return adaptToolCallUpdate(update, baseMetadata);

    case 'plan':
      return adaptPlanUpdate(update, baseMetadata);

    case 'usage_update':
      return adaptUsageUpdate(update, baseMetadata);

    default:
      // session_info_update, available_commands_update, current_mode_update, config_option_update
      // These are metadata updates, not content messages
      return null;
  }
}

/**
 * 适配内容块更新（文本、图像等）
 */
function adaptContentChunk(
  update: ContentChunk,
  role: 'user' | 'assistant',
  metadata: AgentMessageMetadata
): AgentMessage {
  const content = extractTextContent(update.content);
  return {
    type: 'text',
    content,
    role,
    metadata: {
      ...metadata,
      messageId: update.messageId ?? undefined,
    },
    raw: update,
  };
}

/**
 * 适配工具调用
 */
function adaptToolCall(
  update: AcpToolCall,
  metadata: AgentMessageMetadata
): AgentMessage {
  const status = update.status ?? 'running';
  const isStarted = status === 'running';
  return {
    type: isStarted ? 'tool_use' : 'tool_result',
    content: isStarted
      ? `🔧 ${update.title}`
      : `✅ ${update.title}`,
    role: 'assistant',
    metadata: {
      ...metadata,
      toolName: update.title,
      toolInput: update.rawInput,
    },
    raw: update,
  };
}

/**
 * 适配工具调用更新
 */
function adaptToolCallUpdate(
  update: AcpToolCallUpdate,
  metadata: AgentMessageMetadata
): AgentMessage {
  const title = update.title ?? 'unknown';
  const output = typeof update.rawOutput === 'string'
    ? update.rawOutput
    : JSON.stringify(update.rawOutput);

  return {
    type: 'tool_result',
    content: output,
    role: 'assistant',
    metadata: {
      ...metadata,
      toolName: title,
      toolOutput: update.rawOutput,
    },
    raw: update,
  };
}

/**
 * 适配计划更新
 */
function adaptPlanUpdate(
  update: AcpPlan,
  metadata: AgentMessageMetadata
): AgentMessage {
  const steps = update.entries?.map(entry => {
    const statusIcon = entry.status === 'completed' ? '✅' : entry.status === 'in_progress' ? '🔄' : '⬜';
    return `${statusIcon} ${entry.content}`;
  }).join('\n') ?? '';

  return {
    type: 'status',
    content: `📋 Plan:\n${steps}`,
    role: 'assistant',
    metadata,
    raw: update,
  };
}

/**
 * 适配使用量更新
 */
function adaptUsageUpdate(
  update: AcpUsageUpdate,
  metadata: AgentMessageMetadata
): AgentMessage | null {
  const usedPercent = update.size > 0
    ? ((update.used / update.size) * 100).toFixed(1)
    : '0';

  const costStr = update.cost
    ? ` | $${(update.cost.amount / 100).toFixed(4)} ${update.cost.currency}`
    : '';

  return {
    type: 'status',
    content: `📊 Context: ${update.used}/${update.size} tokens (${usedPercent}%)${costStr}`,
    role: 'assistant',
    metadata: {
      ...metadata,
    },
    raw: update,
  };
}

/**
 * 从 ACP ContentBlock 中提取文本内容
 */
function extractTextContent(content: unknown): string {
  if (!content) return '';

  if (typeof content === 'string') return content;

  if (typeof content === 'object' && content !== null) {
    const block = content as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
    // For non-text blocks, return a summary
    if (block.type) {
      return `[${block.type}]`;
    }
  }

  return String(content);
}

/**
 * 将 ACP stopReason 转换为描述性文本
 */
export function adaptStopReason(stopReason: string): string {
  const reasons: Record<string, string> = {
    end_turn: '正常完成',
    max_tokens: '达到 token 上限',
    max_turn_requests: '达到轮次上限',
    refusal: 'Agent 拒绝执行',
    cancelled: '已取消',
  };
  return reasons[stopReason] ?? stopReason;
}
