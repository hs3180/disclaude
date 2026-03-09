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
  create_study_guide,
  spawn_subagents,
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
  // Master-Workers Multi-Agent Collaboration (Issue #897)
  {
    name: 'spawn_subagents',
    description: `Spawn multiple subagents in parallel to execute tasks concurrently.

This tool implements the master-workers pattern for parallel task execution.

---

## 🎯 Use Cases

1. **Parallel File Processing**: Analyze multiple files simultaneously
2. **Multi-source Information Gathering**: Search multiple sources in parallel
3. **Task Decomposition**: Break complex tasks into smaller parallel tasks
4. **Batch Operations**: Execute similar operations on multiple items

---

## Parameters

- **tasks**: Array of tasks to execute in parallel
  - **type**: Subagent type - "task", "skill", or "schedule"
  - **name**: Identifier for this task
  - **prompt**: The task prompt/instruction
  - **templateVars**: Optional variables for skill agents
- **maxParallel**: Maximum concurrent executions (default: 3)
- **timeout**: Total timeout in ms (default: 300000 = 5 minutes)
- **continueOnFailure**: Continue if a task fails (default: true)

---

## Example: Parallel File Analysis

\`\`\`json
{
  "tasks": [
    { "type": "task", "name": "analyze-src", "prompt": "Analyze the src/ directory structure" },
    { "type": "task", "name": "analyze-tests", "prompt": "Analyze the test coverage" },
    { "type": "task", "name": "analyze-docs", "prompt": "Review the documentation" }
  ],
  "maxParallel": 3,
  "continueOnFailure": true
}
\`\`\`

---

## Example: Skill Agent Parallel Execution

\`\`\`json
{
  "tasks": [
    { "type": "skill", "name": "site-miner", "prompt": "Extract data from example.com" },
    { "type": "skill", "name": "site-miner", "prompt": "Extract data from docs.example.com" }
  ],
  "maxParallel": 2
}
\`\`\`

---

## Result Format

Returns a summary with:
- Success/failure count
- Duration statistics
- Individual task results
- Error details for failures

---

## Best Practices

1. **Limit parallelism**: 2-4 concurrent tasks for best performance
2. **Handle failures**: Use continueOnFailure for fault tolerance
3. **Set appropriate timeouts**: Complex tasks may need longer timeouts
4. **Use meaningful names**: Helps identify results in the summary`,
    parameters: z.object({
      tasks: z.array(z.object({
        type: z.enum(['task', 'skill', 'schedule']),
        name: z.string(),
        prompt: z.string(),
        templateVars: z.record(z.string(), z.string()).optional(),
      })),
      maxParallel: z.number().optional(),
      timeout: z.number().optional(),
      continueOnFailure: z.boolean().optional(),
    }),
    handler: async (options) => {
      try {
        const result = await spawn_subagents(options);
        if (result.success) {
          return toolSuccess(`${result.message}\n\n${result.summary || ''}`);
        } else {
          return toolSuccess(`⚠️ ${result.message}${result.summary ? `\n\n${result.summary}` : ''}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Spawn subagents failed: ${error instanceof Error ? error.message : String(error)}`);
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
