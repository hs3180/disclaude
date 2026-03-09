/**
 * Context MCP Tools - In-process tool implementation.
 *
 * @module mcp/feishu-context-mcp
 */

import { z } from 'zod';
import { getProvider, type InlineToolDefinition } from '../sdk/index.js';
import {
  send_message,
  send_file,
  send_interactive_message,
  setMessageSentCallback,
  request_review,
  quick_review,
  batch_review,
} from './tools/index.js';
import { startIpcServer } from './tools/interactive-message.js';
import { getGroupService } from '../platforms/feishu/group-service.js';
import { createDiscussionChat } from '../platforms/feishu/chat-ops.js';
import { getLarkClientService, isLarkClientServiceInitialized } from '../services/index.js';

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

export const feishuContextTools = {
  // Issue #1155: Consolidated tools
  send_message: {
    description: `Send a message to a chat. Supports text, card, and interactive modes.

## Modes
1. **Text**: Simple text message
2. **Card**: Display-only card (no interactions)
3. **Interactive**: Card with buttons/actions (requires actionPrompts)

## Examples

### Text Message
\`\`\`json
{"content": "Hello", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Interactive Card (with actionPrompts)
\`\`\`json
{
  "content": {"config": {}, "header": {"title": {"content": "Confirm?"}}, "elements": [
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "OK"}, "value": "ok"},
      {"tag": "button", "text": {"content": "Cancel"}, "value": "cancel"}
    ]}
  ]},
  "format": "card",
  "chatId": "oc_xxx",
  "actionPrompts": {
    "ok": "[用户] 点击了确认，继续执行",
    "cancel": "[用户] 点击了取消，停止操作"
  }
}
\`\`\`

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card`,
    parameters: {
      type: 'object',
      properties: {
        content: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        format: { type: 'string', enum: ['text', 'card'] },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string' },
        actionPrompts: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['content', 'format', 'chatId'],
    },
    handler: async (params: {
      content: string | Record<string, unknown>;
      format: 'text' | 'card';
      chatId: string;
      parentMessageId?: string;
      actionPrompts?: Record<string, string>;
    }) => {
      const { content, format, chatId, parentMessageId, actionPrompts } = params;
      // If actionPrompts provided with card, use interactive message
      if (actionPrompts && Object.keys(actionPrompts).length > 0 && format === 'card') {
        const cardContent = content as Record<string, unknown>;
        return await send_interactive_message({
          card: cardContent,
          actionPrompts,
          chatId,
          parentMessageId
        });
      }
      return await send_message({ content, format, chatId, parentMessageId });
    },
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

export const feishuToolDefinitions: InlineToolDefinition[] = [
  // ============================================================================
  // Issue #1155: Consolidated tools to reduce token overhead
  // Reduced to 4 core tools: send_message, send_file, start_group_discussion
  // ============================================================================
  {
    name: 'send_message',
    description: `Send a message to a chat. Supports text, card, and interactive modes.

## Modes
1. **Text**: Simple text message
2. **Card**: Display-only card (no interactions)
3. **Interactive**: Card with buttons/actions (requires actionPrompts)

## Examples

### Text Message
\`\`\`json
{"content": "Hello", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Interactive Card (with actionPrompts)
\`\`\`json
{
  "content": {"config": {}, "header": {"title": {"content": "Confirm?"}}, "elements": [
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "OK"}, "value": "ok"},
      {"tag": "button", "text": {"content": "Cancel"}, "value": "cancel"}
    ]}
  ]},
  "format": "card",
  "chatId": "oc_xxx",
  "actionPrompts": {
    "ok": "[用户] 点击了确认，继续执行",
    "cancel": "[用户] 点击了取消，停止操作"
  }
}
\`\`\`

## Parameters
- **content**: Text string or card object
- **format**: "text" or "card"
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply
- **actionPrompts**: Optional, enables interactive mode. Maps button values to prompts.

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      content: z.union([z.string(), z.object({}).passthrough()]),
      format: z.enum(['text', 'card']),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
      actionPrompts: z.record(z.string(), z.string()).optional(),
    }),
    handler: async ({ content, format, chatId, parentMessageId, actionPrompts }) => {
      if (format === 'card' && typeof content === 'string') {
        return toolSuccess('❌ Error: When format="card", content must be an OBJECT.');
      }
      if (format === 'text' && typeof content !== 'string') {
        return toolSuccess('❌ Error: When format="text", content must be a STRING.');
      }
      try {
        // If actionPrompts provided with card, use interactive message
        if (actionPrompts && Object.keys(actionPrompts).length > 0 && format === 'card') {
          const cardContent = content as Record<string, unknown>;
          const result = await send_interactive_message({
            card: cardContent,
            actionPrompts,
            chatId,
            parentMessageId
          });
          return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
        }
        // Otherwise use regular send_message
        const result = await send_message({ content, format, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Message send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
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
  },
  {
    name: 'start_group_discussion',
    description: `Start a group discussion on a topic and collect conclusions.

Creates a temporary group chat, invites members, and facilitates a discussion on the given topic. After the discussion concludes, the group is dissolved and the conclusions are returned.

---

## 🎯 Use Cases

1. **Deep Dive Discussion**: When a topic needs more thorough discussion than the main chat allows
2. **Stakeholder Input**: Gather input from specific people on a decision
3. **Problem Solving**: Collaboratively solve complex problems with relevant team members

---

## Parameters

- **topic**: The discussion topic/question (required)
- **members**: Array of member open_ids to invite (optional, defaults to current user)
- **context**: Background context for the discussion (optional)
- **timeout**: Discussion timeout in minutes (optional, default: 30)

---

## Example

\`\`\`json
{
  "topic": "Should we migrate to TypeScript?",
  "members": ["ou_xxx", "ou_yyy"],
  "context": "We are considering migrating our codebase from JavaScript to TypeScript.",
  "timeout": 60
}
\`\`\`

---

## Workflow

1. Creates a new group chat with the topic as the name
2. Invites specified members
3. Posts the topic and context as the first message
4. Facilitates the discussion (monitors for conclusion signals)
5. Collects and summarizes conclusions
6. Dissolves the group and returns conclusions

---

## Note

This tool initiates an async discussion. The conclusions will be returned when participants reach consensus or timeout expires.`,
    parameters: z.object({
      topic: z.string().describe('The discussion topic/question'),
      members: z.array(z.string()).optional().describe('Array of member open_ids to invite'),
      context: z.string().optional().describe('Background context for the discussion'),
      timeout: z.number().optional().describe('Discussion timeout in minutes (default: 30)'),
    }),
    handler: async ({ topic, members, context, timeout }) => {
      try {
        // Check if Feishu client is available
        if (!isLarkClientServiceInitialized()) {
          return toolSuccess('⚠️ Feishu client not configured. Cannot create group discussion.');
        }
        const client = getLarkClientService().getClient();

        // Create the discussion group
        const chatId = await createDiscussionChat(client, { topic, members });

        // Register the group for tracking
        const groupService = getGroupService();
        groupService.registerGroup({
          chatId,
          name: topic,
          createdAt: Date.now(),
          initialMembers: members || [],
        });

        // Send the initial topic message
        let initialMessage = `## 🎯 讨论话题\n\n**${topic}**\n\n`;
        if (context) {
          initialMessage += `### 背景\n${context}\n\n`;
        }
        initialMessage += `---\n请在 ${timeout || 30} 分钟内完成讨论。达成结论后请明确说明。`;

        await send_message({
          content: initialMessage,
          format: 'text',
          chatId,
        });

        return toolSuccess(`✅ 群聊讨论已启动\n- 群聊ID: ${chatId}\n- 话题: ${topic}\n- 成员数: ${members?.length || 0}\n- 超时: ${timeout || 30} 分钟\n\n请在群聊中进行讨论。讨论完成后，系统将收集结论并解散群聊。`);
      } catch (error) {
        return toolSuccess(`⚠️ Failed to start group discussion: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  // ============================================================================
  // Issue #946: 御书房批奏折体验 - Request Review Tools
  // ============================================================================
  {
    name: 'request_review',
    description: `Request user review with the "御书房批奏折" (Imperial Study Review) experience.

Sends a beautifully formatted interactive card for user approval/rejection, providing a streamlined experience for quick decision making.

---

## 🎯 Themes

| Theme | Style | Approve | Reject | Request Changes |
|-------|-------|---------|--------|-----------------|
| \`imperial\` | 🏛️ 御书房 | 👑 准奏 | ❌ 驳回 | 📝 再议 |
| \`modern\` | 📋 审批中心 | ✅ 批准 | ❌ 拒绝 | 🔄 需要修改 |
| \`minimal\` | 简洁 | 同意 | 拒绝 | 修改 |

---

## Parameters

- **title** (required): Review title
- **summary** (required): Summary/description of the review request
- **chatId** (required): Target chat ID
- **theme**: Theme style (default: "modern")
- **changes**: List of file changes with type, additions, deletions
- **details**: Additional context or details
- **context**: Context for action prompts (e.g., "PR #123")
- **parentMessageId**: For thread reply

---

## Example

\`\`\`json
{
  "title": "代码变更请求",
  "summary": "修复了用户认证的 bug",
  "theme": "imperial",
  "changes": [
    { "path": "src/auth.ts", "type": "modified", "additions": 10, "deletions": 5 },
    { "path": "tests/auth.test.ts", "type": "added", "additions": 30 }
  ],
  "chatId": "oc_xxx"
}
\`\`\``,
    parameters: z.object({
      title: z.string().describe('Review title'),
      summary: z.string().describe('Summary/description of the review request'),
      chatId: z.string().describe('Target chat ID'),
      theme: z.enum(['imperial', 'modern', 'minimal']).optional().describe('Theme style (default: modern)'),
      changes: z.array(z.object({
        path: z.string(),
        type: z.enum(['added', 'modified', 'deleted', 'renamed']),
        description: z.string().optional(),
        additions: z.number().optional(),
        deletions: z.number().optional(),
      })).optional().describe('List of changes'),
      details: z.string().optional().describe('Additional context or details'),
      context: z.string().optional().describe('Context for action prompts'),
      parentMessageId: z.string().optional().describe('Parent message ID for thread reply'),
    }),
    handler: async ({ title, summary, chatId, theme, changes, details, context, parentMessageId }) => {
      try {
        const result = await request_review({ title, summary, chatId, theme, changes, details, context, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Review request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'quick_review',
    description: `Request a quick review with approve/reject buttons only.

Use for simple decisions that don't need detailed change information.

---

## Example

\`\`\`json
{
  "title": "确认操作",
  "message": "是否继续执行删除操作？",
  "theme": "imperial",
  "chatId": "oc_xxx"
}
\`\`\``,
    parameters: z.object({
      title: z.string().describe('Review title'),
      message: z.string().describe('Review message/question'),
      chatId: z.string().describe('Target chat ID'),
      theme: z.enum(['imperial', 'modern', 'minimal']).optional().describe('Theme style'),
      parentMessageId: z.string().optional().describe('Parent message ID for thread reply'),
    }),
    handler: async ({ title, message, chatId, theme, parentMessageId }) => {
      try {
        const result = await quick_review({ title, message, chatId, theme, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Quick review request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'batch_review',
    description: `Request batch approval for multiple items.

Use when you need user to approve/reject multiple items at once.

---

## Example

\`\`\`json
{
  "title": "批量文件审批",
  "items": [
    { "name": "file1.ts", "description": "新增功能" },
    { "name": "file2.ts", "description": "修复bug" }
  ],
  "theme": "modern",
  "chatId": "oc_xxx"
}
\`\`\``,
    parameters: z.object({
      title: z.string().describe('Review title'),
      items: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
      })).describe('Items to review'),
      chatId: z.string().describe('Target chat ID'),
      theme: z.enum(['imperial', 'modern', 'minimal']).optional().describe('Theme style'),
      parentMessageId: z.string().optional().describe('Parent message ID for thread reply'),
    }),
    handler: async ({ title, items, chatId, theme, parentMessageId }) => {
      try {
        const result = await batch_review({ title, items, chatId, theme, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Batch review request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
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
