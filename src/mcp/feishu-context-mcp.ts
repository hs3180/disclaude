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
  wait_for_interaction,
  send_interactive_message,
  setMessageSentCallback,
  generate_summary,
  generate_qa_pairs,
  generate_flashcards,
  generate_quiz,
  create_study_guide,
  create_discussion_chat,
  get_bot_chats,
  add_chat_members,
  get_chat_members,
} from './tools/index.js';
import { startIpcServer } from './tools/interactive-message.js';

// Re-export
export type { MessageSentCallback } from './tools/types.js';
export { setMessageSentCallback };
export { resolvePendingInteraction } from './tools/card-interaction.js';
export { send_message } from './tools/send-message.js';
export { send_file } from './tools/send-file.js';
export { wait_for_interaction } from './tools/card-interaction.js';
export {
  send_interactive_message,
  generateInteractionPrompt,
  getActionPrompts,
  startIpcServer,
  stopIpcServer,
  isIpcServerRunning,
} from './tools/interactive-message.js';

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
    description: `Send a message to a chat. Requires explicit format: "text" or "card".

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
};

export const feishuToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'send_message',
    description: `Send a message to a chat. Requires explicit format: "text" or "card".

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
  // ChatOps Tools (Issue #393 - PR Scanner)
  {
    name: 'create_discussion_chat',
    description: `Create a new discussion group chat.

Use this tool to create a new Feishu group chat for discussions. Useful for:
- Creating dedicated chats for PR discussions
- Setting up topic-specific discussion groups
- Creating temporary collaboration spaces

## Parameters
- **topic**: (Optional) Name/title for the chat. Auto-generated if not provided.
- **members**: (Optional) Array of open_ids to add as initial members

## Example
\`\`\`json
{
  "topic": "PR #123: Feature Discussion",
  "members": ["ou_xxx", "ou_yyy"]
}
\`\`\`

## Returns
- **chatId**: The ID of the created chat (e.g., "oc_xxx")

---

**Note:** Requires FEISHU_APP_ID and FEISHU_APP_SECRET to be configured.`,
    parameters: z.object({
      topic: z.string().optional(),
      members: z.array(z.string()).optional(),
    }),
    handler: async ({ topic, members }) => {
      try {
        const result = await create_discussion_chat({ topic, members });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Chat creation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'get_bot_chats',
    description: `Get all chats the bot is a member of.

Returns a list of all group chats where the bot has been added.

## Returns
Array of chat objects:
- **chatId**: Chat ID
- **name**: Chat name

## Example Response
\`\`\`json
[
  {"chatId": "oc_xxx", "name": "Project Discussion"},
  {"chatId": "oc_yyy", "name": "Team Updates"}
]
\`\`\``,
    parameters: z.object({}),
    handler: async () => {
      try {
        const result = await get_bot_chats();
        if (!result.success) {
          return toolSuccess(`⚠️ ${result.message}`);
        }
        const chatList = result.chats?.map(c => `- ${c.name} (${c.chatId})`).join('\n') || 'No chats found';
        return toolSuccess(`Bot is in ${result.chats?.length || 0} chats:\n${chatList}`);
      } catch (error) {
        return toolSuccess(`⚠️ Failed to get bot chats: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'add_chat_members',
    description: `Add members to an existing chat.

## Parameters
- **chatId**: Target chat ID
- **members**: Array of open_ids to add

## Example
\`\`\`json
{
  "chatId": "oc_xxx",
  "members": ["ou_abc", "ou_def"]
}
\`\`\``,
    parameters: z.object({
      chatId: z.string(),
      members: z.array(z.string()),
    }),
    handler: async ({ chatId, members }) => {
      try {
        const result = await add_chat_members({ chatId, members });
        return toolSuccess(result.success ? result.message : `⚠️ ${result.message}`);
      } catch (error) {
        return toolSuccess(`⚠️ Failed to add members: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'get_chat_members',
    description: `Get the list of members in a chat.

## Parameters
- **chatId**: Target chat ID

## Returns
Array of member open_ids.`,
    parameters: z.object({
      chatId: z.string(),
    }),
    handler: async ({ chatId }) => {
      try {
        const result = await get_chat_members({ chatId });
        if (!result.success) {
          return toolSuccess(`⚠️ ${result.message}`);
        }
        return toolSuccess(`Chat members (${result.members?.length || 0}):\n${result.members?.join('\n') || 'None'}`);
      } catch (error) {
        return toolSuccess(`⚠️ Failed to get members: ${error instanceof Error ? error.message : String(error)}`);
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
