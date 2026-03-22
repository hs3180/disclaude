/**
 * ACP 消息适配器
 *
 * 将 ACP SessionUpdate 通知转换为统一的 AgentMessage 类型，
 * 使上层代码可以透明地处理来自不同来源的消息。
 *
 * 同时支持将 AgentMessage 转换为 ACP SessionUpdate 格式。
 *
 * @module acp/message-adapter
 */

import type {
  AgentMessage,
  AgentMessageMetadata,
} from '../sdk/types.js';
import type {
  AcpSessionUpdate,
  AcpContentData,
  AcpToolCallData,
  AcpToolOutputData,
  AcpExecPlanData,
  AcpModeUpdateData,
  AcpCompletedData,
} from './types.js';

/**
 * 将 ACP SessionUpdate 转换为 AgentMessage
 *
 * @param update - ACP SessionUpdate 通知
 * @returns AgentMessage（如果通知为空则返回 null）
 */
export function acpUpdateToAgentMessage(update: AcpSessionUpdate): AgentMessage | null {
  const { sessionId, data } = update;
  const metadata: AgentMessageMetadata = {
    sessionId,
  };

  switch (data.type) {
    case 'content': {
      const contentData = data as AcpContentData;
      return {
        type: 'text',
        content: contentData.content,
        role: 'assistant',
        metadata,
      };
    }

    case 'tool_call': {
      const toolData = data as AcpToolCallData;
      return {
        type: 'tool_use',
        content: formatToolCall(toolData.toolName, toolData.input),
        role: 'assistant',
        metadata: {
          ...metadata,
          toolName: toolData.toolName,
          toolInput: toolData.input,
        },
      };
    }

    case 'tool_output': {
      const outputData = data as AcpToolOutputData;
      return {
        type: 'tool_result',
        content: outputData.content,
        role: 'assistant',
        metadata: {
          ...metadata,
          toolName: undefined, // tool_output 不直接携带工具名
          toolOutput: outputData.content,
        },
      };
    }

    case 'exec_plan': {
      const planData = data as AcpExecPlanData;
      const steps = planData.steps.map((s, i) =>
        `${i + 1}. ${s.description}${s.toolName ? ` (${s.toolName})` : ''}`
      ).join('\n');
      return {
        type: 'status',
        content: `📋 Execution Plan:\n${steps}`,
        role: 'assistant',
        metadata,
      };
    }

    case 'mode_update': {
      const modeData = data as AcpModeUpdateData;
      return {
        type: 'status',
        content: `🔄 Mode changed to: ${modeData.mode}`,
        role: 'system',
        metadata,
      };
    }

    case 'completed': {
      const completedData = data as AcpCompletedData;
      return {
        type: completedData.stopReason === 'error' ? 'error' : 'result',
        content: formatStopReason(completedData.stopReason),
        role: 'assistant',
        metadata,
      };
    }

    default:
      return null;
  }
}

/**
 * 将 AgentMessage 转换为 ACP SessionUpdate
 *
 * 用于将 SDK Provider 的输出转换为 ACP 格式，
 * 以便通过 ACP 协议发送给客户端。
 *
 * @param message - AgentMessage
 * @param sessionId - 会话 ID
 * @returns ACP SessionUpdate（如果消息无法转换则返回 null）
 */
export function agentMessageToAcpUpdate(
  message: AgentMessage,
  sessionId: string
): AcpSessionUpdate | null {
  switch (message.type) {
    case 'text': {
      return {
        sessionId,
        type: 'content',
        data: {
          type: 'content',
          contentType: 'text',
          content: message.content,
        } satisfies AcpContentData,
      };
    }

    case 'tool_use': {
      return {
        sessionId,
        type: 'tool_call',
        data: {
          type: 'tool_call',
          toolCallId: message.metadata?.messageId ?? crypto.randomUUID(),
          toolName: message.metadata?.toolName ?? 'unknown',
          input: message.metadata?.toolInput as Record<string, unknown> | undefined,
        } satisfies AcpToolCallData,
      };
    }

    case 'tool_result': {
      return {
        sessionId,
        type: 'tool_output',
        data: {
          type: 'tool_output',
          toolCallId: message.metadata?.messageId ?? '',
          content: message.content,
          isError: false,
        } satisfies AcpToolOutputData,
      };
    }

    case 'result': {
      return {
        sessionId,
        type: 'completed',
        data: {
          type: 'completed',
          stopReason: 'end_turn',
        } satisfies AcpCompletedData,
      };
    }

    case 'error': {
      return {
        sessionId,
        type: 'completed',
        data: {
          type: 'completed',
          stopReason: 'error',
        } satisfies AcpCompletedData,
      };
    }

    case 'status': {
      // 状态消息转换为内容消息
      return {
        sessionId,
        type: 'content',
        data: {
          type: 'content',
          contentType: 'text',
          content: message.content,
        } satisfies AcpContentData,
      };
    }

    default:
      return null;
  }
}

/**
 * 格式化工具调用
 */
function formatToolCall(toolName: string, input?: Record<string, unknown>): string {
  if (!input) {
    return `🔧 ${toolName}`;
  }

  switch (toolName) {
    case 'Bash': {
      const cmd = input.command as string | undefined;
      return `🔧 Running: ${cmd || '<no command>'}`;
    }
    case 'Edit': {
      const filePath = input.file_path as string | undefined;
      return `🔧 Editing: ${filePath || '<unknown file>'}`;
    }
    case 'Read': {
      const path = input.file_path as string | undefined;
      return `🔧 Reading: ${path || '<unknown file>'}`;
    }
    case 'Write': {
      const path = input.file_path as string | undefined;
      return `🔧 Writing: ${path || '<unknown file>'}`;
    }
    case 'Grep': {
      const pattern = input.pattern as string | undefined;
      return pattern ? `🔧 Searching for "${pattern}"` : '🔧 Searching';
    }
    case 'Glob': {
      const pattern = input.pattern as string | undefined;
      return `🔧 Finding files: ${pattern || '<no pattern>'}`;
    }
    default: {
      const str = safeStringify(input, 60);
      return `🔧 ${toolName}: ${str}`;
    }
  }
}

/**
 * 格式化停止原因
 */
function formatStopReason(reason: string): string {
  switch (reason) {
    case 'end_turn':
      return '✅ Turn completed';
    case 'tool_use':
      return '🔄 Waiting for tool response';
    case 'cancelled':
      return '⚠️ Turn cancelled';
    case 'error':
      return '❌ Turn ended with error';
    case 'max_tokens':
      return '⚠️ Max tokens reached';
    default:
      return `Session ended: ${reason}`;
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
