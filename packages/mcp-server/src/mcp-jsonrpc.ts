/**
 * Shared MCP JSON-RPC handling logic.
 *
 * Extracted from sse-server.ts so both SSE and Streamable HTTP transports
 * reuse the same tool definitions and request handling.
 *
 * @module mcp-server/mcp-jsonrpc
 */

import {
  send_text,
  send_card,
  send_interactive_message,
  send_file,
} from './index.js';
import { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';

// ============================================================================
// Tool definitions (shared JSON Schema format)
// ============================================================================

/** Tool definitions with JSON Schema inputSchema. */
export const TOOLS = [
  {
    name: 'send_text',
    description: 'Send a plain text message to a chat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The text message content.' },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread replies' },
        mentions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              openId: { type: 'string', description: 'Open ID of the user/bot to @mention' },
              name: { type: 'string', description: 'Display name of the mention target' },
            },
            required: ['openId'],
          },
          description: 'Mention targets for @mentioning users/bots',
        },
      },
      required: ['text', 'chatId'],
    },
  },
  {
    name: 'send_card',
    description: `Send a display-only card to a chat. No button interactions.

## Card Structure
A Feishu card object with config, header, and elements.

## Type Constraints (IMPORTANT)
- **card**: MUST be an object with config/header/elements, NOT an array or string
- **chatId**: MUST be a non-empty string

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: { type: 'object', description: 'The card content object.' },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread replies' },
      },
      required: ['card', 'chatId'],
    },
  },
  {
    name: 'send_interactive',
    description: `Send an interactive card with buttons/actions to a chat.

Primary Node builds the card from raw parameters (question, options).

## Parameters
- **question**: The question or main content to display (string)
- **options**: Array of button options with text, value, and optional type
- **chatId**: Target chat ID

## Example
\`\`\`json
{
  "question": "Which option?",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Reject", "value": "reject", "type": "danger" }
  ],
  "chatId": "oc_xxx"
}
\`\`\``,
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question or main content to display.' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Button display text' },
              value: { type: 'string', description: 'Button action value' },
              type: { type: 'string', enum: ['primary', 'default', 'danger'], description: 'Button style' },
            },
            required: ['text', 'value'],
          },
          description: 'Button options for user interaction.',
        },
        title: { type: 'string', description: 'Optional card title.' },
        context: { type: 'string', description: 'Optional context shown above the question.' },
        actionPrompts: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional custom action prompts.',
        },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread replies' },
      },
      required: ['question', 'options', 'chatId'],
    },
  },
  {
    name: 'send_file',
    description: 'Send a file to a chat. Supports images, audio, video, and documents.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: { type: 'string', description: 'Path to the file to send (absolute or relative to workspace).' },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread replies.' },
      },
      required: ['filePath', 'chatId'],
    },
  },
];

// ============================================================================
// JSON-RPC response helpers
// ============================================================================

/** Send a tool success result. */
export function toolSuccess(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Send a tool error result. */
export function toolError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

// ============================================================================
// Tool call handling
// ============================================================================

/**
 * Handle a tools/call request.
 */
export async function handleToolCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'send_text': {
      if (typeof args.text !== 'string') {return toolError('Invalid text: must be a string');}
      if (!args.chatId || typeof args.chatId !== 'string') {return toolError('Invalid chatId: must be a non-empty string');}
      const result = await send_text({
        text: args.text,
        chatId: args.chatId,
        parentMessageId: args.parentMessageId as string | undefined,
        mentions: args.mentions as Array<{ openId: string; name?: string }> | undefined,
      });
      return result.success ? toolSuccess(result.message) : toolError(result.message);
    }

    case 'send_card': {
      const { card, chatId } = args;
      if (!card || typeof card !== 'object' || Array.isArray(card)) {return toolError('Invalid card: must be an object');}
      if (!chatId || typeof chatId !== 'string') {return toolError('Invalid chatId: must be a non-empty string');}
      if (!isValidFeishuCard(card as Record<string, unknown>)) {return toolError(`Invalid card structure: ${getCardValidationError(card)}`);}
      const result = await send_card({ card: card as Record<string, unknown>, chatId, parentMessageId: args.parentMessageId as string | undefined });
      return result.success ? toolSuccess(result.message) : toolError(result.message);
    }

    case 'send_interactive': {
      const { question, options } = args;
      const chatId = args.chatId as string | undefined;
      if (!question || typeof question !== 'string') {return toolError('Invalid question: must be a non-empty string');}
      if (!Array.isArray(options) || options.length === 0) {return toolError('Invalid options: must be a non-empty array');}
      if (!chatId || typeof chatId !== 'string') {return toolError('Invalid chatId: must be a non-empty string');}
      const result = await send_interactive_message({
        question: question as string,
        options: options as Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>,
        chatId,
        title: args.title as string | undefined,
        context: args.context as string | undefined,
        actionPrompts: args.actionPrompts as Record<string, string> | undefined,
        parentMessageId: args.parentMessageId as string | undefined,
      });
      return result.success ? toolSuccess(result.message) : toolError(result.message);
    }

    case 'send_file': {
      if (typeof args.filePath !== 'string') {return toolError('Invalid filePath: must be a string');}
      if (!args.chatId || typeof args.chatId !== 'string') {return toolError('Invalid chatId: must be a non-empty string');}
      const result = await send_file({ filePath: args.filePath, chatId: args.chatId, parentMessageId: args.parentMessageId as string | undefined });
      return result.success ? toolSuccess(`File sent: ${result.message}`) : toolError(result.message);
    }

    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// JSON-RPC request handling
// ============================================================================

/**
 * Handle a JSON-RPC request.
 */
export async function handleJsonRpc(
  request: { jsonrpc: string; id?: number | string | null; method: string; params?: unknown },
  sendResponse: (response: unknown) => void,
): Promise<void> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize': {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'channel-mcp', version: '0.0.1' },
          },
        });
        break;
      }

      case 'notifications/initialized': {
        // Notification — no response needed
        break;
      }

      case 'tools/list': {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS },
        });
        break;
      }

      case 'tools/call': {
        const callParams = params as { name: string; arguments: Record<string, unknown> } | undefined;
        const result = await handleToolCall(callParams?.name ?? '', callParams?.arguments ?? {});
        sendResponse({ jsonrpc: '2.0', id, result });
        break;
      }

      case 'ping': {
        sendResponse({ jsonrpc: '2.0', id, result: {} });
        break;
      }

      default: {
        sendResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
    }
  } catch (error) {
    sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
    });
  }
}
