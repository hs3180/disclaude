/**
 * Channel MCP Tools - In-process tool implementation.
 *
 * This module provides MCP tools that communicate with the Primary/Worker Node
 * via IPC. The IPC server is managed by the Primary/Worker Node, not by this
 * module. Tools use getIpcClient() to connect to the parent's IPC server.
 *
 * @module mcp-server/channel-mcp
 */

import { z } from 'zod';
import { getProvider, type SdkInlineToolDefinition } from '@disclaude/core';
import {
  send_text,
  send_card,
  send_interactive,
  send_file,
  register_temp_chat,
  upload_image,
  setMessageSentCallback
} from './tools/index.js';
import { isValidFeishuCard, getCardValidationError, detectMarkdownTableWarnings } from './utils/card-validator.js';
import { transformCardTables } from './utils/table-converter.js';
import { getChatIdValidationError } from './utils/chat-id-validator.js';
import type { InteractiveOption, ActionPromptMap } from './tools/types.js';

// Re-export
export type { MessageSentCallback, InteractiveOption, ActionPromptMap } from './tools/types.js';
export { setMessageSentCallback };
export { send_text } from './tools/send-message.js';
export { send_card } from './tools/send-card.js';
export { send_file } from './tools/send-file.js';
export { register_temp_chat } from './tools/register-temp-chat.js';
export { upload_image } from './tools/upload-image.js';
export {
  send_interactive,
  send_interactive_message,
  startIpcServer,
  stopIpcServer,
  isIpcServerRunning,
  registerFeishuHandlers,
  unregisterFeishuHandlers,
} from './tools/interactive-message.js';

function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/**
 * Return a tool error result with isError flag.
 *
 * When isError is true, the Agent treats the tool call as failed and
 * stops retrying/diagnosing — it reports the error to the user instead.
 *
 * Issue #1634: Without isError, failed tool calls wrapped in toolSuccess()
 * caused the Agent to enter diagnostic mode, exceeding test timeouts.
 * Issue #1641: chatId validation errors also use this to signal failure.
 */
function toolError(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

export const channelTools = {
  send_text: {
    description: 'Send a plain text message to a chat.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text content to send' },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread reply' },
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
          description: 'Mention targets for @mentioning users/bots (Issue #1742)',
        },
      },
      required: ['text', 'chatId'],
    },
    handler: send_text,
  },
  send_card: {
    description: `Send a display-only card message to a chat.
Use this for static cards without interactive elements (buttons, menus).
For interactive cards with button click handlers, use send_interactive instead.`,
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'object', description: 'Card JSON structure' },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread reply' },
      },
      required: ['card', 'chatId'],
    },
    handler: send_card,
  },
  send_interactive: {
    description: `Send an interactive card with clickable buttons to a chat.
Primary Node builds the card from raw parameters (question, options).
When users click buttons, the corresponding prompt template will be sent to the agent.

IMPORTANT: Use this when your card contains buttons that need to trigger actions.
For display-only cards, use send_card instead.`,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question or main content to display' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Button display text' },
              value: { type: 'string', description: 'Button action value' },
              type: { type: 'string', enum: ['primary', 'default', 'danger'], description: 'Button style (optional)' },
            },
            required: ['text', 'value'],
          },
          description: 'Button options for user interaction',
        },
        title: { type: 'string', description: 'Card title (optional, defaults to "交互消息")' },
        context: { type: 'string', description: 'Optional context shown above the question' },
        actionPrompts: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional custom action prompts that override auto-generated defaults',
        },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread reply' },
      },
      required: ['question', 'options', 'chatId'],
    },
    handler: send_interactive,
  },
  send_file: {
    description: 'Send a file to a chat.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread reply' },
      },
      required: ['filePath', 'chatId'],
    },
    handler: send_file,
  },
};

export const channelToolDefinitions: SdkInlineToolDefinition[] = [
  // ============================================================================
  // Issue #1155: Focused tools following Single Responsibility Principle
  // - send_text: Plain text messages
  // - send_card: Display-only cards (no interactions)
  // - send_interactive: Interactive cards with button handlers
  // - send_file: File uploads
  // Issue #1298: Removed start_group_discussion (business logic not MCP scope)
  // ============================================================================
  {
    name: 'send_text',
    description: `Send a plain text message to a chat.

## Parameters
- **text**: The text content to send (string)
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply

## Example
\`\`\`json
{"text": "Hello, world!", "chatId": "oc_xxx"}
\`\`\``,
    parameters: z.object({
      text: z.string().describe('The text content to send'),
      chatId: z.string().describe('Target chat ID'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread reply'),
      mentions: z.array(z.object({
        openId: z.string().describe('Open ID of the user/bot to @mention'),
        name: z.string().optional().describe('Display name of the mention target'),
      })).optional().describe('Mention targets for @mentioning users/bots (Issue #1742)'),
    }),
    handler: async ({ text, chatId, parentMessageId, mentions }: {
      text: string;
      chatId: string;
      parentMessageId?: string;
      mentions?: Array<{ openId: string; name?: string }>;
    }) => {
      // Issue #1641 P1: Validate chatId format before IPC call
      const chatIdError = getChatIdValidationError(chatId);
      if (chatIdError) {
        return toolError(`Invalid chatId: ${chatIdError}`);
      }

      try {
        const result = await send_text({ text, chatId, parentMessageId, mentions });
        return result.success ? toolSuccess(result.message) : toolError(result.message);
      } catch (error) {
        return toolError(`Text send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_card',
    description: `Send a display-only card message to a chat.

Use this for static cards without interactive elements (buttons, menus).
For interactive cards with button click handlers, use send_interactive instead.

## Parameters
- **card**: The card JSON structure (object)
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply

## Type Constraints (IMPORTANT)
- **card**: MUST be an object with config/header/elements, NOT an array or string
- **chatId**: MUST be a non-empty string

## Markdown Limitations (IMPORTANT)
The \`markdown\` element supports a **restricted subset** of GFM:
- ✅ Supported: bold, italic, links, lists, code blocks, headings
- ❌ NOT supported: **tables** (\`| col | col |\`), footnotes, task lists, strikethrough
- ⚡ **Auto-conversion**: GFM tables in markdown elements are automatically converted to \`column_set\` layout
- For complex tabular layouts, prefer using \`column_set\` directly

## Example
\`\`\`json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": { "title": { "tag": "plain_text", "content": "Status Update" } },
    "elements": [
      { "tag": "div", "text": { "tag": "plain_text", "content": "Task completed successfully!" } }
    ]
  },
  "chatId": "oc_xxx"
}
\`\`\`

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      card: z.object({}).passthrough().describe('Card JSON structure'),
      chatId: z.string().describe('Target chat ID'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread reply'),
    }),
    handler: async ({ card, chatId, parentMessageId }: {
      card: Record<string, unknown>;
      chatId: string;
      parentMessageId?: string;
    }) => {
      // Issue #1355: Pre-validation to prevent message sending on invalid params
      // Validate card type
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        return toolError(`Invalid card: must be an object, got ${Array.isArray(card) ? 'array' : typeof card}`);
      }

      // Validate card structure
      if (!isValidFeishuCard(card)) {
        return toolError(`Invalid card structure: ${getCardValidationError(card)}`);
      }

      // Issue #1641 P1: Validate chatId format before IPC call
      const chatIdError = getChatIdValidationError(chatId);
      if (chatIdError) {
        return toolError(`Invalid chatId: ${chatIdError}`);
      }

      try {
        // Issue #2340: Auto-convert GFM tables in markdown elements to column_set
        const processedCard = transformCardTables(card);
        const result = await send_card({ card: processedCard, chatId, parentMessageId });

        // Issue #2340: Detect GFM table syntax in markdown elements and append info
        const tableWarnings = detectMarkdownTableWarnings(card);
        if (result.success && tableWarnings.length > 0) {
          return toolSuccess(`${result.message}\n\nℹ️ Auto-converted ${tableWarnings.length === 1 ? 'a GFM table' : `${tableWarnings.length  } GFM tables`} to column_set layout. The table renders correctly now.`);
        }

        return result.success ? toolSuccess(result.message) : toolError(result.message);
      } catch (error) {
        return toolError(`Card send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_interactive',
    description: `Send an interactive card with clickable buttons to a chat.

Primary Node builds the card from raw parameters (question, options).
When users click buttons, the corresponding prompt template will be sent to the agent.

**IMPORTANT**: Use this when your card contains buttons that need to trigger actions.
For display-only cards, use send_card instead.

## Parameters
- **question**: The question or main content to display (string)
- **options**: Array of button options with text, value, and optional type
- **chatId**: Target chat ID
- **title**: Optional card title (defaults to "交互消息")
- **context**: Optional context shown above the question
- **actionPrompts**: Optional custom action prompts that override auto-generated defaults
- **parentMessageId**: Optional, for thread reply

## Type Constraints (IMPORTANT)
- **question**: MUST be a non-empty string
- **options**: MUST be a non-empty array of objects with text (string) and value (string)
- **chatId**: MUST be a non-empty string

## Example
\`\`\`json
{
  "question": "Which option do you prefer?",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Reject", "value": "reject", "type": "danger" }
  ],
  "title": "Code Review",
  "chatId": "oc_xxx"
}
\`\`\``,
    parameters: z.object({
      question: z.string().describe('The question or main content to display'),
      options: z.array(z.object({
        text: z.string().describe('Button display text'),
        value: z.string().describe('Button action value'),
        type: z.enum(['primary', 'default', 'danger']).optional().describe('Button style'),
      })).describe('Button options for user interaction'),
      title: z.string().optional().describe('Card title (defaults to "交互消息")'),
      context: z.string().optional().describe('Optional context shown above the question'),
      actionPrompts: z.record(z.string(), z.string()).optional().describe(
        'Optional custom action prompts that override auto-generated defaults'
      ),
      chatId: z.string().describe('Target chat ID'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread reply'),
    }),
    handler: async ({ question, options, chatId, title, context, actionPrompts, parentMessageId }: {
      question: string;
      options: InteractiveOption[];
      chatId: string;
      title?: string;
      context?: string;
      actionPrompts?: ActionPromptMap;
      parentMessageId?: string;
    }) => {
      // Issue #1355: Pre-validation to prevent message sending on invalid params
      if (!question || typeof question !== 'string') {
        return toolError('Invalid question: must be a non-empty string');
      }
      if (!Array.isArray(options) || options.length === 0) {
        return toolError('Invalid options: must be a non-empty array');
      }

      // Issue #1641 P1: Validate chatId format before IPC call
      const chatIdError = getChatIdValidationError(chatId);
      if (chatIdError) {
        return toolError(`Invalid chatId: ${chatIdError}`);
      }

      try {
        const result = await send_interactive({ question, options, chatId, title, context, actionPrompts, parentMessageId });
        return result.success ? toolSuccess(result.message) : toolError(result.message);
      } catch (error) {
        return toolError(`Interactive card send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_file',
    description: `Send a file to a chat.

## Parameters
- **filePath**: Path to the file to send (string)
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply

## Example
\`\`\`json
{"filePath": "/path/to/report.pdf", "chatId": "oc_xxx"}
\`\`\``,
    parameters: z.object({
      filePath: z.string(),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
    }),
    handler: async ({ filePath, chatId, parentMessageId }: { filePath: string; chatId: string; parentMessageId?: string }) => {
      // Issue #1641 P1: Validate chatId format before IPC call
      const chatIdError = getChatIdValidationError(chatId);
      if (chatIdError) {
        return toolError(`Invalid chatId: ${chatIdError}`);
      }

      try {
        const result = await send_file({ filePath, chatId, parentMessageId });
        return result.success ? toolSuccess(result.message) : toolError(result.message);
      } catch (error) {
        return toolError(`File send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  // Issue #1703: Temp chat lifecycle management
  // Issue #2291: triggerMode enum parameter
  {
    name: 'register_temp_chat',
    description: `Register a temporary chat for automatic lifecycle management.

The Primary Node will track the chat and automatically dissolve it when it expires.
Use this after creating a group chat that should be temporary.

## Parameters
- **chatId**: The chat ID to track (required)
- **expiresAt**: ISO timestamp for expiry (optional, defaults to 24h)
- **creatorChatId**: The originating chat ID (optional, for notifications)
- **context**: Arbitrary context data (optional, for consumer identification)
- **triggerMode**: Set to \`"always"\` to make the bot respond to all messages without @mention. Set to \`"mention"\` for mention-only mode (default). (optional, Issue #2291)

## Example
\`\`\`json
{"chatId": "oc_xxx", "expiresAt": "2026-03-28T10:00:00.000Z", "triggerMode": "always", "context": {"prNumber": 123}}
\`\`\``,
    parameters: z.object({
      chatId: z.string().describe('The chat ID to track'),
      expiresAt: z.string().optional().describe('ISO timestamp for expiry (defaults to 24h)'),
      creatorChatId: z.string().optional().describe('The originating chat ID'),
      context: z.record(z.string(), z.unknown()).optional().describe('Arbitrary context data'),
      triggerMode: z.enum(['mention', 'always']).optional().describe('Trigger mode: "mention" = only @mentions (default), "always" = respond to all messages (Issue #2291)'),
    }),
    handler: async ({ chatId, expiresAt, creatorChatId, context, triggerMode }: {
      chatId: string;
      expiresAt?: string;
      creatorChatId?: string;
      context?: Record<string, unknown>;
      triggerMode?: 'mention' | 'always';
    }) => {
      // register_temp_chat handles all errors internally and returns { success, message }
      const result = await register_temp_chat({ chatId, expiresAt, creatorChatId, context, triggerMode });
      return toolSuccess(result.message);
    },
  },
  // Issue #1919: Upload image and return image_key for card embedding
  {
    name: 'upload_image',
    description: `Upload an image file and return an \`image_key\` for use in card messages.

Use this tool when you need to embed an image inside a card message (e.g., charts, diagrams).
The returned \`image_key\` can be used in the card JSON's \`img\` element.

## Typical Workflow
1. Generate image (e.g., chart via Python/Matplotlib)
2. Call \`upload_image\` with the image file path
3. Use the returned \`image_key\` in \`send_card\`'s \`img\` element

## Parameters
- **filePath**: Path to the image file (string)

## Supported Formats
jpg, jpeg, png, webp, gif, tiff, bmp, ico (max 10MB)

## Example
\`\`\`json
{"filePath": "/path/to/chart.png"}
\`\`\`

## Card Usage Example
After getting \`image_key\`, use it in a card:
\`\`\`json
{
  "card": {
    "elements": [
      { "tag": "img", "img_key": "img_v3_xxx" }
    ]
  },
  "chatId": "oc_xxx"
}
\`\`\``,
    parameters: z.object({
      filePath: z.string().describe('Path to the image file to upload'),
    }),
    handler: async ({ filePath }: { filePath: string }) => {
      try {
        const result = await upload_image({ filePath });
        return result.success ? toolSuccess(result.message) : toolError(result.message);
      } catch (error) {
        return toolError(`Image upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];

export const channelSdkTools = channelToolDefinitions.map(def => getProvider().createInlineTool(def));

export function createChannelMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'channel-mcp',
    version: '1.0.0',
    tools: channelToolDefinitions,
  });
}

// Deprecated aliases (backward compatibility)
/** @deprecated Use channelTools instead */
export const feishuContextTools = channelTools;
/** @deprecated Use channelToolDefinitions instead */
export const feishuToolDefinitions = channelToolDefinitions;
/** @deprecated Use channelSdkTools instead */
export const feishuSdkTools = channelSdkTools;
/** @deprecated Use createChannelMcpServer instead */
export const createFeishuSdkMcpServer = createChannelMcpServer;
