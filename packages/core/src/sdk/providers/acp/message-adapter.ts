/**
 * ACP 消息适配器
 *
 * 在 ACP 协议消息格式与项目统一的 AgentMessage 类型之间进行转换。
 * 这是 ACP 协议层的核心适配组件，供后续 ACP Provider (PR B) 使用。
 *
 * @module sdk/providers/acp/message-adapter
 */

import type {
  AgentMessage,
  AgentMessageMetadata,
  UserInput,
  ContentBlock,
} from '../../types.js';
import type {
  ACPMessage,
  ACPMessagePart,
  ACPEvent,
  ACPRun,
} from './types.js';

// ============================================================================
// ACP → AgentMessage 转换
// ============================================================================

/**
 * 从 ACP SSE 事件生成统一的 AgentMessage
 *
 * 将 ACP 流式事件转换为项目统一的 AgentMessage 格式，
 * 使上层业务代码无需了解 ACP 协议细节。
 *
 * @param event - ACP SSE 事件
 * @returns 统一的 AgentMessage，或 null 表示应跳过该事件
 */
export function adaptACPEvent(event: ACPEvent): AgentMessage | null {
  switch (event.type) {
    case 'message.created':
    case 'message.completed': {
      const text = extractTextFromACPMessage(event.message);
      if (!text) {
        return null;
      }
      return {
        type: 'text',
        content: text,
        role: adaptACPRole(event.message.role),
        metadata: extractMetadataFromACPMessage(event.message),
        raw: event,
      };
    }

    case 'message.part': {
      return adaptACPMessagePart(event.part);
    }

    case 'run.created':
    case 'run.in-progress': {
      return {
        type: 'status',
        content: `Run ${event.run.run_id}: ${event.run.status}`,
        role: 'system',
        metadata: { sessionId: event.run.session_id, messageId: event.run.run_id },
        raw: event,
      };
    }

    case 'run.awaiting': {
      return {
        type: 'status',
        content: 'Agent awaiting input...',
        role: 'system',
        metadata: { sessionId: event.run.session_id, messageId: event.run.run_id },
        raw: event,
      };
    }

    case 'run.completed': {
      const text = extractTextFromRun(event.run);
      const metadata: AgentMessageMetadata = {
        sessionId: event.run.session_id,
        messageId: event.run.run_id,
      };
      return {
        type: 'result',
        content: text || '✅ Run completed',
        role: 'assistant',
        metadata,
        raw: event,
      };
    }

    case 'run.cancelled': {
      return {
        type: 'result',
        content: '⚠️ Run cancelled',
        role: 'assistant',
        metadata: { sessionId: event.run.session_id, messageId: event.run.run_id },
        raw: event,
      };
    }

    case 'run.failed': {
      const errorMsg = event.run.error?.message ?? 'Unknown error';
      return {
        type: 'error',
        content: `❌ Run failed: ${errorMsg}`,
        role: 'assistant',
        metadata: { sessionId: event.run.session_id, messageId: event.run.run_id },
        raw: event,
      };
    }

    case 'error': {
      return {
        type: 'error',
        content: `❌ ACP error: ${event.error.message}`,
        role: 'system',
        raw: event,
      };
    }

    default:
      return null;
  }
}

/**
 * 从 ACP Run 的输出消息中提取文本
 */
function extractTextFromRun(run: ACPRun): string {
  return run.output
    .map(msg => extractTextFromACPMessage(msg))
    .filter(Boolean)
    .join('\n');
}

/**
 * 从 ACP MessagePart 生成 AgentMessage
 */
function adaptACPMessagePart(part: ACPMessagePart): AgentMessage | null {
  // 检查轨迹元数据（工具调用）
  if (part.metadata?.kind === 'trajectory') {
    const trajectory = part.metadata;
    return {
      type: trajectory.tool_name ? 'tool_use' : 'text',
      content: part.content ?? '',
      role: 'assistant',
      metadata: {
        toolName: trajectory.tool_name,
        toolInput: trajectory.tool_input,
        toolOutput: trajectory.tool_output,
      },
      raw: part,
    };
  }

  // 普通文本部分
  if (part.content_type.startsWith('text/')) {
    return {
      type: 'text',
      content: part.content ?? '',
      role: 'assistant',
      raw: part,
    };
  }

  // 非文本部分（图片等）跳过
  return null;
}

/**
 * 从 ACP Message 中提取文本内容
 */
function extractTextFromACPMessage(message: ACPMessage): string {
  return message.parts
    .filter(part => part.content_type.startsWith('text/') && part.content)
    .map(part => part.content as string)
    .join('');
}

/**
 * 从 ACP Message 的第一个包含轨迹元数据的部分中提取元数据
 */
function extractMetadataFromACPMessage(message: ACPMessage): AgentMessageMetadata {
  for (const part of message.parts) {
    if (part.metadata?.kind === 'trajectory') {
      return {
        toolName: part.metadata.tool_name,
        toolInput: part.metadata.tool_input,
        toolOutput: part.metadata.tool_output,
      };
    }
  }
  return {};
}

/**
 * 适配 ACP 角色为项目统一角色
 */
function adaptACPRole(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'user') {
    return 'user';
  }
  if (role.startsWith('agent')) {
    return 'assistant';
  }
  return 'system';
}

// ============================================================================
// AgentMessage/UserInput → ACP 转换
// ============================================================================

/**
 * 将统一的 UserInput 转换为 ACP Message
 *
 * @param input - 用户输入（字符串或 UserInput 数组）
 * @returns ACP Message 数组
 */
export function toACPMessages(input: string | UserInput[]): ACPMessage[] {
  if (typeof input === 'string') {
    return [stringToACPMessage(input)];
  }

  return input.map(userInputToACPMessage);
}

/**
 * 将字符串转换为 ACP Message
 */
function stringToACPMessage(text: string): ACPMessage {
  return {
    role: 'user',
    parts: [{
      content_type: 'text/plain',
      content: text,
    }],
  };
}

/**
 * 将 UserInput 转换为 ACP Message
 */
function userInputToACPMessage(input: UserInput): ACPMessage {
  if (typeof input.content === 'string') {
    return {
      role: 'user',
      parts: [{
        content_type: 'text/plain',
        content: input.content,
      }],
    };
  }

  // ContentBlock 数组
  const parts: ACPMessagePart[] = input.content.map(contentBlockToACPMessagePart);
  return {
    role: 'user',
    parts,
  };
}

/**
 * 将 ContentBlock 转换为 ACP MessagePart
 */
function contentBlockToACPMessagePart(block: ContentBlock): ACPMessagePart {
  if (block.type === 'text') {
    return {
      content_type: 'text/plain',
      content: block.text,
    };
  }

  // 图像块
  return {
    content_type: block.mimeType,
    content: block.data,
    content_encoding: 'base64',
  };
}
