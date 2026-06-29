/**
 * MCP tool dispatch — validates params and delegates to tool handlers.
 *
 * Issue #4128: Extracted from cli.ts handleRequest() to separate
 * validation/dispatch logic from the CLI entry point.
 *
 * @module mcp-server/tools/tool-dispatch
 */

import {
  send_text,
  send_card,
  send_file,
  send_interactive_message,
  push_to_agent,
} from './index.js';
import { isValidFeishuCard, getCardValidationError } from '../utils/card-validator.js';

/** JSON-RPC response content item. */
interface TextContent {
  type: 'text';
  text: string;
}

/** JSON-RPC tool result (success). */
interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

/**
 * Create a success tool result.
 */
function successResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Create an error tool result.
 */
function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Dispatch a tools/call request to the appropriate handler.
 *
 * Returns the JSON-RPC result object (content array).
 * Throws on unknown tools.
 */
export async function dispatchToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'send_text': {
      if (typeof toolArgs.text !== 'string') {
        return errorResult('⚠️ Invalid text: must be a string');
      }
      if (!toolArgs.chatId || typeof toolArgs.chatId !== 'string') {
        return errorResult('⚠️ Invalid chatId: must be a non-empty string');
      }

      const result = await send_text({
        text: toolArgs.text,
        chatId: toolArgs.chatId,
        parentMessageId: toolArgs.parentMessageId as string | undefined,
      });
      return successResult(result.success ? result.message : `⚠️ ${result.message}`);
    }

    case 'send_card': {
      // eslint-disable-next-line prefer-destructuring
      const card = toolArgs.card;
      const chatId = toolArgs.chatId as string | undefined;

      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        return errorResult(`⚠️ Invalid card: must be an object, got ${Array.isArray(card) ? 'array' : typeof card}`);
      }

      if (!isValidFeishuCard(card as Record<string, unknown>)) {
        return errorResult(`⚠️ Invalid card structure: ${getCardValidationError(card)}`);
      }

      if (!chatId || typeof chatId !== 'string') {
        return errorResult('⚠️ Invalid chatId: must be a non-empty string');
      }

      const result = await send_card({
        card: card as Record<string, unknown>,
        chatId,
        parentMessageId: toolArgs.parentMessageId as string | undefined,
      });
      return successResult(result.success ? result.message : `⚠️ ${result.message}`);
    }

    case 'send_interactive': {
      const { question, options } = toolArgs;
      const chatId = toolArgs.chatId as string | undefined;

      if (!question || typeof question !== 'string') {
        return errorResult('⚠️ Invalid question: must be a non-empty string');
      }

      if (!Array.isArray(options) || options.length === 0) {
        return errorResult('⚠️ Invalid options: must be a non-empty array');
      }

      const opts = options as Array<{ text?: unknown; value?: unknown }>;
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        if (typeof opt.text !== 'string' || opt.text.trim().length === 0) {
          return errorResult(`⚠️ Invalid options[${i}].text: must be a non-empty string`);
        }
        if (typeof opt.value !== 'string' || opt.value.trim().length === 0) {
          return errorResult(`⚠️ Invalid options[${i}].value: must be a non-empty string`);
        }
      }

      if (!chatId || typeof chatId !== 'string') {
        return errorResult('⚠️ Invalid chatId: must be a non-empty string');
      }

      const result = await send_interactive_message({
        question: question as string,
        options: options as Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>,
        chatId,
        title: toolArgs.title as string | undefined,
        context: toolArgs.context as string | undefined,
        actionPrompts: toolArgs.actionPrompts as Record<string, string> | undefined,
        parentMessageId: toolArgs.parentMessageId as string | undefined,
      });
      return successResult(result.success ? result.message : `⚠️ ${result.message}`);
    }

    case 'send_file': {
      if (typeof toolArgs.filePath !== 'string') {
        return errorResult('⚠️ Invalid filePath: must be a string');
      }
      if (!toolArgs.chatId || typeof toolArgs.chatId !== 'string') {
        return errorResult('⚠️ Invalid chatId: must be a non-empty string');
      }

      const result = await send_file({
        filePath: toolArgs.filePath,
        chatId: toolArgs.chatId,
        parentMessageId: typeof toolArgs.parentMessageId === 'string' ? toolArgs.parentMessageId : undefined,
      });
      return successResult(result.success ? `File sent: ${result.message}` : `⚠️ ${result.message}`);
    }

    case 'push_to_agent': {
      if (!toolArgs.chatId || typeof toolArgs.chatId !== 'string') {
        return errorResult('⚠️ Invalid chatId: must be a non-empty string');
      }
      if (!toolArgs.message || typeof toolArgs.message !== 'string') {
        return errorResult('⚠️ Invalid message: must be a non-empty string');
      }

      const result = await push_to_agent({
        chatId: toolArgs.chatId,
        message: toolArgs.message,
      });
      return successResult(result.success ? result.message : `⚠️ ${result.message}`);
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
