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

export const feishuContextTools = {
  send_message: {
    description: `Send a simple message to a chat.

**For interactive cards with buttons/actions, use \`send_interactive_message\` instead.**

---

## Usage

### Text Message (Recommended)
\`\`\`json
{"content": "Hello world", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Display-Only Card (No interactions)
\`\`\`json
{
  "content": {"config": {}, "header": {"title": {"tag": "plain_text", "content": "Title"}}, "elements": []},
  "format": "card",
  "chatId": "oc_xxx"
}
\`\`\`

---

## ⚠️ Important Notes

- **Interactive cards**: Use \`send_interactive_message\` with actionPrompts
- **Card content**: Must be an OBJECT (not JSON string)
- **Thread reply**: Use parentMessageId parameter

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
    handler: send_message,
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
  send_interactive_message: {
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
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'object' },
        actionPrompts: { type: 'object', additionalProperties: { type: 'string' } },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string' },
      },
      required: ['card', 'actionPrompts', 'chatId'],
    },
    handler: send_interactive_message,
  },
  ask_user: {
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
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              value: { type: 'string' },
              style: { type: 'string', enum: ['primary', 'default', 'danger'] },
              action: { type: 'string' },
            },
            required: ['text'],
          },
        },
        context: { type: 'string' },
        title: { type: 'string' },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string' },
      },
      required: ['question', 'options', 'chatId'],
    },
    handler: ask_user,
  },
};

export const feishuToolDefinitions: InlineToolDefinition[] = [
  // ============================================================================
  // CONSOLIDATED TOOL: send_message
  // Issue #1155: Merged send_message + send_interactive_message + ask_user
  // Token reduction: ~1200 -> ~400 tokens (75% reduction)
  // ============================================================================
  {
    name: 'send_message',
    description: `Send a message to a chat. Supports text, cards, and interactive elements.

**Modes:**
1. **Text**: Simple text message
2. **Card**: Display-only card (no interactions)
3. **Interactive**: Card with buttons (requires actionPrompts)
4. **Question**: Ask user with options (requires options array)

---

## Examples

### Text Message
\`\`\`json
{"content": "Hello!", "format": "text", "chatId": "oc_xxx"}
\`\`\`

### Interactive Card (Confirm/Cancel)
\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"tag": "plain_text", "content": "确认操作"}},
    "elements": [
      {"tag": "markdown", "content": "确定继续？"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "确认"}, "value": "ok", "type": "primary"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "取消"}, "value": "cancel"}
      ]}
    ]
  },
  "format": "card",
  "actionPrompts": {"ok": "用户确认，继续执行", "cancel": "用户取消"},
  "chatId": "oc_xxx"
}
\`\`\`

### Ask User Question
\`\`\`json
{
  "content": "如何处理这个 PR？",
  "format": "card",
  "options": [
    {"text": "合并", "value": "merge", "action": "执行合并"},
    {"text": "关闭", "value": "close", "style": "danger", "action": "关闭 PR"}
  ],
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| content | Yes | Message content (string for text, object for card) |
| format | Yes | "text" or "card" |
| chatId | Yes | Target chat ID |
| parentMessageId | No | For thread reply |
| actionPrompts | No | Map of action values to prompts (interactive mode) |
| options | No | Array of options (question mode) |
| title | No | Card title (question mode, default: "🤖 Agent 提问") |
| context | No | Additional context (question mode) |

---

## actionPrompts Template

\`\`\`json
{
  "confirm": "[用户操作] 用户点击了「确认」。请继续。",
  "cancel": "[用户操作] 用户点击了「取消」。停止操作。"
}
\`\`\`

---

## options Format

\`\`\`json
[
  {"text": "按钮文字", "value": "action_value", "style": "primary", "action": "执行描述"},
  {"text": "危险操作", "value": "danger", "style": "danger"}
}
\`\`\`

**style**: "primary" (蓝), "default" (白), "danger" (红)

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags`,
    parameters: z.object({
      content: z.union([z.string(), z.object({}).passthrough()]),
      format: z.enum(['text', 'card']),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
      // Interactive mode: action prompts for card buttons
      actionPrompts: z.record(z.string(), z.string()).optional(),
      // Question mode: simplified options for ask_user
      options: z.array(z.object({
        text: z.string(),
        value: z.string().optional(),
        style: z.enum(['primary', 'default', 'danger']).optional(),
        action: z.string().optional(),
      })).optional(),
      title: z.string().optional(),
      context: z.string().optional(),
    }),
    handler: async (params) => {
      const { content, format, chatId, parentMessageId, actionPrompts, options, title, context } = params;

      // Validate format/content type consistency
      if (format === 'card' && typeof content === 'string') {
        return toolSuccess('❌ Error: When format="card", content must be an OBJECT.');
      }
      if (format === 'text' && typeof content !== 'string') {
        return toolSuccess('❌ Error: When format="text", content must be a STRING.');
      }

      try {
        // Question mode: use ask_user
        if (options && options.length > 0) {
          const result = await ask_user({
            question: typeof content === 'string' ? content : '',
            options: options.map((opt: { text: string; value?: string; style?: 'primary' | 'default' | 'danger'; action?: string }, i: number) => ({
              text: opt.text,
              value: opt.value || `option_${i}`,
              style: opt.style,
              action: opt.action,
            })),
            context,
            title,
            chatId,
            parentMessageId,
          });
          return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
        }

        // Interactive mode: use send_interactive_message
        if (actionPrompts && Object.keys(actionPrompts).length > 0) {
          if (typeof content !== 'object') {
            return toolSuccess('❌ Error: actionPrompts requires format="card" with object content.');
          }
          const result = await send_interactive_message({
            card: content as Record<string, unknown>,
            actionPrompts,
            chatId,
            parentMessageId,
          });
          return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
        }

        // Simple mode: use send_message
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
  // ============================================================================
  // CONSOLIDATED TOOL: create_study_guide
  // Issue #1155: Merged generate_summary, generate_qa_pairs, generate_flashcards,
  //              generate_quiz into create_study_guide
  // Use include parameter to select which components to generate
  // ============================================================================
  {
    name: 'create_study_guide',
    description: `Create study materials from content. Generates summary, Q&A, flashcards, and quiz.

**Use \`include\` parameter to select components:**
- \`summary\`: Structured summary
- \`qa\`: Question-answer pairs
- \`flashcards\`: Spaced repetition cards
- \`quiz\`: Self-assessment questions

---

## Examples

### Full Study Guide
\`\`\`json
{
  "content": "Course material...",
  "title": "My Study Guide"
}
\`\`\`

### Summary Only
\`\`\`json
{
  "content": "Text to summarize...",
  "include": {"summary": true, "qa": false, "flashcards": false, "quiz": false}
}
\`\`\`

### Q&A and Flashcards
\`\`\`json
{
  "content": "Learning material...",
  "include": {"summary": false, "qa": true, "flashcards": true, "quiz": false}
}
\`\`\`

---

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| content | string | required | Text content to process |
| title | string | "Study Guide" | Title for the guide |
| include.summary | boolean | true | Include summary section |
| include.qa | boolean | true | Include Q&A pairs |
| include.flashcards | boolean | true | Include flashcards |
| include.quiz | boolean | true | Include quiz |
| outputPath | string | none | Save to file (optional) |`,
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
        let output = '✅ Study materials created!\n';
        if (result.outputPath) {
          output += `Saved to: ${result.outputPath}\n\n`;
        }
        output += result.studyGuide;
        return Promise.resolve(toolSuccess(output));
      } catch (error) {
        return Promise.resolve(toolSuccess(`⚠️ Study guide creation failed: ${error instanceof Error ? error.message : String(error)}`));
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
