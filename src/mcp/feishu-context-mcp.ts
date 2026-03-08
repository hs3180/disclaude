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
  start_discussion,
  setMessageSentCallback,
  create_study_guide,
  reply_in_thread,
  get_threads,
  get_thread_messages,
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
export {
  start_discussion,
  registerDiscussionCallback,
  getDiscussionCallback,
  unregisterDiscussionCallback,
  cleanupExpiredDiscussionCallbacks,
} from './tools/start-discussion.js';
export type {
  StartDiscussionOptions,
  StartDiscussionResult,
  DiscussionResponseCallback,
} from './tools/start-discussion.js';

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
  // Reduced from 9 tools to 4 tools (~1600 tokens -> ~400 tokens)
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
    name: 'create_study_guide',
    description: `Create study materials from content (NotebookLM feature).

Generates: summary, Q&A pairs, flashcards, and quiz questions.

## Parameters
- **content**: Text content to process
- **title**: Study guide title (default: "Study Guide")
- **include**: Components to include (default: all)
  - summary, qa, flashcards, quiz (booleans)

## Example
\`\`\`json
{
  "content": "Course material...",
  "title": "ML Study Guide",
  "include": {"summary": true, "qa": true, "flashcards": true, "quiz": false}
}
\`\`\``,
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
        let output = 'Study Guide created!\n';
        if (result.outputPath) {
          output += `Saved: ${result.outputPath}\n\n`;
        }
        output += result.studyGuide;
        return Promise.resolve(toolSuccess(output));
      } catch (error) {
        return Promise.resolve(toolSuccess(`⚠️ Failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
  },
  // Thread Tools (Issue #873: Topic group extension)
  {
    name: 'reply_in_thread',
    description: `Reply to a message in a thread (follow-up post).

In a topic-mode chat, this creates a reply to a thread. The message will appear as a follow-up post in the thread.

---

## 🎯 Use Cases

### 1. Follow-up Discussion
Reply to a topic to continue the discussion without starting a new thread.

### 2. Answer Questions
Provide answers to questions posted in a thread.

### 3. Add Information
Add additional information or updates to an existing topic.

---

## Parameters

- **messageId**: The message ID to reply to (root message of the thread, starts with "om_")
- **content**: Message content (text or card JSON string)
- **format**: Message format - "text" or "card"

---

## Example

\`\`\`json
{
  "messageId": "om_xxx",
  "content": "这是对帖子的回复内容",
  "format": "text"
}
\`\`\`

---

## Note

The \`messageId\` should be the root message of the thread (the first message in the topic), not a reply message.`,
    parameters: z.object({
      messageId: z.string(),
      content: z.string(),
      format: z.enum(['text', 'card']),
    }),
    handler: async ({ messageId, content, format }) => {
      try {
        const result = await reply_in_thread({ messageId, content, format });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Reply failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'get_threads',
    description: `Get threads (topic list) from a chat.

Retrieves the list of threads in a topic-mode chat. Each thread is represented by its root message.

---

## 🎯 Use Cases

### 1. Browse Topics
List all topics in a topic-mode chat.

### 2. Find Specific Topic
Search for a specific topic by iterating through the list.

### 3. Topic Overview
Get an overview of recent discussions in the chat.

---

## Parameters

- **chatId**: Chat ID to get threads from (starts with "oc_")
- **pageSize**: Number of threads to retrieve (default: 20, max: 50)
- **pageToken**: Page token for pagination (from previous response)

---

## Example

\`\`\`json
{
  "chatId": "oc_xxx",
  "pageSize": 20
}
\`\`\`

---

## Response

Returns an array of threads, each containing:
- **messageId**: Root message ID
- **threadId**: Thread ID (starts with "omt_")
- **contentType**: Message type (text, post, etc.)
- **content**: Message content
- **createTime**: Creation timestamp
- **senderId**: Sender's ID`,
    parameters: z.object({
      chatId: z.string(),
      pageSize: z.number().optional(),
      pageToken: z.string().optional(),
    }),
    handler: async ({ chatId, pageSize, pageToken }) => {
      try {
        const result = await get_threads({ chatId, pageSize, pageToken });
        if (!result.success) {
          return toolSuccess(`⚠️ ${result.message}`);
        }
        let output = `Threads in chat ${chatId}:\n\n`;
        for (const thread of result.threads || []) {
          output += `- **${thread.threadId}** (${thread.createTime})\n`;
          output += `  Content: ${thread.content.substring(0, 100)}${thread.content.length > 100 ? '...' : ''}\n\n`;
        }
        if (result.hasMore) {
          output += `\n_More threads available. Use pageToken: ${result.pageToken}_`;
        }
        return toolSuccess(output);
      } catch (error) {
        return toolSuccess(`⚠️ Get threads failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'get_thread_messages',
    description: `Get messages in a thread (thread detail).

Retrieves all messages in a specific thread. The first message is the root message, followed by replies.

---

## 🎯 Use Cases

### 1. Read Discussion
Read all replies in a thread to understand the full discussion.

### 2. Find Specific Reply
Locate a specific reply within a thread.

### 3. Summarize Thread
Get all messages to summarize the discussion.

---

## Parameters

- **threadId**: Thread ID to get messages from (starts with "omt_")
- **pageSize**: Number of messages to retrieve (default: 20, max: 50)
- **pageToken**: Page token for pagination (from previous response)

---

## Example

\`\`\`json
{
  "threadId": "omt_xxx",
  "pageSize": 20
}
\`\`\`

---

## Response

Returns an array of messages, each containing:
- **messageId**: Message ID
- **parentMessageId**: Parent message ID (for replies)
- **threadId**: Thread ID
- **contentType**: Message type
- **content**: Message content
- **createTime**: Creation timestamp
- **senderId**: Sender's ID`,
    parameters: z.object({
      threadId: z.string(),
      pageSize: z.number().optional(),
      pageToken: z.string().optional(),
    }),
    handler: async ({ threadId, pageSize, pageToken }) => {
      try {
        const result = await get_thread_messages({ threadId, pageSize, pageToken });
        if (!result.success) {
          return toolSuccess(`⚠️ ${result.message}`);
        }
        let output = `Messages in thread ${threadId}:\n\n`;
        for (const msg of result.messages || []) {
          const isRoot = !msg.parentMessageId;
          output += `${isRoot ? '📝' : '  ↪️'} **${msg.messageId}** (${msg.createTime})\n`;
          output += `  ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}\n\n`;
        }
        if (result.hasMore) {
          output += `\n_More messages available. Use pageToken: ${result.pageToken}_`;
        }
        return toolSuccess(output);
      } catch (error) {
        return toolSuccess(`⚠️ Get thread messages failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  // Start Discussion tool (Issue #631: 离线提问)
  {
    name: 'start_discussion',
    description: `Start a non-blocking offline discussion (Issue #631).

This tool allows you to initiate a discussion without blocking your work:
1. Creates a new discussion group (if chatId not provided)
2. Sends an initial message
3. Continues working without waiting for response

---

## 🎯 使用场景

### 1. 每日回顾讨论
\`\`\`json
{
  "topic": "每日聊天回顾 - 重复问题讨论",
  "message": "今天的聊天回顾发现了一些重复问题，想和大家讨论一下...",
  "members": ["ou_user1", "ou_user2"],
  "followUpContext": "daily-review-2024-01-15"
}
\`\`\`

### 2. 代码风格讨论
\`\`\`json
{
  "topic": "代码风格统一讨论",
  "message": "最近发现代码风格有些不一致，建议制定统一的规范...",
  "members": ["ou_dev1", "ou_dev2"],
  "isTopicGroup": true
}
\`\`\`

### 3. 在现有群发起讨论
\`\`\`json
{
  "topic": "紧急问题讨论",
  "message": "发现了一个紧急问题需要大家关注...",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameters

- **topic**: Discussion topic/title (used as group name for new groups)
- **message**: Initial message to send (non-blocking)
- **chatId**: Existing chat ID (optional - creates new group if not provided)
- **members**: User open_ids to add to new group (optional)
- **creatorId**: Creator open_id for tracking (optional)
- **followUpContext**: Context for follow-up actions when users respond (optional)
- **isTopicGroup**: Whether this is a topic group/BBS mode (optional, default: false)

---

## 非阻塞特性

与 \`ask_user\` 不同，这个工具是**非阻塞**的：
- \`ask_user\`: 发送问题后等待用户响应，阻塞当前任务
- \`start_discussion\`: 发起讨论后立即返回，继续工作

当用户回复时，系统可以根据 \`followUpContext\` 触发后续动作。

---

## Best Practices

1. **明确主题**: topic 应该清晰描述讨论内容
2. **提供上下文**: message 应包含足够的背景信息
3. **选择合适的人**: members 应该包含相关人员
4. **标记话题群**: 如果是长期讨论，设置 isTopicGroup: true`,
    parameters: z.object({
      topic: z.string(),
      message: z.string(),
      chatId: z.string().optional(),
      members: z.array(z.string()).optional(),
      creatorId: z.string().optional(),
      followUpContext: z.string().optional(),
      isTopicGroup: z.boolean().optional(),
    }),
    handler: async ({ topic, message, chatId, members, creatorId, followUpContext, isTopicGroup }) => {
      try {
        const result = await start_discussion({ topic, message, chatId, members, creatorId, followUpContext, isTopicGroup });
        if (result.success) {
          let output = result.message;
          if (result.chatId) {
            output += ` (chatId: ${result.chatId})`;
          }
          return toolSuccess(output);
        }
        return toolSuccess(`⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Start discussion failed: ${error instanceof Error ? error.message : String(error)}`);
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
