/**
 * Claude SDK 消息适配器
 *
 * 将 Claude SDK 的 SDKMessage 转换为统一的 AgentMessage 类型。
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type {
  AgentMessage,
  AgentMessageMetadata,
  UserInput,
  TextContentBlock,
} from '../../types.js';

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

      // apiMessage.content 已由上方 Array.isArray 守卫确认为数组。
      // TypeScript 通过 switch 将 message 收窄为 SDKAssistantMessage，
      // 因此 apiMessage (BetaMessage) 的 content 类型为 Array<BetaContentBlock>。
      // Array.isArray() 返回类型为 `x is any[]`，丢失了元素类型信息，
      // 这里使用类型注解（非 as 断言）恢复精确类型。
      const { content }: { content: BetaContentBlock[] } = apiMessage;

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

      return {
        type: toolBlocks.length > 0 ? 'tool_use' : 'text',
        content: contentParts.join('\n'),
        role: 'assistant',
        metadata,
        raw: message,
      };
    }

    case 'tool_progress': {
      // TypeScript 通过 switch 将 message 收窄为 SDKToolProgressMessage，
      // tool_name (string) 和 elapsed_time_seconds (number) 已有明确类型。
      // 保留属性守卫以防御运行时数据与 SDK 类型不一致的情况。
      if (message.tool_name !== undefined && message.tool_name !== null
          && message.elapsed_time_seconds !== undefined && message.elapsed_time_seconds !== null) {
        const toolName = message.tool_name;
        const elapsed = message.elapsed_time_seconds;
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
      // TypeScript 通过 switch 将 message 收窄为 SDKToolUseSummaryMessage，
      // summary 字段类型为 string，无需类型断言。
      // 保留属性守卫以防御运行时数据与 SDK 类型不一致的情况。
      if (message.summary !== undefined && message.summary !== null) {
        return {
          type: 'tool_result',
          content: `✓ ${message.summary}`,
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
      // Issue #4320 (part 2): extract SDK result observability fields for ALL
      // result subtypes, not just success. A premature end via error_max_turns
      // (or error_max_budget_usd / error_max_structured_output_retries) is
      // exactly the case where num_turns / duration are most diagnostic —
      // "ran N turns / M ms before hitting the limit" — so this is hoisted
      // above the subtype branches so every result path carries the metadata.
      // stop_reason is included here for the same reason (SDKResultError also
      // declares stop_reason / num_turns / duration_* as required fields, so the
      // access is type-safe on the full SDKResultMessage union). Log-only
      // metadata; the user-facing stats line is unchanged. Runtime guards mirror
      // the rest of this handler (defend against runtime data diverging from
      // the SDK type declarations).
      if (message.stop_reason) {
        metadata.stopReason = message.stop_reason;
      }
      if (typeof message.num_turns === 'number') {
        metadata.numTurns = message.num_turns;
      }
      if (typeof message.duration_ms === 'number') {
        metadata.durationMs = message.duration_ms;
      }
      if (typeof message.duration_api_ms === 'number') {
        metadata.durationApiMs = message.duration_api_ms;
      }

      if (message.subtype === 'success') {
        // TypeScript 通过 subtype === 'success' 将 message 收窄为 SDKResultSuccess。
        // SDKResultSuccess 包含 usage: NonNullableUsage 和 total_cost_usd: number。
        let statsText = '✅ Complete';

        if ('usage' in message && message.usage) {
          const { usage } = message;

          const parts: string[] = [];

          // SDKResultSuccess.total_cost_usd 是 SDK 标准字段；
          // 部分运行时数据可能将 cost 放在 usage.total_cost 中（非 SDK 类型定义）。
          // 使用运行时检查优先读取 total_cost_usd，回退到 usage.total_cost。
          const costUsd = message.total_cost_usd
            ?? ('total_cost' in usage ? usage.total_cost as number : undefined);
          if (costUsd !== undefined && costUsd > 0) {
            metadata.costUsd = costUsd;
            parts.push(`Cost: $${costUsd.toFixed(4)}`);
          }

          // NonNullableUsage 提供 input_tokens 和 output_tokens (number 类型)
          const inputTokens = usage.input_tokens as number | undefined;
          const outputTokens = usage.output_tokens as number | undefined;
          const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
          if (totalTokens > 0) {
            parts.push(`Tokens: ${(totalTokens / 1000).toFixed(1)}k`);
          }
          if (inputTokens !== undefined) {
            metadata.inputTokens = inputTokens;
          }
          if (outputTokens !== undefined) {
            metadata.outputTokens = outputTokens;
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

      // SDKResultError.subtype 包含 'error_during_execution' 等多种错误类型，
      // errors 字段类型为 string[]，无需类型断言。
      if (message.subtype === 'error_during_execution' && 'errors' in message) {
        return {
          type: 'error',
          content: `❌ Error: ${message.errors.join(', ')}`,
          role: 'assistant',
          metadata,
          raw: message,
        };
      }

      // Issue #4378: error_max_* 终止型错误 subtype。SDK 因撞到上限（轮次 / 预算 /
      // 结构化输出重试）而结束本次 turn —— 这是「合法终止」而非「崩溃」。此前这些
      // subtype 落到下方兜底变成空 type:'text'，chat-agent 见到 type:'text' 便跳过
      // result 分支，把正常的流结束误判成「意外崩溃」→ 触发虚假自动重启
      // （「⚠️ 会话遇到错误，正在重新连接」），且 turn-complete 日志（带 num_turns /
      // duration）从不打印 —— 正是 #4320 想诊断的「提前结束」场景却最不可见。
      //
      // 镜像 stall 终止型 result 的既有范式（#3706）：发 type:'result' + terminatedReason
      // 标记。这样 chat-agent 的 result 分支正常触发（turn-complete 日志带上
      // num_turns / duration / stopReason、turn 正常 resolve、不触发虚假重启），
      // terminatedReason 让 follow-up 能像 stall 检查（chat-agent.ts 的
      // `parsed.terminatedReason === 'stall'`）一样在此 recordFailure 而不重启。
      // 注意 content 非空且不以 '✅ Complete' 开头 → 会被当成可见输出计数，避免被
      // #4194 的空-turn 检测误判（max-turns ≠ 空 turn）。
      const maxTermination = adaptMaxTerminationResult(message.subtype);
      if (maxTermination) {
        return {
          type: 'result',
          content: maxTermination.content,
          role: 'assistant',
          metadata: { ...metadata, terminatedReason: maxTermination.terminatedReason },
          raw: message,
        };
      }

      // 真正未识别的 subtype 落到此兜底：保持空内容（避免被 chat-agent 当作用户可见
      // 回复），但携带上面提取的 metadata 供诊断。
      return {
        type: 'text',
        content: '',
        role: 'assistant',
        metadata,
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
        // SDK 0.3.x: 'requesting' status indicates the model is processing
        if ('status' in message && message.status === 'requesting') {
          return {
            type: 'status',
            content: '🤔 Thinking...',
            role: 'system',
            metadata,
            raw: message,
          };
        }
      }

      // SDK 0.3.174+: model_refusal_fallback system message when primary model
      // refuses and the turn is retried on a fallback model
      if (message.subtype === 'model_refusal_fallback') {
        const fallbackModel = 'fallback_model' in message
          ? String(message.fallback_model)
          : 'alternative';
        return {
          type: 'status',
          content: `⚠️ Model fallback: retrying with ${fallbackModel}`,
          role: 'system',
          metadata,
          raw: message,
        };
      }

      // 保留 system subtype 到 metadata 供诊断(content 必须保持空 ——
      // chat-agent.ts:1065 会对任何非空 content 调 sendMessage 发给用户)。
      // 根因记录:GLM + Agent Teams 会产生海量未识别 system 消息(task_started/
      // task_progress/teammate_* 等),此前被无差别丢弃成空 text,丢失了诊断信息。
      return {
        type: 'text',
        content: '',
        role: 'system',
        metadata: message.subtype ? { ...metadata, systemSubtype: message.subtype } : metadata,
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
 * Issue #4378: 把 SDK `error_max_*` 终止型 result subtype 映射为「用户可见提示 +
 * terminatedReason 标记」，若 subtype 不是已知的三种上限终止之一则返回 undefined
 * （交由调用方的空-text 兜底处理）。
 *
 * 仅覆盖三种「撞上限」的 SDK 终止型错误 subtype —— `error_during_execution` 有自己的
 * 分支（上方的 type:'error'），其它未识别 subtype 走空-text 兜底。提示文案为中文，
 * 与同类的 stall 终止提示（provider.ts 的 STALL_TERMINATE_NOTICE）口径一致。
 */
function adaptMaxTerminationResult(
  subtype: string,
): { content: string; terminatedReason: 'max_turns' | 'max_budget_usd' | 'max_structured_output_retries' } | undefined {
  switch (subtype) {
    case 'error_max_turns':
      return {
        content: '⚠️ 已达最大轮次上限，本次响应提前结束。',
        terminatedReason: 'max_turns',
      };
    case 'error_max_budget_usd':
      return {
        content: '⚠️ 已达费用预算上限，本次响应提前结束。',
        terminatedReason: 'max_budget_usd',
      };
    case 'error_max_structured_output_retries':
      return {
        content: '⚠️ 结构化输出重试次数耗尽，本次响应提前结束。',
        terminatedReason: 'max_structured_output_retries',
      };
    default:
      return undefined;
  }
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
    case 'TaskCreate': {
      // Issue #4200: SDK TaskCreateInput has `subject` + `description` (the old
      // code read a non-existent `content` field, so it always showed
      // "<no description>"). Surface both so the user can see what was created.
      // Wording stays English to match the sibling branches above (Bash/Edit/
      // Read/Write/Grep/Glob); localize the whole function together if needed.
      const subject = input.subject as string | undefined;
      const description = input.description as string | undefined;
      if (subject) {
        return description
          ? `🔧 Creating task: ${subject} (${truncateText(description)})`
          : `🔧 Creating task: ${subject}`;
      }
      return `🔧 Creating task: ${description ? truncateText(description) : '<no description>'}`;
    }
    case 'TaskUpdate': {
      // Issue #4200: include the task content (subject/activeForm/description),
      // not just the task id + status. SDK TaskUpdateInput carries optional
      // subject/description/activeForm; use whichever is present so the user
      // knows which task is being updated. `description` is a last-resort label
      // (it can be long, so it is truncated like TaskCreate's description).
      const taskId = input.taskId as string | undefined;
      const status = input.status as string | undefined;
      const description = input.description as string | undefined;
      const label =
        (input.subject as string | undefined) ||
        (input.activeForm as string | undefined) ||
        (description ? truncateText(description) : undefined);
      const tail = status ? ` → ${status}` : '';
      return label
        ? `🔧 Updating task #${taskId || '?'} "${label}"${tail}`
        : `🔧 Updating task #${taskId || '?'}${tail}`;
    }
    default: {
      const str = safeStringify(input, 60);
      return `🔧 ${toolName}: ${str}`;
    }
  }
}

/**
 * Truncate a string for display, appending "..." if it exceeds maxLength.
 * Used for tool-input fields (e.g. task description) that may be long.
 */
function truncateText(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
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
