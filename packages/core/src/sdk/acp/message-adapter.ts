/**
 * ACP 消息适配器
 *
 * 在 ACP 协议消息和统一 AgentMessage 类型之间进行转换。
 * 提供双向转换能力，使 ACP Provider 能够复用现有的消息处理逻辑。
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

import type {
  AgentMessage,
  AgentMessageMetadata,
  UserInput,
} from '../types.js';
import type {
  AcpContentBlock,
  AcpTaskMessage,
} from './types.js';
import type { ContentBlock } from '../types.js';

// ============================================================================
// AgentMessage → ACP 转换
// ============================================================================

/**
 * 将统一的 UserInput 转换为 ACP 任务消息
 *
 * @param input - 统一的用户输入
 * @returns ACP 任务消息
 */
export function userInputToAcpMessage(input: UserInput): AcpTaskMessage {
  const content = inputToAcpContent(input.content);
  return {
    role: 'user',
    content,
  };
}

/**
 * 将统一输入内容转换为 ACP 内容块
 */
function inputToAcpContent(
  content: string | ContentBlock[],
): AcpContentBlock | AcpContentBlock[] {
  if (typeof content === 'string') {
    return { type: 'text', text: content };
  }

  return content.map(blockToAcpContent);
}

/**
 * 将统一内容块转换为 ACP 内容块
 */
function blockToAcpContent(block: ContentBlock): AcpContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image') {
    return { type: 'image', data: block.data, mimeType: block.mimeType };
  }

  // 未知类型转为文本
  return { type: 'text', text: JSON.stringify(block) };
}

// ============================================================================
// ACP → AgentMessage 转换
// ============================================================================

/**
 * 将 ACP 任务消息转换为统一的 AgentMessage 数组
 *
 * 多个文本块会被合并为一条消息；工具使用块保持独立。
 *
 * @param message - ACP 任务消息
 * @returns 统一的 AgentMessage 数组
 */
export function acpMessageToAgentMessages(
  message: AcpTaskMessage,
): AgentMessage[] {
  const contentBlocks = Array.isArray(message.content)
    ? message.content
    : [message.content];
  const results: AgentMessage[] = [];

  let hasToolUse = false;

  for (const block of contentBlocks) {
    const agentMessage = acpBlockToAgentMessage(block, message.role);
    if (agentMessage) {
      if (block.type === 'tool_use') {
        hasToolUse = true;
      }
      results.push(agentMessage);
    }
  }

  // 如果没有工具使用，合并所有文本为一条消息
  if (!hasToolUse && results.length > 1) {
    const mergedContent = results
      .map((m) => m.content)
      .filter((c) => c.length > 0)
      .join('\n');

    return [
      {
        type: 'text',
        content: mergedContent,
        role: message.role,
      },
    ];
  }

  return results.length > 0
    ? results
    : [
        {
          type: 'text',
          content: '',
          role: message.role,
        },
      ];
}

/**
 * 将 ACP 内容块转换为统一的 AgentMessage
 */
function acpBlockToAgentMessage(
  block: AcpContentBlock,
  role: 'user' | 'assistant' | 'system',
): AgentMessage | null {
  switch (block.type) {
    case 'text': {
      if (!block.text) {
        return null;
      }
      return {
        type: 'text',
        content: block.text,
        role,
      };
    }

    case 'tool_use': {
      const metadata: AgentMessageMetadata = {
        toolName: block.name,
        toolInput: block.input,
        messageId: block.id,
      };
      return {
        type: 'tool_use',
        content: `\u{1F527} ${block.name}`,
        role,
        metadata,
      };
    }

    case 'tool_result': {
      const metadata: AgentMessageMetadata = {
        toolOutput: block.content,
        messageId: block.toolUseId,
      };
      return {
        type: 'tool_result',
        content: block.isError
          ? `\u274C ${block.content}`
          : `\u2713 ${block.content}`,
        role,
        metadata,
      };
    }

    case 'image': {
      return {
        type: 'text',
        content: `[Image: ${block.mimeType}]`,
        role,
      };
    }

    default: {
      return null;
    }
  }
}
