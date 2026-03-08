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
  leave_message,
  ask_user,
  setMessageSentCallback,
  generate_summary,
  generate_qa_pairs,
  generate_flashcards,
  generate_quiz,
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
  leave_message: {
    description: `Send a non-blocking message for offline interaction.

**核心概念**：与 \`send_interactive_message\` 不同，此工具：
1. **不阻塞等待回复** - Agent 可以继续执行其他任务
2. **用户回复后触发新任务** - 不是恢复当前任务，而是启动全新的任务
3. **包含上下文信息** - 新任务会收到原任务的背景信息

---

## 与 \`send_interactive_message\` 的区别

| 特性 | send_interactive_message | leave_message |
|------|--------------------------|---------------|
| Agent 行为 | 等待回复后继续 | 继续工作，不等待 |
| 回复处理 | 恢复当前任务 | **触发新任务** |
| 适用场景 | 即时决策、快速确认 | 离线讨论、异步反馈 |

---

## 使用场景

### 1. 每日回顾分析后发起讨论
\`\`\`json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": { "title": { "tag": "plain_text", "content": "需要您的反馈" } },
    "elements": [
      { "tag": "markdown", "content": "分析发现您多次要求修正代码格式问题..." },
      {
        "tag": "action",
        "actions": [
          { "tag": "button", "text": { "tag": "plain_text", "content": "创建 Skill" }, "value": "create_skill", "type": "primary" },
          { "tag": "button", "text": { "tag": "plain_text", "content": "忽略" }, "value": "ignore" }
        ]
      }
    ]
  },
  "actionPrompts": {
    "create_skill": "用户选择创建 Skill 来自动化处理此问题。",
    "ignore": "用户选择忽略此问题。"
  },
  "taskContext": "每日聊天回顾分析：发现用户多次要求修正代码格式问题，建议创建 Skill 来自动化处理",
  "followUpPrompt": "## 背景\\n{{taskContext}}\\n\\n## 用户决策\\n{{actionPrompt}}\\n\\n## 请执行\\n根据用户的决策，执行相应的后续操作（如创建 Skill 或记录反馈）。",
  "chatId": "oc_xxx"
}
\`\`\`

### 2. 代码重构方案征求同意
\`\`\`json
{
  "card": { ... },
  "actionPrompts": {
    "agree": "用户同意了重构方案。",
    "disagree": "用户反对重构方案。",
    "discuss": "用户希望进一步讨论。"
  },
  "taskContext": "代码重构方案：将 utils 模块拆分为独立包",
  "followUpPrompt": "## 背景\\n{{taskContext}}\\n\\n## 用户反馈\\n{{actionPrompt}}\\n\\n## 请执行\\n根据用户的反馈，执行相应的后续操作。",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameters

- **card**: 交互卡片 JSON 结构（与 send_interactive_message 相同）
- **actionPrompts**: 动作值到提示模板的映射
- **taskContext**: 原任务的上下文描述（用于新任务理解背景）
- **followUpPrompt**: 新任务的提示模板，支持以下占位符：
  - \`{{taskContext}}\` - 原任务上下文
  - \`{{actionPrompt}}\` - 用户选择的动作提示
- **chatId**: 目标群聊 ID
- **parentMessageId**: 可选，用于话题回复
- **expirationMs**: 可选，过期时间（毫秒），默认 7 天

---

## followUpPrompt 模板示例

\`\`\`
## 背景
{{taskContext}}

## 用户反馈
{{actionPrompt}}

## 请执行
根据用户的反馈，执行相应的后续操作。
\`\`\``,
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'object' },
        actionPrompts: { type: 'object', additionalProperties: { type: 'string' } },
        taskContext: { type: 'string', description: '原任务的上下文描述' },
        followUpPrompt: { type: 'string', description: '新任务的提示模板' },
        chatId: { type: 'string' },
        parentMessageId: { type: 'string' },
        expirationMs: { type: 'number', description: '过期时间（毫秒），默认 7 天' },
      },
      required: ['card', 'actionPrompts', 'taskContext', 'followUpPrompt', 'chatId'],
    },
    handler: leave_message,
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
  {
    name: 'send_message',
    description: `Send a simple message to a chat.

**For interactive cards with buttons/actions, use \`send_interactive_message\` instead.**

---

## Usage

### Text Message (Recommended)
\`\`\`json
{"content": "Hello", "format": "text", "chatId": "oc_xxx"}
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
    description: `Create a complete study guide with all learning materials.

Part of NotebookLM features - generates comprehensive study materials including:
- Summary of the content
- Q&A pairs for review
- Flashcards for memorization
- Quiz for self-assessment

## Parameters
- **content**: The text content to create study guide from
- **title**: Title for the study guide (default: "Study Guide")
- **include**: Which components to include (default: all)
  - summary: boolean
  - qa: boolean
  - flashcards: boolean
  - quiz: boolean
- **outputPath**: Optional file path to save the study guide

## Example
\`\`\`json
{
  "content": "Course material...",
  "title": "Machine Learning Study Guide",
  "include": {
    "summary": true,
    "qa": true,
    "flashcards": true,
    "quiz": true
  }
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
        let output = 'Study Guide created successfully!\n';
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
  // Issue #631: 离线提问 - 非阻塞交互
  {
    name: 'leave_message',
    description: `Send a non-blocking message for offline interaction.

**核心概念**：与 \`send_interactive_message\` 不同，此工具：
1. **不阻塞等待回复** - Agent 可以继续执行其他任务
2. **用户回复后触发新任务** - 不是恢复当前任务，而是启动全新的任务
3. **包含上下文信息** - 新任务会收到原任务的背景信息

---

## 与 \`send_interactive_message\` 的区别

| 特性 | send_interactive_message | leave_message |
|------|--------------------------|---------------|
| Agent 行为 | 等待回复后继续 | 继续工作，不等待 |
| 回复处理 | 恢复当前任务 | **触发新任务** |
| 适用场景 | 即时决策、快速确认 | 离线讨论、异步反馈 |

---

## 使用场景

### 1. 每日回顾分析后发起讨论
\`\`\`json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": { "title": { "tag": "plain_text", "content": "需要您的反馈" } },
    "elements": [
      { "tag": "markdown", "content": "分析发现您多次要求修正代码格式问题..." },
      {
        "tag": "action",
        "actions": [
          { "tag": "button", "text": { "tag": "plain_text", "content": "创建 Skill" }, "value": "create_skill", "type": "primary" },
          { "tag": "button", "text": { "tag": "plain_text", "content": "忽略" }, "value": "ignore" }
        ]
      }
    ]
  },
  "actionPrompts": {
    "create_skill": "用户选择创建 Skill 来自动化处理此问题。",
    "ignore": "用户选择忽略此问题。"
  },
  "taskContext": "每日聊天回顾分析：发现用户多次要求修正代码格式问题，建议创建 Skill 来自动化处理",
  "followUpPrompt": "## 背景\\n{{taskContext}}\\n\\n## 用户决策\\n{{actionPrompt}}\\n\\n## 请执行\\n根据用户的决策，执行相应的后续操作。",
  "chatId": "oc_xxx"
}
\`\`\`

---

## Parameters

- **card**: 交互卡片 JSON 结构（与 send_interactive_message 相同）
- **actionPrompts**: 动作值到提示模板的映射
- **taskContext**: 原任务的上下文描述（用于新任务理解背景）
- **followUpPrompt**: 新任务的提示模板，支持以下占位符：
  - \`{{taskContext}}\` - 原任务上下文
  - \`{{actionPrompt}}\` - 用户选择的动作提示
- **chatId**: 目标群聊 ID
- **parentMessageId**: 可选，用于话题回复
- **expirationMs**: 可选，过期时间（毫秒），默认 7 天`,
    parameters: z.object({
      card: z.object({}).passthrough(),
      actionPrompts: z.record(z.string(), z.string()),
      taskContext: z.string(),
      followUpPrompt: z.string(),
      chatId: z.string(),
      parentMessageId: z.string().optional(),
      expirationMs: z.number().optional(),
    }),
    handler: async ({ card, actionPrompts, taskContext, followUpPrompt, chatId, parentMessageId, expirationMs }) => {
      try {
        const result = await leave_message({ card, actionPrompts, taskContext, followUpPrompt, chatId, parentMessageId, expirationMs });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Leave message failed: ${error instanceof Error ? error.message : String(error)}`);
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
