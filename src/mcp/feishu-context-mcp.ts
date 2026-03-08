/**
 * Context MCP Tools - In-process tool implementation.
 *
 * Refactored (Issue #1155): Consolidated tools to reduce token overhead.
 * - Merged send_message + send_interactive_message + ask_user into unified send_message
 * - Deprecated individual generate_* tools, kept only create_study_guide
 *
 * @module mcp/feishu-context-mcp
 */

import { z } from 'zod';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';
import {
  send_message,
  send_file,
  send_interactive_message,
  ask_user,
  setMessageSentCallback,
  create_study_guide,
} from './tools/index.js';
import { startIpcServer } from './tools/interactive-message.js';

// Re-export
export type { MessageSentCallback } from './tools/types.js';
export { setMessageSentCallback };
export { send_message } from './tools/send-message.js';
export { send_file } from './tools/send-file.js';
export {
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

// Start IPC server on module load for cross-process communication
// This allows the main process to query interactive contexts
startIpcServer().catch((error) => {
  // Log error but don't fail - IPC is optional enhancement
  console.error('[context-mcp] Failed to start IPC server:', error);
});

function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

// ============================================================================
// Consolidated Tool Definitions (Issue #1155)
// ============================================================================

/**
 * Unified send_message tool (Issue #1155).
 *
 * Consolidates three previous tools into one:
 * - Original send_message (text/simple cards)
 * - send_interactive_message (cards with actionPrompts)
 * - ask_user (simplified question cards)
 *
 * Use actionPrompts for interactive cards, or ask parameter for simple questions.
 */
const unifiedSendMessageDefinition: InlineToolDefinition = {
  name: 'send_message',
  description: `Send a message to a chat.

**Unified tool** for all messaging needs - text, cards, interactive buttons, and questions.

---

## 📝 Text Message
\`\`\`json
{"content": "Hello world", "format": "text", "chatId": "oc_xxx"}
\`\`\`

---

## 🎴 Card Message (Display Only)
\`\`\`json
{
  "content": {"config": {}, "header": {"title": {"tag": "plain_text", "content": "Title"}}, "elements": []},
  "format": "card",
  "chatId": "oc_xxx"
}
\`\`\`

---

## 🔘 Interactive Card (with actionPrompts)

When user interacts, you receive the corresponding prompt automatically.

\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"tag": "plain_text", "content": "Confirm"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "Proceed?"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "✓ Yes"}, "value": "yes", "type": "primary"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "✗ No"}, "value": "no", "type": "default"}
      ]}
    ]
  },
  "format": "card",
  "actionPrompts": {
    "yes": "[用户操作] 用户确认。请继续执行。",
    "no": "[用户操作] 用户取消。停止相关操作。"
  },
  "chatId": "oc_xxx"
}
\`\`\`

---

## ❓ Ask User (Simplified)

Quick question with options - auto-generates the card.

\`\`\`json
{
  "format": "text",
  "chatId": "oc_xxx",
  "ask": {
    "question": "Choose implementation:",
    "options": [
      {"text": "方案A", "value": "a", "style": "primary", "action": "使用方案A"},
      {"text": "方案B", "value": "b", "action": "使用方案B"}
    ],
    "title": "选择方案",
    "context": "Issue #123"
  }
}
\`\`\`

---

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| content | yes* | Message content (string for text, object for card) |
| format | yes | "text" or "card" |
| chatId | yes | Target chat ID |
| parentMessageId | no | Reply in thread |
| actionPrompts | no | For interactive cards: action value → prompt template |
| ask | no* | Simplified question format (auto-builds card) |

*Use either content OR ask, not both.

---

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
  parameters: z.object({
    content: z.union([z.string(), z.object({}).passthrough()]).optional(),
    format: z.enum(['text', 'card']),
    chatId: z.string(),
    parentMessageId: z.string().optional(),
    actionPrompts: z.record(z.string(), z.string()).optional(),
    ask: z.object({
      question: z.string(),
      options: z.array(z.object({
        text: z.string(),
        value: z.string().optional(),
        style: z.enum(['primary', 'default', 'danger']).optional(),
        action: z.string().optional(),
      })),
      title: z.string().optional(),
      context: z.string().optional(),
    }).optional(),
  }),
  handler: async (params) => {
    const { content, format, chatId, parentMessageId, actionPrompts, ask } = params;

    try {
      // Handle ask parameter (simplified question)
      if (ask) {
        const result = await ask_user({
          question: ask.question,
          options: ask.options,
          title: ask.title,
          context: ask.context,
          chatId,
          parentMessageId,
        });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message || result.error}`);
      }

      // Validate content is provided
      if (content === undefined) {
        return toolSuccess('❌ Error: content is required when not using ask parameter.');
      }

      // Handle text format
      if (format === 'text') {
        if (typeof content !== 'string') {
          return toolSuccess('❌ Error: When format="text", content must be a STRING.');
        }
        const result = await send_message({ content, format, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      }

      // Handle card format
      if (format === 'card') {
        if (typeof content === 'string') {
          return toolSuccess('❌ Error: When format="card", content must be an OBJECT.');
        }

        // Interactive card with actionPrompts
        if (actionPrompts && Object.keys(actionPrompts).length > 0) {
          const result = await send_interactive_message({
            card: content as Record<string, unknown>,
            actionPrompts,
            chatId,
            parentMessageId,
          });
          return toolSuccess(result.success ? result.message : `⚠️ ${result.message || result.error}`);
        }

        // Simple display card
        const result = await send_message({ content, format, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      }

      return toolSuccess('❌ Error: Invalid format. Use "text" or "card".');
    } catch (error) {
      return toolSuccess(`⚠️ Message failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/**
 * send_file tool - unchanged.
 */
const sendFileDefinition: InlineToolDefinition = {
  name: 'send_file',
  description: 'Send a file to a chat.',
  parameters: z.object({ filePath: z.string(), chatId: z.string() }),
  handler: async ({ filePath, chatId }) => {
    try {
      const result = await send_file({ filePath, chatId });
      return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
    } catch (error) {
      return toolSuccess(`⚠️ File send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/**
 * create_study_guide tool - the only study tool (Issue #1155).
 *
 * Other generate_* tools are deprecated. Use this unified tool instead.
 */
const createStudyGuideDefinition: InlineToolDefinition = {
  name: 'create_study_guide',
  description: `Create learning materials from content.

**Unified study tool** - generates summary, Q&A, flashcards, and quiz.

---

## Parameters

| Parameter | Description |
|-----------|-------------|
| content | The text content to process |
| title | Study guide title (default: "Study Guide") |
| include | Which components: {summary, qa, flashcards, quiz} |
| outputPath | Optional file path to save |

---

## Example

\`\`\`json
{
  "content": "Course material...",
  "title": "Machine Learning Guide",
  "include": {"summary": true, "qa": true, "flashcards": true, "quiz": true}
}
\`\`\`

---

**Note:** Individual generate_* tools (generate_summary, generate_qa_pairs, etc.) are deprecated. Use create_study_guide instead.`,
  parameters: z.object({
    content: z.string(),
    title: z.string().optional(),
    include: z.object({
      summary: z.boolean().optional(),
      qa: z.boolean().optional(),
      flashcards: z.boolean().optional(),
      quiz: z.boolean().optional(),
    }).optional(),
    outputPath: z.string().optional(),
  }),
  handler: (options) => {
    try {
      const result = create_study_guide(options);
      if (!result.success) {
        return Promise.resolve(toolSuccess(`⚠️ ${result.error}`));
      }
      let output = '✅ Study Guide created!\n';
      if (result.outputPath) {
        output += `Saved to: ${result.outputPath}\n\n`;
      }
      // Show first 500 chars of the guide
      const preview = result.studyGuide.slice(0, 500);
      output += preview + (result.studyGuide.length > 500 ? '...\n\n[Content truncated]' : '');
      return Promise.resolve(toolSuccess(output));
    } catch (error) {
      return Promise.resolve(toolSuccess(`⚠️ Study guide failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  },
};

// ============================================================================
// Exports
// ============================================================================

/**
 * Consolidated tool definitions (Issue #1155).
 *
 * Tools: send_message (unified), send_file, create_study_guide
 * Total: 3 tools (down from 9)
 */
export const feishuToolDefinitions: InlineToolDefinition[] = [
  unifiedSendMessageDefinition,
  sendFileDefinition,
  createStudyGuideDefinition,
];

export const feishuSdkTools = feishuToolDefinitions.map(def => getProvider().createInlineTool(def));

export function createFeishuSdkMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'context-mcp',
    version: '1.0.0',
    tools: feishuToolDefinitions,
  });
}

// Legacy exports for backward compatibility
export const feishuContextTools = {
  send_message: {
    description: unifiedSendMessageDefinition.description,
    parameters: {
      type: 'object',
      properties: {
        content: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        format: { type: 'string', enum: ['text', 'card'] },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string' },
        actionPrompts: { type: 'object', additionalProperties: { type: 'string' } },
        ask: { type: 'object' },
      },
      required: ['format', 'chatId'],
    },
    handler: async (params: Record<string, unknown>) => {
      const result = await unifiedSendMessageDefinition.handler(params as Parameters<typeof unifiedSendMessageDefinition.handler>[0]);
      return result;
    },
  },
  send_file: {
    description: sendFileDefinition.description,
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' }, chatId: { type: 'string' } },
      required: ['filePath', 'chatId'],
    },
    handler: send_file,
  },
};
