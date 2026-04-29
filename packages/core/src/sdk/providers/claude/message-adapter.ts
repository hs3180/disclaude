/**
 * Claude SDK 消息适配器
 *
 * 将 Claude SDK 的 SDKMessage 转换为统一的 AgentMessage 类型。
 *
 * 支持两种工具调用格式:
 * 1. 结构化 `tool_use` content blocks (Anthropic 原生 API)
 * 2. XML 文本格式 `<tool_use>` (第三方兼容端点如 GLM 的 fallback)
 *
 * @see Issue #2943 — GLM 端点可能返回 XML 格式的 tool_use
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type {
  AgentMessage,
  AgentMessageMetadata,
  UserInput,
  TextContentBlock,
} from '../../types.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('MessageAdapter');

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

      const content = apiMessage.content as BetaContentBlock[];

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

      // Fallback: 当无结构化 tool_use 但文本中包含 XML tool_use 时，
      // 尝试解析 XML 格式的工具调用。这是第三方端点（如 GLM）的兼容层。
      // @see Issue #2943 — GLM 端点可能返回 XML 文本而非结构化 tool_use
      let detectedXmlTool = false;
      if (toolBlocks.length === 0 && textParts.length > 0) {
        const xmlTool = parseXmlToolUse(textParts.join(''));
        if (xmlTool) {
          detectedXmlTool = true;
          metadata.toolName = xmlTool.name;
          metadata.toolInput = xmlTool.input;
          // Replace content with formatted tool input
          contentParts.length = 0;
          contentParts.push(formatToolInput(xmlTool.name, xmlTool.input as Record<string, unknown>));
          // Append any non-tool-use text after the tool
          const remainingText = xmlTool.remainingText.trim();
          if (remainingText) {
            contentParts.push(remainingText);
          }
          logger.debug(
            { toolName: xmlTool.name, source: 'xml-fallback' },
            'Parsed XML tool_use from text content (third-party endpoint compatibility)'
          );
        }
      }

      return {
        type: (toolBlocks.length > 0 || detectedXmlTool) ? 'tool_use' : 'text',
        content: contentParts.join('\n'),
        role: 'assistant',
        metadata,
        raw: message,
      };
    }

    case 'tool_progress': {
      if ('tool_name' in message && 'elapsed_time_seconds' in message) {
        const toolName = message.tool_name as string;
        const elapsed = message.elapsed_time_seconds as number;
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
      if ('summary' in message) {
        return {
          type: 'tool_result',
          content: `✓ ${message.summary as string}`,
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
        let statsText = '✅ Complete';

        if ('usage' in message && message.usage) {
          const usage = message.usage as {
            total_cost?: number;
            total_tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
          };

          const parts: string[] = [];

          if (usage.total_cost !== undefined) {
            metadata.costUsd = usage.total_cost;
            parts.push(`Cost: $${usage.total_cost.toFixed(4)}`);
          }
          if (usage.total_tokens !== undefined) {
            parts.push(`Tokens: ${(usage.total_tokens / 1000).toFixed(1)}k`);
          }
          if (usage.input_tokens !== undefined) {
            metadata.inputTokens = usage.input_tokens;
          }
          if (usage.output_tokens !== undefined) {
            metadata.outputTokens = usage.output_tokens;
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

      if (message.subtype === 'error_during_execution' && 'errors' in message) {
        const errors = message.errors as string[];
        return {
          type: 'error',
          content: `❌ Error: ${errors.join(', ')}`,
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

// ============================================================================
// XML tool_use 解析 — 第三方端点兼容层
// ============================================================================

/**
 * XML tool_use 解析结果
 */
interface XmlToolUseResult {
  /** 工具名称 */
  name: string;
  /** 工具输入参数 */
  input: Record<string, unknown>;
  /** XML tool_use 标签之后的剩余文本 */
  remainingText: string;
}

/**
 * 从文本中解析 XML 格式的 tool_use 调用
 *
 * 第三方 Claude 兼容端点（如 GLM）可能不返回结构化的 `tool_use` content block，
 * 而是将工具调用嵌入文本中作为 XML 标签返回:
 *
 * 格式1 (SDK system prompt 风格):
 * ```xml
 * <tool_use>
 *   <tool_name>Bash</tool_name>
 *   <tool_input>{"command": "ls -la"}</tool_input>
 * </tool_use>
 * ```
 *
 * 格式2 (Anthropic function_calling 风格):
 * ```xml
 * <tool_use>
 *   <name>Bash</name>
 *   <input>{"command": "ls -la"}</input>
 * </tool_use>
 * ```
 *
 * 格式3 (带 id 的完整格式):
 * ```xml
 * <tool_use id="toolu_xxx">
 *   <name>Bash</name>
 *   <input>{"command": "ls -la"}</input>
 * </tool_use>
 * ```
 *
 * @param text - 可能包含 XML tool_use 的文本
 * @returns 解析结果，如果不是 XML tool_use 则返回 null
 */
export function parseXmlToolUse(text: string): XmlToolUseResult | null {
  if (!text || typeof text !== 'string') {
    return null;
  }

  // Quick pre-check: skip text that definitely doesn't contain tool_use XML
  // Matches both <tool_use> and <tool_use id="...">
  if (!text.includes('<tool_use')) {
    return null;
  }

  // Match <tool_use>...</tool_use> block (with optional attributes like id)
  const toolUseRegex = /<tool_use[^>]*>([\s\S]*?)<\/tool_use>/;
  const toolUseMatch = toolUseRegex.exec(text);
  if (!toolUseMatch) {
    return null;
  }

  const [, innerContent] = toolUseMatch;
  const afterToolUse = text.slice(toolUseMatch.index + toolUseMatch[0].length);

  // Extract tool name — try both <tool_name> and <name> formats
  let name: string | undefined;
  const nameMatch = innerContent.match(/<(?:tool_)?name>([\s\S]*?)<\/(?:tool_)?name>/);
  if (nameMatch) {
    name = nameMatch[1].trim();
  }

  if (!name) {
    return null;
  }

  // Extract tool input — try both <tool_input> and <input> formats
  let input: Record<string, unknown> = {};
  const inputMatch = innerContent.match(/<(?:tool_)?input>([\s\S]*?)<\/(?:tool_)?input>/);
  if (inputMatch) {
    const inputText = inputMatch[1].trim();
    try {
      const parsed = JSON.parse(inputText);
      if (typeof parsed === 'object' && parsed !== null) {
        input = parsed as Record<string, unknown>;
      } else {
        // Scalar value — wrap in a generic key
        input = { value: parsed };
      }
    } catch {
      // JSON parse failed — try key=value format
      input = parseKeyValueInput(inputText);
    }
  }

  return {
    name,
    input,
    remainingText: afterToolUse,
  };
}

/**
 * 解析 key=value 格式的工具输入
 *
 * 某些端点可能返回非 JSON 格式的输入，尝试解析为 key=value 对。
 *
 * @param text - 工具输入文本
 * @returns 解析后的键值对
 */
function parseKeyValueInput(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const pairs = text.split('\n');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : { raw: text };
}
