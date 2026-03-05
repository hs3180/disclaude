/**
 * Feishu Context MCP Tools - Entry point.
 *
 * This module provides the MCP server factory and tool definitions for Feishu integration.
 * Implementation has been refactored into modular components for better maintainability.
 *
 * Tools provided:
 * - send_user_feedback: Send a message to a Feishu chat (text or card format, REQUIRED)
 * - send_file_to_feishu: Send a file to a Feishu chat
 * - update_card: Update an existing interactive card
 * - wait_for_interaction: Wait for user to interact with a card
 *
 * **Module Structure:**
 * - `tools/` - Tool implementations
 *   - `send-message.ts` - send_user_feedback
 *   - `send-file.ts` - send_file_to_feishu
 *   - `card-interaction.ts` - update_card, wait_for_interaction
 *   - `types.ts` - Shared type definitions
 * - `utils/` - Utility functions
 *   - `card-validator.ts` - Feishu card validation
 *   - `feishu-api.ts` - Low-level Feishu API functions
 *
 * **Note**: task_done is now an inline tool provided by the Evaluator agent,
 * not part of the Feishu MCP server.
 *
 * **No global state**: Credentials are read from Config, chatId is passed as parameter.
 */

import { z } from 'zod';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';
import {
  send_user_feedback,
  send_file_to_feishu,
  update_card,
  wait_for_interaction,
  setMessageSentCallback,
  resolvePendingInteraction,
} from './tools/index.js';
import { isValidFeishuCard, getCardValidationError } from './utils/index.js';

// Re-export types and functions for backward compatibility
export type {
  MessageSentCallback,
  SendUserFeedbackResult,
  SendFileResult,
  UpdateCardResult,
  WaitForInteractionResult,
  PendingInteraction,
  FeishuCard,
} from './tools/types.js';

// Re-export utility functions for backward compatibility
export { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';
export { setMessageSentCallback, resolvePendingInteraction };
export { send_user_feedback, send_file_to_feishu, update_card, wait_for_interaction };

/**
 * Helper to create a successful tool result.
 * Returns content in MCP CallToolResult format.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Tool definitions for Agent SDK integration.
 *
 * Export tools in a format compatible with inline MCP servers.
 *
 * IMPORTANT: These tools should be registered via the `tools` parameter
 * in createSdkOptions(), not listed in `allowedTools`.
 *
 * @deprecated Use feishuToolDefinitions instead
 */
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

## Parameter Validation Rules

| format | content Type | Description |
|--------|-------------|-------------|
| \`"text"\` | \`string\` | Plain text or Markdown |
| \`"card"\` | \`object\` | Feishu card with {config, header, elements} |

---

## Common Mistakes to Avoid

❌ Missing format parameter
❌ format: "card" with string content (must be object)
❌ format: "text" with object content (must be string)
❌ Card missing header.title or elements

---

**Thread Support:** Use parentMessageId to reply to a specific message.

⚠️ **Markdown Tables NOT Supported** - Use column_set instead.

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: {
      type: 'object',
      properties: {
        content: {
          oneOf: [
            { type: 'string' },
            { type: 'object' }
          ],
          description: 'The content to send. For text format: use a string. For card format: use a valid Feishu card object (see description).',
        },
        format: {
          type: 'string',
          enum: ['text', 'card'],
          description: 'Format specifier (required): "text" for plain text messages, "card" for interactive cards.',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
        parentMessageId: {
          type: 'string',
          description: 'Optional parent message ID for thread replies. When provided, the message is sent as a reply to this message.',
        },
      },
      required: ['content', 'format', 'chatId'],
    },
    handler: send_user_feedback,
  },
  send_file_to_feishu: {
    description: 'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to send (relative to workspace or absolute)',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['filePath', 'chatId'],
    },
    handler: send_file_to_feishu,
  },
  update_card: {
    description: 'Update an existing interactive card message. Use this to change the content of a card that was already sent, such as updating a progress indicator or changing button states.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The message ID of the card to update',
        },
        card: {
          type: 'object',
          description: 'The new card content (must be a valid Feishu card structure)',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID where the card was sent',
        },
      },
      required: ['messageId', 'card', 'chatId'],
    },
    handler: update_card,
  },
  wait_for_interaction: {
    description: 'Wait for the user to interact with a card (click a button, select from menu, etc.). This tool blocks until the user interacts or a timeout is reached. Returns the action value from the button or menu that was clicked.',
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The message ID of the card to wait for',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID where the card was sent',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum time to wait in seconds (default: 300)',
        },
      },
      required: ['messageId', 'chatId'],
    },
    handler: wait_for_interaction,
  },
};

/**
 * SDK-compatible tool definitions.
 *
 * Uses InlineToolDefinition format for SDK abstraction.
 */
export const feishuToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'send_user_feedback',
    description: `Send a message to a Feishu chat. Requires explicit format: "text" or "card".

**IMPORTANT: "format" parameter is REQUIRED for every call.**

---

## Correct Usage Examples

### Text Message
\`\`\`json
{
  "content": "Hello, this is a plain text message",
  "format": "text",
  "chatId": "oc_xxx"
}
\`\`\`

### Card Message
\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "Card Title"},
      "template": "blue"
    },
    "elements": [
      {"tag": "markdown", "content": "**Bold** and *italic* text"},
      {"tag": "hr"},
      {"tag": "div", "text": {"tag": "plain_text", "content": "Plain text content"}}
    ]
  },
  "format": "card",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameter Validation Rules

| format | content Type | Description |
|--------|-------------|-------------|
| \`"text"\` | \`string\` | Plain text or Markdown |
| \`"card"\` | \`object\` | Feishu card JSON with required structure |

---

## Card Format Requirements

When \`format: "card"\`, content MUST include:
- \`config\`: Object (e.g., \`{"wide_screen_mode": true}\`)
- \`header\`: Object with \`title\` (e.g., \`{"title": {"tag": "plain_text", "content": "..."}, "template": "blue"}\`)
- \`elements\`: Array of card elements

---

## Common Mistakes to Avoid

❌ **Missing format parameter** - Always specify format: "text" or "card"
❌ **format: "card" with string content** - Must be an object with config/header/elements
❌ **format: "text" with object content** - Must be a string
❌ **Card missing header.title** - Title is required inside header
❌ **Card missing elements array** - Elements array is required (can be empty [])

---

## Thread Support

When parentMessageId is provided, the message is sent as a reply to that message, creating a thread in Feishu.

---

## Key Card Elements

- \`{"tag": "markdown", "content": "..."}\` - Markdown formatted text
- \`{"tag": "hr"}\` - Horizontal divider
- \`{"tag": "div", "text": {"tag": "plain_text", "content": "..."}}\` - Plain text in containers
- \`{"tag": "column_set", ...}\` - For tables (see below)

⚠️ **Markdown Tables NOT Supported** - Use column_set instead.

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      content: z.union([z.string(), z.object({}).passthrough()]).describe('The content to send. MUST match format type: string for "text", object for "card" with {config, header, elements}.'),
      format: z.enum(['text', 'card'], {
        message: 'format is REQUIRED. Use "text" for plain text messages or "card" for interactive cards.',
      }).describe('REQUIRED: "text" for plain text, "card" for interactive cards. This parameter is mandatory.'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
      parentMessageId: z.string().optional().describe('Optional parent message ID for thread replies.'),
    }),
    handler: async ({ content, format, chatId, parentMessageId }) => {
      // Pre-validation with helpful error messages for common mistakes
      if (format === 'card' && typeof content === 'string') {
        return toolSuccess('❌ Error: When format="card", content must be an OBJECT with {config, header, elements}, not a string.\n\nCorrect example:\n{"content": {"config": {...}, "header": {...}, "elements": [...]}, "format": "card", "chatId": "..."}');
      }
      if (format === 'text' && typeof content !== 'string') {
        return toolSuccess('❌ Error: When format="text", content must be a STRING, not an object.\n\nCorrect example:\n{"content": "Your text here", "format": "text", "chatId": "..."}');
      }
      // Additional card structure validation
      if (format === 'card' && typeof content === 'object' && content !== null) {
        if (!isValidFeishuCard(content as Record<string, unknown>)) {
          const error = getCardValidationError(content);
          return toolSuccess(`❌ Card validation failed: ${error}.\n\nRequired structure:\n{"config": {...}, "header": {"title": {...}, ...}, "elements": [...]}`);
        }
      }

      try {
        const result = await send_user_feedback({ content, format, chatId, parentMessageId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          // Return as soft error (not isError) to avoid SDK subprocess crash
          // The agent can retry or continue with other operations
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        // Return as soft error to avoid SDK subprocess crash
        return toolSuccess(`⚠️ Feedback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'send_file_to_feishu',
    description: 'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
    parameters: z.object({
      filePath: z.string().describe('Path to the file to send (relative to workspace or absolute)'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    }),
    handler: async ({ filePath, chatId }) => {
      try {
        const result = await send_file_to_feishu({ filePath, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          // Return as soft error (not isError) to avoid SDK subprocess crash
          // The agent can continue with other operations
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        // Return as soft error to avoid SDK subprocess crash
        return toolSuccess(`⚠️ File send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'update_card',
    description: 'Update an existing interactive card message. Use this to change the content of a card that was already sent.\n\n**Use Cases:**\n- Update progress indicators\n- Change button states (enable/disable)\n- Show results after user action\n- Display dynamic content\n\n**Note:** The card must have been sent previously using send_user_feedback with format="card".',
    parameters: z.object({
      messageId: z.string().describe('The message ID of the card to update (from the original send_user_feedback response)'),
      card: z.object({}).passthrough().describe('The new card content (must be a valid Feishu card structure with config, header, elements)'),
      chatId: z.string().describe('Feishu chat ID where the card was sent'),
    }),
    handler: async ({ messageId, card, chatId }) => {
      try {
        const result = await update_card({ messageId, card, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Card update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'wait_for_interaction',
    description: 'Wait for the user to interact with a card (click a button, select from menu, etc.).\n\n**This tool blocks** until the user interacts or a timeout is reached.\n\n**Returns:**\n- actionValue: The value of the button or menu option that was clicked\n- actionType: The type of interaction (button, menu, etc.)\n- userId: The ID of the user who interacted\n\n**Use Cases:**\n- Wait for user confirmation before proceeding\n- Get user selection from a menu\n- Handle multi-step card workflows\n\n**Note:** This tool will timeout after the specified duration (default: 5 minutes).',
    parameters: z.object({
      messageId: z.string().describe('The message ID of the card to wait for'),
      chatId: z.string().describe('Feishu chat ID where the card was sent'),
      timeoutSeconds: z.number().optional().describe('Maximum time to wait in seconds (default: 300 = 5 minutes)'),
    }),
    handler: async ({ messageId, chatId, timeoutSeconds }) => {
      try {
        const result = await wait_for_interaction({ messageId, chatId, timeoutSeconds });
        if (result.success) {
          return toolSuccess(`${result.message}\nAction: ${result.actionValue}\nType: ${result.actionType}\nUser: ${result.userId}`);
        } else {
          return toolSuccess(`⚠️ ${result.message}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Wait failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
];

/**
 * SDK-compatible tools array.
 *
 * @deprecated Use feishuToolDefinitions with getProvider().createMcpServer() instead.
 */
export const feishuSdkTools = feishuToolDefinitions.map(def => getProvider().createInlineTool(def));

/**
 * SDK MCP Server factory for Feishu context tools.
 *
 * **Lifecycle:**
 * - Each call creates a new MCP server instance with its own Protocol
 * - This prevents transport conflicts when multiple Agent instances are active
 * - SDK automatically cleans up these instances when queries complete
 *
 * **Usage:**
 * Call this factory when creating queries:
 * ```typescript
 * query({
 *   prompt: "...",
 *   options: {
 *     mcpServers: {
 *       'feishu-context': createFeishuSdkMcpServer(),
 *     },
 *   },
 * })
 * ```
 *
 * Creates an in-process MCP server that provides Feishu integration tools
 * to the Agent SDK.
 */
export function createFeishuSdkMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'feishu-context',
    version: '1.0.0',
    tools: feishuToolDefinitions,
  });
}
