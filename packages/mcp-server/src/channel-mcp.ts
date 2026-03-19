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
  setMessageSentCallback
} from './tools/index.js';
import { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';

// Re-export
export type { MessageSentCallback } from './tools/types.js';
export { setMessageSentCallback };
export { send_text } from './tools/send-message.js';
export { send_card } from './tools/send-card.js';
export { send_file } from './tools/send-file.js';
export {
  send_interactive,
  send_interactive_message,
  generateInteractionPrompt,
  getActionPrompts,
  startIpcServer,
  stopIpcServer,
  isIpcServerRunning,
  registerFeishuHandlers,
  unregisterFeishuHandlers,
} from './tools/interactive-message.js';
export { ask_user } from './tools/ask-user.js';

function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
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
When users click buttons, the corresponding prompt template will be sent to the agent.

IMPORTANT: Use this when your card contains buttons that need to trigger actions.
For display-only cards, use send_card instead.`,
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'object', description: 'Card JSON structure' },
        actionPrompts: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of button values to prompt templates. When a button is clicked, the corresponding prompt is sent to the agent.',
        },
        chatId: { type: 'string', description: 'Target chat ID' },
        parentMessageId: { type: 'string', description: 'Optional parent message ID for thread reply' },
      },
      required: ['card', 'actionPrompts', 'chatId'],
    },
    handler: send_interactive,
  },
  send_file: {
    description: 'Send a file to a chat.',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' }, chatId: { type: 'string' } },
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
    }),
    handler: async ({ text, chatId, parentMessageId }: {
      text: string;
      chatId: string;
      parentMessageId?: string;
    }) => {
      try {
        const result = await send_text({ text, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Text send failed: ${error instanceof Error ? error.message : String(error)}`);
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
        return toolSuccess(`⚠️ Invalid card: must be an object, got ${Array.isArray(card) ? 'array' : typeof card}`);
      }

      // Validate card structure
      if (!isValidFeishuCard(card)) {
        return toolSuccess(`⚠️ Invalid card structure: ${getCardValidationError(card)}`);
      }

      // Validate chatId
      if (!chatId || typeof chatId !== 'string') {
        return toolSuccess('⚠️ Invalid chatId: must be a non-empty string');
      }

      try {
        const result = await send_card({ card, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Card send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_interactive',
    description: `Send an interactive card with clickable buttons to a chat.

When users click buttons, the corresponding prompt template will be sent to the agent.

**IMPORTANT**: Use this when your card contains buttons that need to trigger actions.
For display-only cards, use send_card instead.

## Parameters
- **card**: The card JSON structure (object)
- **actionPrompts**: Map of button values to prompt templates
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply

## Type Constraints (IMPORTANT)
- **card**: MUST be an object with config/header/elements, NOT an array or string
- **actionPrompts**: MUST be an object { [buttonValue: string]: string }, NOT an array or string
- **chatId**: MUST be a non-empty string

## Action Prompt Placeholders
Templates can include these placeholders:
- \`{{actionText}}\` - Display text of the clicked button
- \`{{actionValue}}\` - Value of the action
- \`{{actionType}}\` - Type of action (button, select_static, etc.)
- \`{{form.fieldName}}\` - Form field values

## Example
\`\`\`json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": { "title": { "tag": "plain_text", "content": "Confirm Action" } },
    "elements": [
      {
        "tag": "action",
        "actions": [
          { "tag": "button", "text": { "tag": "plain_text", "content": "OK" }, "value": "ok" },
          { "tag": "button", "text": { "tag": "plain_text", "content": "Cancel" }, "value": "cancel" }
        ]
      }
    ]
  },
  "actionPrompts": {
    "ok": "[User Action] User clicked OK. Please continue.",
    "cancel": "[User Action] User clicked Cancel. Task aborted."
  },
  "chatId": "oc_xxx"
}
\`\`\`

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      card: z.object({}).passthrough().describe('Card JSON structure'),
      actionPrompts: z.record(z.string(), z.string()).describe(
        'Map of button values to prompt templates. When a button is clicked, the corresponding prompt is sent to the agent.'
      ),
      chatId: z.string().describe('Target chat ID'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread reply'),
    }),
    handler: async ({ card, actionPrompts, chatId, parentMessageId }: {
      card: Record<string, unknown>;
      actionPrompts: Record<string, string>;
      chatId: string;
      parentMessageId?: string;
    }) => {
      // Issue #1355: Pre-validation to prevent message sending on invalid params
      // Validate card type
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        return toolSuccess(`⚠️ Invalid card: must be an object, got ${Array.isArray(card) ? 'array' : typeof card}`);
      }

      // Validate card structure
      if (!isValidFeishuCard(card)) {
        return toolSuccess(`⚠️ Invalid card structure: ${getCardValidationError(card)}`);
      }

      // Validate actionPrompts type
      if (!actionPrompts || typeof actionPrompts !== 'object' || Array.isArray(actionPrompts)) {
        return toolSuccess(`⚠️ Invalid actionPrompts: must be an object, got ${Array.isArray(actionPrompts) ? 'array' : typeof actionPrompts}`);
      }

      // Validate actionPrompts non-empty
      const promptKeys = Object.keys(actionPrompts);
      if (promptKeys.length === 0) {
        return toolSuccess('⚠️ Invalid actionPrompts: must have at least one action');
      }

      // Validate actionPrompts value types
      for (const [key, value] of Object.entries(actionPrompts)) {
        if (typeof value !== 'string') {
          return toolSuccess(`⚠️ Invalid actionPrompts: value for "${key}" must be string, got ${typeof value}`);
        }
      }

      // Validate chatId
      if (!chatId || typeof chatId !== 'string') {
        return toolSuccess('⚠️ Invalid chatId: must be a non-empty string');
      }

      try {
        const result = await send_interactive({ card, actionPrompts, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Interactive card send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_file',
    description: 'Send a file to a chat.',
    parameters: z.object({ filePath: z.string(), chatId: z.string() }),
    handler: async ({ filePath, chatId }: { filePath: string; chatId: string }) => {
      try {
        const result = await send_file({ filePath, chatId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ File send failed: ${error instanceof Error ? error.message : String(error)}`);
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
