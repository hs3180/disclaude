/**
 * Feishu Context MCP Tools - In-process tool implementation.
 *
 * @module mcp/feishu-context-mcp
 */

import { z } from 'zod';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';
import {
  send_user_feedback,
  send_file_to_feishu,
  update_card,
  wait_for_interaction,
  setMessageSentCallback,
  send_interactive_message,
  SEND_INTERACTIVE_MESSAGE_TOOL_DESCRIPTION,
} from './tools/index.js';

// Re-export for backward compatibility
export type { MessageSentCallback } from './tools/types.js';
export { setMessageSentCallback };
export { resolvePendingInteraction } from './tools/card-interaction.js';
export { send_user_feedback } from './tools/send-message.js';
export { send_file_to_feishu } from './tools/send-file.js';
export { update_card, wait_for_interaction } from './tools/card-interaction.js';
export {
  send_interactive_message,
  SEND_INTERACTIVE_MESSAGE_TOOL_DESCRIPTION,
} from './tools/interactive-message.js';

function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

export const feishuContextTools = {
  send_user_feedback: {
    description: `Send a message to a Feishu chat. Requires explicit format: "text" or "card".

**IMPORTANT: "format" parameter is REQUIRED for every call.**

---

## Correct Usage Examples

### Text Message
\`\`\`json
{"content": "Hello world", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Card Message
\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"tag": "plain_text", "content": "Title"}, "template": "blue"},
    "elements": [{"tag": "markdown", "content": "**Bold** text"}]
  },
  "format": "card",
  "chatId": "oc_xxx"
}
\`\`\`

---

**Thread Support:** Use parentMessageId to reply to a specific message.

⚠️ **Markdown Tables NOT Supported** - Use column_set instead.

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: {
      type: 'object',
      properties: {
        content: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        format: { type: 'string', enum: ['text', 'card'] },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string' },
      },
      required: ['content', 'format', 'chatId'],
    },
    handler: send_user_feedback,
  },
  send_file_to_feishu: {
    description: 'Send a file to a Feishu chat.',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' }, chatId: { type: 'string' } },
      required: ['filePath', 'chatId'],
    },
    handler: send_file_to_feishu,
  },
  update_card: {
    description: '[DEPRECATED] Update an existing interactive card message. Use send_interactive_message instead.',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string' }, card: { type: 'object' }, chatId: { type: 'string' } },
      required: ['messageId', 'card', 'chatId'],
    },
    handler: update_card,
  },
  wait_for_interaction: {
    description: '[DEPRECATED] Wait for the user to interact with a card. Interactions are now automatically converted to messages - no need to wait.',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string' }, chatId: { type: 'string' }, timeoutSeconds: { type: 'number' } },
      required: ['messageId', 'chatId'],
    },
    handler: wait_for_interaction,
  },
  send_interactive_message: {
    description: SEND_INTERACTIVE_MESSAGE_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'object' },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['card', 'chatId'],
    },
    handler: send_interactive_message,
  },
};

export const feishuToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'send_user_feedback',
    description: `Send a message to a Feishu chat. Requires explicit format: "text" or "card".

**IMPORTANT: "format" parameter is REQUIRED for every call.**

---

## Correct Usage Examples

### Text Message
\`\`\`json
{"content": "Hello", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Card Message
\`\`\`json
{
  "content": {"config": {}, "header": {"title": {"tag": "plain_text", "content": "Title"}}, "elements": []},
  "format": "card",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Card Format Requirements

When \`format: "card"\`, content MUST include:
- \`config\`: Object
- \`header\`: Object with \`title\`
- \`elements\`: Array of card elements

---

**Thread Support:** Use parentMessageId to reply to a specific message.

⚠️ **Markdown Tables NOT Supported** - Use column_set instead.

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      content: z.union([z.string(), z.object({}).passthrough()]),
      format: z.enum(['text', 'card']),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
    }),
    handler: async ({ content, format, chatId, parentMessageId }) => {
      if (format === 'card' && typeof content === 'string') {
        return toolSuccess('❌ Error: When format="card", content must be an OBJECT.');
      }
      if (format === 'text' && typeof content !== 'string') {
        return toolSuccess('❌ Error: When format="text", content must be a STRING.');
      }
      try {
        const result = await send_user_feedback({ content, format, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Feedback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_file_to_feishu',
    description: 'Send a file to a Feishu chat.',
    parameters: z.object({ filePath: z.string(), chatId: z.string() }),
    handler: async ({ filePath, chatId }) => {
      try {
        const result = await send_file_to_feishu({ filePath, chatId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ File send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'update_card',
    description: '[DEPRECATED] Update an existing interactive card message. Use send_interactive_message instead.',
    parameters: z.object({ messageId: z.string(), card: z.object({}).passthrough(), chatId: z.string() }),
    handler: async ({ messageId, card, chatId }) => {
      try {
        const result = await update_card({ messageId, card, chatId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Card update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'wait_for_interaction',
    description: '[DEPRECATED] Wait for the user to interact with a card. Interactions are now automatically converted to messages - no need to wait.',
    parameters: z.object({ messageId: z.string(), chatId: z.string(), timeoutSeconds: z.number().optional() }),
    handler: async ({ messageId, chatId, timeoutSeconds }) => {
      try {
        const result = await wait_for_interaction({ messageId, chatId, timeoutSeconds });
        return toolSuccess(result.success
          ? `${result.message}\nAction: ${result.actionValue}\nType: ${result.actionType}\nUser: ${result.userId}`
          : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Wait failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_interactive_message',
    description: SEND_INTERACTIVE_MESSAGE_TOOL_DESCRIPTION,
    parameters: z.object({
      card: z.object({}).passthrough(),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
      description: z.string().optional(),
    }),
    handler: async ({ card, chatId, parentMessageId, description }) => {
      try {
        const result = await send_interactive_message({ card, chatId, parentMessageId, description });
        return toolSuccess(result.success
          ? `${result.message}${result.messageId ? `\nMessage ID: ${result.messageId}` : ''}`
          : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Interactive message failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];

export const feishuSdkTools = feishuToolDefinitions.map(def => getProvider().createInlineTool(def));

export function createFeishuSdkMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'feishu-context',
    version: '1.0.0',
    tools: feishuToolDefinitions,
  });
}
