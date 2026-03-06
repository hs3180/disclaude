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
  send_interactive_message,
  setMessageSentCallback,
} from './tools/index.js';
import {
  generate_mindmap,
  generate_mindmap_from_outline,
} from './tools/mindmap-generator.js';
import { startIpcServer } from './tools/interactive-message.js';

// Re-export for backward compatibility
export type { MessageSentCallback } from './tools/types.js';
export { setMessageSentCallback };
export { resolvePendingInteraction } from './tools/card-interaction.js';
export { send_user_feedback } from './tools/send-message.js';
export { send_file_to_feishu } from './tools/send-file.js';
export { update_card, wait_for_interaction } from './tools/card-interaction.js';
export {
  send_interactive_message,
  generateInteractionPrompt,
  getActionPrompts,
} from './tools/interactive-message.js';
export {
  generate_mindmap,
  generate_mindmap_from_outline,
} from './tools/mindmap-generator.js';

// Start IPC server on module load for cross-process communication
// This allows the main process to query interactive contexts
startIpcServer().catch((error) => {
  // Log error but don't fail - IPC is optional enhancement
  console.error('[feishu-context-mcp] Failed to start IPC server:', error);
});

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
    description: 'Update an existing interactive card message.',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string' }, card: { type: 'object' }, chatId: { type: 'string' } },
      required: ['messageId', 'card', 'chatId'],
    },
    handler: update_card,
  },
  wait_for_interaction: {
    description: 'Wait for the user to interact with a card.',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string' }, chatId: { type: 'string' }, timeoutSeconds: { type: 'number' } },
      required: ['messageId', 'chatId'],
    },
    handler: wait_for_interaction,
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

- **card**: The interactive card JSON structure (same as send_user_feedback with format="card")
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
  generate_mindmap: {
    description: `Generate a mindmap from structured content. Part of NotebookLM features.

Supports two output formats:
- **mermaid**: Mermaid mindmap syntax (renderable in GitHub, GitLab, etc.)
- **markmap**: Markdown format (visualizable with markmap.js.org)

---

## Usage Example

\`\`\`json
{
  "topic": "Project Planning",
  "branches": [
    {
      "text": "Phase 1",
      "children": [
        { "text": "Research" },
        { "text": "Design" }
      ]
    },
    {
      "text": "Phase 2",
      "children": [
        { "text": "Development" },
        { "text": "Testing" }
      ]
    }
  ],
  "format": "mermaid"
}
\`\`\`

---

## Output Example (Mermaid)

\`\`\`mermaid
mindmap
  root((Project Planning))
    Phase 1
      Research
      Design
    Phase 2
      Development
      Testing
\`\`\`

---

## Parameters

- **topic**: Root topic/title of the mindmap (required)
- **branches**: Array of main branches, each with text and optional children (required)
- **format**: Output format - "mermaid" (default) or "markmap"
- **saveToFile**: Optional file path to save the mindmap

---

## Tips

- Use descriptive branch names
- Keep nesting to 2-4 levels for readability
- For complex topics, create multiple mindmaps`,
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Root topic/title of the mindmap' },
        branches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              children: {
                type: 'array',
                items: { type: 'object', properties: { text: { type: 'string' }, children: { type: 'array' } } }
              }
            }
          },
          description: 'Array of main branches with optional nested children'
        },
        format: { type: 'string', enum: ['mermaid', 'markmap'], description: 'Output format (default: mermaid)' },
        saveToFile: { type: 'string', description: 'Optional file path to save the mindmap' }
      },
      required: ['topic', 'branches'],
    },
    handler: generate_mindmap,
  },
  generate_mindmap_from_outline: {
    description: `Generate a mindmap from a text outline. Part of NotebookLM features.

Parses a simple text outline and converts it to a mindmap format.

---

## Outline Format

\`\`\`
# Main Topic 1
## Subtopic 1.1
- Point 1.1.1
- Point 1.1.2
## Subtopic 1.2
- Point 1.2.1
# Main Topic 2
- Point 2.1 (directly under topic)
\`\`\`

---

## Usage Example

\`\`\`json
{
  "title": "Meeting Notes",
  "outline": "# Discussion\\n## Decisions\\n- Use TypeScript\\n- Adopt microservices\\n## Action Items\\n- Create architecture doc\\n- Set up CI/CD",
  "format": "mermaid"
}
\`\`\`

---

## Parameters

- **title**: Title of the mindmap (required)
- **outline**: Text outline content (required)
- **format**: Output format - "mermaid" (default) or "markmap"
- **saveToFile**: Optional file path to save the mindmap`,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the mindmap' },
        outline: { type: 'string', description: 'Text outline content' },
        format: { type: 'string', enum: ['mermaid', 'markmap'], description: 'Output format (default: mermaid)' },
        saveToFile: { type: 'string', description: 'Optional file path to save the mindmap' }
      },
      required: ['title', 'outline'],
    },
    handler: generate_mindmap_from_outline,
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
    description: 'Update an existing interactive card message.',
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
    description: 'Wait for the user to interact with a card.',
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

- **card**: The interactive card JSON structure (same as send_user_feedback with format="card")
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
    name: 'generate_mindmap',
    description: `Generate a mindmap from structured content. Part of NotebookLM features.

Supports two output formats:
- **mermaid**: Mermaid mindmap syntax (renderable in GitHub, GitLab, etc.)
- **markmap**: Markdown format (visualizable with markmap.js.org)

---

## Usage Example

\`\`\`json
{
  "topic": "Project Planning",
  "branches": [
    {
      "text": "Phase 1",
      "children": [
        { "text": "Research" },
        { "text": "Design" }
      ]
    },
    {
      "text": "Phase 2",
      "children": [
        { "text": "Development" },
        { "text": "Testing" }
      ]
    }
  ],
  "format": "mermaid"
}
\`\`\`

---

## Output Example (Mermaid)

\`\`\`mermaid
mindmap
  root((Project Planning))
    Phase 1
      Research
      Design
    Phase 2
      Development
      Testing
\`\`\`

---

## Tips

- Use descriptive branch names
- Keep nesting to 2-4 levels for readability
- For complex topics, create multiple mindmaps`,
    parameters: z.object({
      topic: z.string().describe('Root topic/title of the mindmap'),
      branches: z.array(z.object({
        text: z.string(),
        children: z.array(z.object({
          text: z.string(),
          children: z.array(z.any()).optional(),
        })).optional(),
      })).describe('Array of main branches with optional nested children'),
      format: z.enum(['mermaid', 'markmap']).optional().default('mermaid').describe('Output format'),
      saveToFile: z.string().optional().describe('Optional file path to save the mindmap'),
    }),
    handler: async ({ topic, branches, format, saveToFile }) => {
      try {
        const result = await generate_mindmap({ topic, branches, format, saveToFile });
        return toolSuccess(result.success
          ? `${result.message}\n\n${result.mindmap}`
          : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Mindmap generation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'generate_mindmap_from_outline',
    description: `Generate a mindmap from a text outline. Part of NotebookLM features.

Parses a simple text outline and converts it to a mindmap format.

---

## Outline Format

\`\`\`
# Main Topic 1
## Subtopic 1.1
- Point 1.1.1
- Point 1.1.2
## Subtopic 1.2
- Point 1.2.1
# Main Topic 2
- Point 2.1 (directly under topic)
\`\`\``,
    parameters: z.object({
      title: z.string().describe('Title of the mindmap'),
      outline: z.string().describe('Text outline content'),
      format: z.enum(['mermaid', 'markmap']).optional().default('mermaid').describe('Output format'),
      saveToFile: z.string().optional().describe('Optional file path to save the mindmap'),
    }),
    handler: async ({ title, outline, format, saveToFile }) => {
      try {
        const result = await generate_mindmap_from_outline({ title, outline, format, saveToFile });
        return toolSuccess(result.success
          ? `${result.message}\n\n${result.mindmap}`
          : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Mindmap generation failed: ${error instanceof Error ? error.message : String(error)}`);
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
