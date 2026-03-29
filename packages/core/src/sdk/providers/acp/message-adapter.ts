/**
 * ACP 消息适配器
 *
 * 在 ACP 协议消息与统一的 AgentMessage 类型之间进行转换。
 * 同时处理 ACP 任务通知到 AgentMessage 的转换。
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import type { AgentMessage, AgentMessageMetadata, UserInput } from '../../types.js';
import type {
  AcpMessage,
  AcpTaskNotificationParams,
  AcpTextNotificationData,
  AcpToolUseNotificationData,
  AcpToolProgressNotificationData,
  AcpToolResultNotificationData,
  AcpCompleteNotificationData,
  AcpErrorNotificationData,
} from './types.js';

/**
 * 将统一的 UserInput 转换为 ACP 消息格式
 *
 * @param input - 统一的用户输入
 * @returns ACP 消息
 */
export function userInputToAcpMessage(input: UserInput): AcpMessage {
  return {
    role: 'user',
    content: input.content,
  };
}

/**
 * 将统一的输入（字符串或 UserInput 数组）转换为 ACP 消息数组
 *
 * @param input - 统一输入
 * @returns ACP 消息数组
 */
export function adaptInputToAcp(input: string | UserInput[]): AcpMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  return input.map(userInputToAcpMessage);
}

/**
 * 将 ACP 任务通知转换为统一的 AgentMessage
 *
 * @param notification - ACP 任务通知参数
 * @returns 统一的 AgentMessage，如果通知类型无法识别则返回 null
 */
export function acpNotificationToAgentMessage(
  notification: AcpTaskNotificationParams
): AgentMessage | null {
  const metadata: AgentMessageMetadata = {
    sessionId: notification.taskId,
  };

  switch (notification.type) {
    case 'text': {
      const data = notification.data as AcpTextNotificationData;
      return {
        type: 'text',
        content: data.text,
        role: 'assistant',
        metadata,
      };
    }

    case 'tool_use': {
      const data = notification.data as AcpToolUseNotificationData;
      metadata.toolName = data.name;
      metadata.toolInput = data.input;
      return {
        type: 'tool_use',
        content: formatToolUse(data.name, data.input),
        role: 'assistant',
        metadata,
      };
    }

    case 'tool_progress': {
      const data = notification.data as AcpToolProgressNotificationData;
      metadata.toolName = data.toolName;
      metadata.elapsedMs = data.elapsedMs;
      return {
        type: 'tool_progress',
        content: `⏳ Running ${data.toolName} (${(data.elapsedMs / 1000).toFixed(1)}s)`,
        role: 'assistant',
        metadata,
      };
    }

    case 'tool_result': {
      const data = notification.data as AcpToolResultNotificationData;
      return {
        type: 'tool_result',
        content: data.isError
          ? `❌ Tool error: ${data.content}`
          : `✓ ${data.content}`,
        role: 'assistant',
        metadata,
      };
    }

    case 'complete': {
      const data = notification.data as AcpCompleteNotificationData;
      let content = '✅ Complete';

      if (data.usage) {
        const parts: string[] = [];
        const {usage} = data;

        if (usage.costUsd !== undefined) {
          metadata.costUsd = usage.costUsd;
          parts.push(`Cost: $${usage.costUsd.toFixed(4)}`);
        }
        if (usage.totalTokens !== undefined) {
          parts.push(`Tokens: ${(usage.totalTokens / 1000).toFixed(1)}k`);
        }
        if (usage.inputTokens !== undefined) {
          metadata.inputTokens = usage.inputTokens;
        }
        if (usage.outputTokens !== undefined) {
          metadata.outputTokens = usage.outputTokens;
        }

        if (parts.length > 0) {
          content += ` | ${parts.join(' | ')}`;
        }
      }

      if (data.stopReason) {
        metadata.stopReason = data.stopReason;
      }

      return {
        type: 'result',
        content,
        role: 'assistant',
        metadata,
      };
    }

    case 'error': {
      const data = notification.data as AcpErrorNotificationData;
      return {
        type: 'error',
        content: `❌ Error: ${data.message} (code: ${data.code})`,
        role: 'assistant',
        metadata,
      };
    }

    default: {
      return null;
    }
  }
}

/**
 * 格式化工具调用信息用于显示
 */
function formatToolUse(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') {
    return `🔧 ${toolName}`;
  }

  const params = input as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      const cmd = params.command as string | undefined;
      return `🔧 Running: ${cmd || '<no command>'}`;
    }
    case 'Edit': {
      const filePath = params.file_path as string | undefined ?? params.filePath as string | undefined;
      return `🔧 Editing: ${filePath || '<unknown file>'}`;
    }
    case 'Read': {
      const readPath = params.file_path as string | undefined;
      return `🔧 Reading: ${readPath || '<unknown file>'}`;
    }
    case 'Write': {
      const writePath = params.file_path as string | undefined;
      return `🔧 Writing: ${writePath || '<unknown file>'}`;
    }
    case 'Grep': {
      const pattern = params.pattern as string | undefined;
      return pattern ? `🔧 Searching for "${pattern}"` : '🔧 Searching';
    }
    case 'Glob': {
      const globPattern = params.pattern as string | undefined;
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
