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
  create_post,
  reply_post,
  get_posts,
  get_post,
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
  generateInteractionPrompt,
  getActionPrompts,
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
  create_post: {
    description: `Create a post in a topic group (BBS mode).

In topic groups, a "post" is a root message that starts a new topic/thread.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "content": "Today's discussion topic: ..."}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **content**: Post content as text (required)

---

## Returns

- **success**: Whether the post was created
- **messageId**: The created post's message ID
- **threadId**: The thread ID for replies

---

**Reference:** https://open.feishu.cn/document/server-docs/im-v1/message/create

**See also:** Issue #873 - 话题群扩展`,
    parameters: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['chatId', 'content'],
    },
    handler: create_post,
  },
  reply_post: {
    description: `Reply to a post in a topic group (BBS mode).

Replies are added to the post's thread. Use the postId (root message ID) to reply.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "postId": "om_xxx", "content": "Great point! I think..."}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **postId**: The post (root message) ID to reply to (required)
- **content**: Reply content as text (required)

---

## Returns

- **success**: Whether the reply was posted
- **messageId**: The reply's message ID

---

**Reference:** https://open.feishu.cn/document/server-docs/im-v1/message/reply

**See also:** Issue #873 - 话题群扩展`,
    parameters: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        postId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['chatId', 'postId', 'content'],
    },
    handler: reply_post,
  },
  get_posts: {
    description: `Get posts from a topic group (BBS mode).

Retrieves root messages (posts) from the topic group.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "pageSize": 20}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **pageSize**: Maximum posts to return (default: 20, max: 50)
- **pageToken**: Pagination token from previous response

---

## Returns

- **posts**: Array of post info
- **hasMore**: Whether more posts exist
- **pageToken**: Token for next page

---

**Reference:** https://open.feishu.cn/document/server-docs/im-v1/message/list

**See also:** Issue #873 - 话题群扩展`,
    parameters: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        pageSize: { type: 'number' },
        pageToken: { type: 'string' },
      },
      required: ['chatId'],
    },
    handler: get_posts,
  },
  get_post: {
    description: `Get a specific post by message ID.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "postId": "om_xxx"}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **postId**: The post (message) ID (required)

---

## Returns

- **post**: Post details including content, createTime, senderId

---

**Reference:** https://open.feishu.cn/document/server-docs/im-v1/message/get

**See also:** Issue #873 - 话题群扩展`,
    parameters: {
      type: 'object',
      properties: {
        chatId: { type: 'string' },
        postId: { type: 'string' },
      },
      required: ['chatId', 'postId'],
    },
    handler: get_post,
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
    name: 'create_post',
    description: `Create a post in a topic group (BBS mode).

In topic groups, a "post" is a root message that starts a new topic/thread.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "content": "Today's discussion topic: ..."}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **content**: Post content as text (required)

---

**See also:** Issue #873 - 话题群扩展`,
    parameters: z.object({
      chatId: z.string(),
      content: z.string(),
    }),
    handler: async ({ chatId, content }) => {
      try {
        const result = await create_post({ chatId, content });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Create post failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'reply_post',
    description: `Reply to a post in a topic group (BBS mode).

Replies are added to the post's thread. Use the postId (root message ID) to reply.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "postId": "om_xxx", "content": "Great point!"}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **postId**: The post (root message) ID to reply to (required)
- **content**: Reply content as text (required)

---

**See also:** Issue #873 - 话题群扩展`,
    parameters: z.object({
      chatId: z.string(),
      postId: z.string(),
      content: z.string(),
    }),
    handler: async ({ chatId, postId, content }) => {
      try {
        const result = await reply_post({ chatId, postId, content });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Reply post failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'get_posts',
    description: `Get posts from a topic group (BBS mode).

Retrieves root messages (posts) from the topic group.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "pageSize": 20}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **pageSize**: Maximum posts to return (default: 20, max: 50)
- **pageToken**: Pagination token from previous response

---

**See also:** Issue #873 - 话题群扩展`,
    parameters: z.object({
      chatId: z.string(),
      pageSize: z.number().optional(),
      pageToken: z.string().optional(),
    }),
    handler: async ({ chatId, pageSize, pageToken }) => {
      try {
        const result = await get_posts({ chatId, pageSize, pageToken });
        if (result.success && result.posts) {
          const postList = result.posts.map(p =>
            `- ID: ${p.messageId}\n  时间: ${new Date(p.createTime * 1000).toLocaleString('zh-CN')}\n  内容: ${p.content.substring(0, 100)}...`
          ).join('\n\n');
          return toolSuccess(`✅ 获取到 ${result.posts.length} 个帖子\n\n${postList}${result.hasMore ? `\n\n还有更多帖子，使用 pageToken: ${result.pageToken}` : ''}`);
        }
        return toolSuccess(`⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Get posts failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'get_post',
    description: `Get a specific post by message ID.

---

## Usage

\`\`\`json
{"chatId": "oc_xxx", "postId": "om_xxx"}
\`\`\`

---

## Parameters

- **chatId**: Topic group chat ID (required)
- **postId**: The post (message) ID (required)

---

**See also:** Issue #873 - 话题群扩展`,
    parameters: z.object({
      chatId: z.string(),
      postId: z.string(),
    }),
    handler: async ({ chatId, postId }) => {
      try {
        const result = await get_post({ chatId, postId });
        if (result.success && result.post) {
          const post = result.post;
          return toolSuccess(`✅ 帖子详情\n\nID: ${post.messageId}\n时间: ${new Date(post.createTime * 1000).toLocaleString('zh-CN')}\n类型: ${post.contentType}\n内容:\n${post.content}`);
        }
        return toolSuccess(`⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Get post failed: ${error instanceof Error ? error.message : String(error)}`);
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
