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
  ask_user,
  request_review,
  setMessageSentCallback,
  create_study_guide,
  generate_summary,
  generate_qa_pairs,
  generate_flashcards,
  generate_quiz,
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
export { request_review, quick_review } from './tools/request-review.js';

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
    name: 'send_interactive_message',
    description: `Send an interactive card message with pre-defined action prompts.

**Core Concept:** When the user interacts with the card (clicks a button, selects from menu), the corresponding prompt template is automatically converted into a message that you (the agent) receive. You don't need to wait for callbacks - just handle the incoming message naturally.

---

## 🎯 预定义模板（推荐使用）

以下是常用的交互场景模板，可直接复制使用：

### 1. 确认对话框
\`\`\`json
{
  "actionPrompts": {
    "confirm": "[用户操作] 用户点击了「确认」按钮。请继续执行任务。",
    "cancel": "[用户操作] 用户点击了「取消」按钮。任务已取消，请停止相关操作。"
  }
}
\`\`\`

### 2. 选择列表
\`\`\`json
{
  "actionPrompts": {
    "option_a": "[用户操作] 用户选择了「选项A」。请根据此选择继续。",
    "option_b": "[用户操作] 用户选择了「选项B」。请根据此选择继续。"
  }
}
\`\`\`

### 3. 审批流程
\`\`\`json
{
  "actionPrompts": {
    "approve": "[用户操作] 用户已批准。请执行批准后的操作。",
    "reject": "[用户操作] 用户已拒绝。请执行拒绝后的处理。",
    "review": "[用户操作] 用户请求更多信息。请提供详细信息后重新请求审批。"
  }
}
\`\`\`

### 4. 文件操作
\`\`\`json
{
  "actionPrompts": {
    "view": "[用户操作] 用户选择查看详情。请展示完整信息。",
    "edit": "[用户操作] 用户选择编辑。请提供编辑界面或指导。",
    "delete": "[用户操作] 用户选择删除。请确认删除操作。"
  }
}
\`\`\`

---

## 自定义 actionPrompts

如果预定义模板不满足需求，可以自定义 prompt。支持以下占位符：

| 占位符 | 说明 | 示例值 |
|--------|------|--------|
| \`{{actionText}}\` | 按钮显示文本 | "确认" |
| \`{{actionValue}}\` | 按钮的 value 值 | "confirm" |
| \`{{actionType}}\` | 组件类型 | "button" |

**自定义示例：**
\`\`\`json
{
  "actionPrompts": {
    "custom": "用户点击了「{{actionText}}」(值: {{actionValue}})，请处理。"
  }
}
\`\`\`

---

## Parameters

- **card**: The interactive card JSON structure (same as send_message with format="card")
- **actionPrompts**: Map of action values to prompt templates
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply

---

## Interactive Components

### 1. Button (tag: "button")
\`\`\`json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "Click Me" },
  "value": "action_1",
  "type": "primary"
}
\`\`\`
- **value**: Used as key in actionPrompts
- **type**: "primary" (blue), "default" (white), "danger" (red)

### 2. Select Menu (tag: "select_static")
\`\`\`json
{
  "tag": "select_static",
  "placeholder": { "tag": "plain_text", "content": "Choose..." },
  "options": [
    { "text": { "tag": "plain_text", "content": "Option A" }, "value": "opt_a" },
    { "text": { "tag": "plain_text", "content": "Option B" }, "value": "opt_b" }
  ]
}
\`\`\`
- Selected option's **value** is used as key in actionPrompts

### 3. Overflow Menu (tag: "overflow")
\`\`\`json
{
  "tag": "overflow",
  "options": [
    { "text": { "tag": "plain_text", "content": "Edit" }, "value": "edit" },
    { "text": { "tag": "plain_text", "content": "Delete" }, "value": "delete" }
  ]
}
\`\`\`

### 4. Date Picker (tag: "datepicker")
\`\`\`json
{
  "tag": "datepicker",
  "placeholder": { "tag": "plain_text", "content": "Select date" }
}
\`\`\`
- actionPrompts key is the selected date (YYYY-MM-DD format)

### 5. Input Field (tag: "input")
\`\`\`json
{
  "tag": "input",
  "placeholder": { "tag": "plain_text", "content": "Enter text" },
  "element": { "tag": "plain_input" }
}
\`\`\`

---

## Prompt Template Placeholders

In actionPrompts, you can use these placeholders:

| Placeholder | Description | Example |
|-------------|-------------|---------|
| \`{{actionText}}\` | Display text of clicked button/option | "Confirm" |
| \`{{actionValue}}\` | Value of the action | "confirm" |
| \`{{actionType}}\` | Type of component | "button", "select_static" |
| \`{{form.fieldName}}\` | Form field value | User input |

---

## Complete Example

\`\`\`json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": {
      "title": { "tag": "plain_text", "content": "Confirm Action" },
      "template": "blue"
    },
    "elements": [
      {
        "tag": "markdown",
        "content": "Do you want to proceed?"
      },
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": { "tag": "plain_text", "content": "✓ Confirm" },
            "value": "confirm",
            "type": "primary"
          },
          {
            "tag": "button",
            "text": { "tag": "plain_text", "content": "✗ Cancel" },
            "value": "cancel",
            "type": "default"
          }
        ]
      }
    ]
  },
  "actionPrompts": {
    "confirm": "[用户操作] 用户点击了「确认」按钮。请继续执行任务。",
    "cancel": "[用户操作] 用户点击了「取消」按钮。任务已取消，请停止相关操作。"
  },
  "chatId": "oc_xxx"
}
\`\`\`

---

## Best Practices

1. **Clear action values**: Use descriptive values like "approve", "reject", "view_details"
2. **Informative prompts**: Write prompts that give clear context about what happened
3. **Handle all actions**: Define prompts for all possible interactions
4. **Use Chinese prompts**: The system is designed for Chinese users

---

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      card: z.object({}).passthrough(),
      actionPrompts: z.record(z.string(), z.string()),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
    }),
    handler: async ({ card, actionPrompts, chatId, parentMessageId }) => {
      try {
        const result = await send_interactive_message({ card, actionPrompts, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Interactive message failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'ask_user',
    description: `Ask the user a question with predefined options (Human-in-the-Loop).

This tool provides a simple way for agents to ask users questions and receive responses.
When the user selects an option, you will receive a message with the selection context.

---

## 🎯 常用场景

### 1. PR 审核流程
\`\`\`json
{
  "question": "发现新的 PR #123: Fix authentication bug\\n\\n请选择处理方式:",
  "options": [
    { "text": "✓ 合并", "value": "merge", "style": "primary", "action": "合并此 PR" },
    { "text": "✗ 关闭", "value": "close", "style": "danger", "action": "关闭此 PR" },
    { "text": "⏳ 等待", "value": "wait", "action": "稍后再处理" }
  ],
  "context": "PR #123 from scheduled scan",
  "title": "🔔 PR 审核请求",
  "chatId": "oc_xxx"
}
\`\`\`

### 2. 确认操作
\`\`\`json
{
  "question": "确定要删除这个文件吗？此操作不可撤销。",
  "options": [
    { "text": "确认删除", "value": "confirm", "style": "danger", "action": "执行删除操作" },
    { "text": "取消", "value": "cancel", "action": "取消删除操作" }
  ],
  "chatId": "oc_xxx"
}
\`\`\`

### 3. 选择方向
\`\`\`json
{
  "question": "请选择实现方案:",
  "options": [
    { "text": "方案 A (推荐)", "value": "option_a", "style": "primary", "action": "使用方案 A 实现" },
    { "text": "方案 B", "value": "option_b", "action": "使用方案 B 实现" },
    { "text": "方案 C", "value": "option_c", "action": "使用方案 C 实现" }
  ],
  "context": "Issue #456 功能实现",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameters

- **question**: The question text (supports Markdown)
- **options**: Array of options (1-5 recommended)
  - **text**: Button display text
  - **value**: Unique value for this option (optional, defaults to option_N)
  - **style**: Button style - "primary" (blue), "default" (white), "danger" (red)
  - **action**: Description of what to do when this option is selected
- **context**: Additional context information (optional)
- **title**: Card title (optional, default: "🤖 Agent 提问")
- **chatId**: Target chat ID
- **parentMessageId**: Optional, for thread reply

---

## How It Works

1. You call ask_user with a question and options
2. A card with buttons is sent to the user
3. When the user clicks a button, you receive a message like:
   \`[用户操作] 用户选择了「合并」选项。\n\n**上下文**: PR #123\n\n**请执行**: 合并此 PR\`
4. You continue execution based on the selection

---

## Best Practices

1. **Include context**: Always provide enough context for future reference
2. **Clear actions**: Specify what action to take for each option
3. **Limit options**: 2-4 options work best for quick decisions
4. **Use styles**: Use "primary" for recommended, "danger" for destructive actions`,
    parameters: z.object({
      question: z.string(),
      options: z.array(z.object({
        text: z.string(),
        value: z.string().optional(),
        style: z.enum(['primary', 'default', 'danger']).optional(),
        action: z.string().optional(),
      })),
      context: z.string().optional(),
      title: z.string().optional(),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
    }),
    handler: async ({ question, options, context, title, chatId, parentMessageId }) => {
      try {
        const result = await ask_user({ question, options, context, title, chatId, parentMessageId });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Ask user failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  // Request Review Tool (Issue #946: 御书房批奏折体验)
  {
    name: 'request_review',
    description: `Request user review with a structured "御书房批奏折" (Imperial Study Review) card.

This tool provides a streamlined review experience with quick action buttons.
When the user clicks a button, you will receive a message with the action context.

---

## 🎯 主题风格

| 主题 | 描述 | 按钮文案 |
|------|------|----------|
| \`imperial\` | 御书房 - 古典宫廷风 | 👑 准奏 / ❌ 驳回 / 📝 再议 |
| \`modern\` | 现代 - 专业简洁 | ✅ 批准 / ❌ 拒绝 / 🔄 需要修改 |
| \`minimal\` | 简约 - 极简风格 | 同意 / 拒绝 / 修改 |

---

## 📋 使用场景

### 1. 代码变更审查
\`\`\`json
{
  "title": "代码变更请求",
  "summary": "修复了用户认证的 bug",
  "theme": "imperial",
  "changes": [
    { "path": "src/auth.ts", "type": "modified", "additions": 50, "deletions": 10 }
  ],
  "context": "PR #123",
  "chatId": "oc_xxx"
}
\`\`\`

### 2. 带 Diff 预览的审查
\`\`\`json
{
  "title": "代码审查",
  "summary": "重构了数据库连接模块",
  "diff": "--- a/db.ts\\n+++ b/db.ts\\n...",
  "chatId": "oc_xxx"
}
\`\`\`

### 3. 批量审批
\`\`\`json
{
  "title": "批量审批",
  "items": [
    { "name": "PR #101", "description": "Fix login bug" },
    { "name": "PR #102", "description": "Add dark mode" }
  ],
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameters

- **title**: Review title/subject (required)
- **summary**: Review summary/description
- **theme**: "imperial" | "modern" | "minimal" (default: "modern")
- **changes**: List of changes with path, type, additions, deletions
- **diff**: Diff content to display (for code reviews)
- **items**: Items for batch review
- **context**: Context information (e.g., PR number)
- **chatId**: Target chat ID (required)
- **parentMessageId**: Optional, for thread reply

---

## How It Works

1. You call request_review with title and optional changes/diff
2. A beautifully formatted review card is sent to the user
3. When the user clicks a button, you receive a message like:
   \`[用户操作] 用户批准：PR #123。请继续执行后续操作。\`
4. You continue execution based on the action`,
    parameters: z.object({
      title: z.string(),
      summary: z.string().optional(),
      theme: z.enum(['imperial', 'modern', 'minimal']).optional(),
      changes: z.array(z.object({
        path: z.string(),
        type: z.enum(['added', 'modified', 'deleted', 'renamed']),
        description: z.string().optional(),
        additions: z.number().optional(),
        deletions: z.number().optional(),
      })).optional(),
      diff: z.string().optional(),
      maxDiffLines: z.number().optional(),
      items: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
      })).optional(),
      context: z.string().optional(),
      details: z.string().optional(),
      footerNote: z.string().optional(),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
    }),
    handler: async (params) => {
      try {
        const result = await request_review(params);
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Request review failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  // NotebookLM Study Guide Tools (Issue #950 M4)
  {
    name: 'generate_summary',
    description: `Generate a structured summary from content.

Part of NotebookLM features - generates summaries in different styles.

## Parameters
- **content**: The text content to summarize
- **maxLength**: Maximum length in words (default: 200)
- **style**: Summary style - "brief", "detailed", or "bullet" (default: "bullet")

## Styles
- **brief**: 2-3 sentence concise summary
- **detailed**: Comprehensive summary with sections
- **bullet**: Bullet-point summary of main topics

## Example
\`\`\`json
{
  "content": "Long text to summarize...",
  "maxLength": 150,
  "style": "bullet"
}
\`\`\``,
    parameters: z.object({
      content: z.string(),
      maxLength: z.number().optional(),
      style: z.enum(['brief', 'detailed', 'bullet']).optional(),
    }),
    handler: (options) => {
      try {
        const result = generate_summary(options);
        return Promise.resolve(toolSuccess(result.success
          ? `Summary (${result.wordCount} words):\n\n${result.summary}`
          : `⚠️ ${result.error}`));
      } catch (error) {
        return Promise.resolve(toolSuccess(`⚠️ Summary generation failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
  },
  {
    name: 'generate_qa_pairs',
    description: `Generate Q&A pairs from content.

Part of NotebookLM features - creates question-answer pairs for study.

## Parameters
- **content**: The text content to generate Q&A from
- **count**: Number of Q&A pairs to generate (default: 5)
- **includeDifficulty**: Include difficulty ratings (default: true)
- **focusTopics**: Optional topics to focus on

## Example
\`\`\`json
{
  "content": "Learning material...",
  "count": 10,
  "includeDifficulty": true,
  "focusTopics": ["key concept 1", "key concept 2"]
}
\`\`\``,
    parameters: z.object({
      content: z.string(),
      count: z.number().optional(),
      includeDifficulty: z.boolean().optional(),
      focusTopics: z.array(z.string()).optional(),
    }),
    handler: (options) => {
      try {
        const result = generate_qa_pairs(options);
        return Promise.resolve(toolSuccess(result.success
          ? `Q&A Generation (${result.count} pairs):\n\n${result.qaPairs[0]?.question || 'No pairs generated'}`
          : `⚠️ ${result.error}`));
      } catch (error) {
        return Promise.resolve(toolSuccess(`⚠️ Q&A generation failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
  },
  {
    name: 'generate_flashcards',
    description: `Generate flashcards from content.

Part of NotebookLM features - creates flashcards for spaced repetition learning.

## Parameters
- **content**: The text content to generate flashcards from
- **count**: Number of flashcards to generate (default: 10)
- **deckName**: Name for the flashcard deck (default: "Study Deck")
- **format**: Output format - "json", "anki", or "csv" (default: "json")

## Example
\`\`\`json
{
  "content": "Study material...",
  "count": 20,
  "deckName": "Machine Learning Basics",
  "format": "anki"
}
\`\`\`

## Formats
- **json**: Returns structured flashcard data
- **anki**: Returns tab-separated format for Anki import
- **csv**: Returns CSV format`,
    parameters: z.object({
      content: z.string(),
      count: z.number().optional(),
      deckName: z.string().optional(),
      format: z.enum(['json', 'anki', 'csv']).optional(),
    }),
    handler: (options) => {
      try {
        const result = generate_flashcards(options);
        if (!result.success) {
          return Promise.resolve(toolSuccess(`⚠️ ${result.error}`));
        }
        let output = `Flashcards (${result.count} cards, Deck: "${result.flashcards[0]?.deck || 'Study Deck'}"):\n\n`;
        if (options.format === 'anki' && result.ankiOutput) {
          output += result.ankiOutput;
        } else if (options.format === 'csv' && result.csvOutput) {
          output += result.csvOutput;
        } else {
          output += result.flashcards[0]?.front || 'No flashcards generated';
        }
        return Promise.resolve(toolSuccess(output));
      } catch (error) {
        return Promise.resolve(toolSuccess(`⚠️ Flashcard generation failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
  },
  {
    name: 'generate_quiz',
    description: `Generate quiz questions from content.

Part of NotebookLM features - creates quiz questions for assessment.

## Parameters
- **content**: The text content to generate quiz from
- **count**: Number of questions to generate (default: 10)
- **questionTypes**: Types to include (default: all types)
  - "multiple_choice": Multiple choice with 4 options
  - "true_false": True/false statements
  - "fill_blank": Fill in the blank questions
- **includeExplanations**: Include answer explanations (default: true)
- **totalPoints**: Total points for the quiz (default: 100)

## Example
\`\`\`json
{
  "content": "Course material...",
  "count": 15,
  "questionTypes": ["multiple_choice", "true_false"],
  "includeExplanations": true,
  "totalPoints": 50
}
\`\`\``,
    parameters: z.object({
      content: z.string(),
      count: z.number().optional(),
      questionTypes: z.array(z.enum(['multiple_choice', 'true_false', 'fill_blank'])).optional(),
      includeExplanations: z.boolean().optional(),
      totalPoints: z.number().optional(),
    }),
    handler: (options) => {
      try {
        const result = generate_quiz(options);
        if (!result.success) {
          return Promise.resolve(toolSuccess(`⚠️ ${result.error}`));
        }
        return Promise.resolve(toolSuccess(`Quiz (${result.count} questions, ${result.totalPoints} points):\n\n${result.markdownQuiz || 'No quiz generated'}`));
      } catch (error) {
        return Promise.resolve(toolSuccess(`⚠️ Quiz generation failed: ${error instanceof Error ? error.message : String(error)}`));
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
