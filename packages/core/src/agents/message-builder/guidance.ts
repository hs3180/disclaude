/**
 * Composable guidance builder functions for MessageBuilder.
 *
 * Issue #1492: Extracted from worker-node MessageBuilder as standalone
 * pure functions for testability and reusability.
 *
 * Each function builds a specific guidance section for the agent prompt.
 * These are framework-agnostic and can be used by any channel.
 *
 * @module agents/message-builder/guidance
 */

/**
 * Build the chat history section for passive mode.
 *
 * Issue #517: Provides recent conversation context when the agent
 * is @mentioned in a group chat.
 *
 * Issue #1856: Enhanced guidance to help agent answer the last pending
 * question when the user sends an empty @mention (no text attached).
 *
 * @param chatHistoryContext - Chat history context string, or undefined to skip
 * @returns Formatted chat history section, or empty string if no context
 */
export function buildChatHistorySection(chatHistoryContext?: string): string {
  if (!chatHistoryContext) {
    return '';
  }

  return `

---

## Recent Chat History

You were @mentioned in a group chat. Here's the recent conversation context:

${chatHistoryContext}

**Important**: If the user's message above is empty (only an @mention with no text), look at the last question or request in the chat history and proactively answer it. Do not ask the user what they need — they are @mentioning you to get an answer to the pending question.

---
`;
}

/**
 * Build the persisted history section for session restoration.
 *
 * Issue #955: Provides conversation history from the previous session
 * after a service restart.
 *
 * @param persistedHistoryContext - Persisted history context string, or undefined to skip
 * @returns Formatted persisted history section, or empty string if no context
 */
export function buildPersistedHistorySection(persistedHistoryContext?: string): string {
  if (!persistedHistoryContext) {
    return '';
  }

  return `

---

## Previous Session Context

The service was recently restarted. Here's the conversation history from your previous session:

${persistedHistoryContext}

---
`;
}

/**
 * Build the next-step guidance section.
 *
 * Issue #893: Provides in-prompt guidance for suggesting next steps
 * to the user after responding, using interactive cards when supported.
 *
 * @param supportsCards - Whether the channel supports interactive cards
 * @returns Formatted next-step guidance section
 */
export function buildNextStepGuidance(supportsCards?: boolean): string {
  if (supportsCards !== false) {
    return `

---

## Next Steps After Response

At the end of your response, proactively suggest 2-3 relevant next steps the user might want to take. Present these suggestions as an **interactive card** with clickable options.

### Card Template for Next Steps

**IMPORTANT**: You MUST include \`actionPrompts\` to make buttons clickable. Without \`actionPrompts\`, buttons are display-only.

\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "接下来您可以...", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "✅ 任务已完成"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "选项1", "tag": "plain_text"}, "value": "action1", "type": "primary"},
        {"tag": "button", "text": {"content": "选项2", "tag": "plain_text"}, "value": "action2"},
        {"tag": "button", "text": {"content": "选项3", "tag": "plain_text"}, "value": "action3"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>",
  "actionPrompts": {
    "action1": "[用户操作] 用户选择了选项1",
    "action2": "[用户操作] 用户选择了选项2",
    "action3": "[用户操作] 用户选择了选项3"
  }
}
\`\`\`

### Guidelines

- Suggest 2-3 relevant next steps based on the conversation context
- Make suggestions specific and actionable
- Use primary button style for the most recommended option
- **CRITICAL**: Always include \`actionPrompts\` that maps each button's \`value\` to a user message
- The action prompt format: \`"[用户操作] 用户选择了..."\` describes what the user did
- Always include a suggestions card, even for simple questions (e.g., "Want to know more about X?", "Try this related feature")`;
  }

  // Fallback for channels without card support
  return `

---

## Next Steps After Response

At the end of your response, proactively suggest 2-3 relevant next steps the user might want to take.

### Guidelines

- Suggest 2-3 relevant next steps based on the conversation context
- Make suggestions specific and actionable
- Format as a simple list
- Always include suggestions, even for simple questions (e.g., "Want to know more about X?", "Try this related feature")`;
}

/**
 * Build the output format guidance section.
 *
 * Issue #962: Prevents raw JSON objects from appearing in model output.
 * Some models may output JSON objects directly instead of formatting
 * them as readable Markdown.
 *
 * @returns Formatted output format guidance section
 */
export function buildOutputFormatGuidance(): string {
  return `

---

## Output Format Requirements

**IMPORTANT: Never output raw JSON objects in your response.**

When you need to present structured data (status, metrics, analysis results, etc.), always format it as **readable Markdown**:

### ✅ Correct Format
\`\`\`markdown
> **储蓄率**: ❌ 入不敷出，储蓄率为负，建议审视支出结构
\`\`\`

### ❌ Wrong Format (Never do this)
\`\`\`markdown
> **储蓄率**: { "status": "bad", "comment": "入不敷出..." }
\`\`\`

### Guidelines

- Convert JSON objects to readable text, tables, or formatted lists
- Use emoji and formatting (bold, italic) to highlight important information
- If you have structured data internally, extract and present the key values
- For complex data, use Markdown tables instead of raw JSON`;
}

/**
 * Build the location awareness guidance section.
 *
 * Issue #1198: The agent runs on a server that is physically separate
 * from the user's terminal. Therefore, the agent should NOT attempt to
 * infer the user's physical location through system information.
 *
 * @returns Formatted location awareness guidance section
 */
export function buildLocationAwarenessGuidance(): string {
  return `

---

## Location Awareness

**IMPORTANT: You do NOT know the user's physical location.**

You are running on a remote server that is physically separate from the user's terminal. Therefore:

- You CANNOT infer the user's location from system information (timezone, Wi-Fi networks, IP address, locale settings, etc.)
- When the user asks about location-dependent information (weather, local events, etc.), you should:
  1. Honestly state that you don't know their location
  2. Ask them to provide their location if needed
  3. Do NOT attempt to guess or infer their location from any system data

### Examples

**❌ Wrong Approach:**
> "Based on your timezone (Asia/Shanghai), you're probably in Shanghai..."

**✅ Correct Approach:**
> "I don't know your current location since I'm running on a remote server. Could you tell me which city you're in so I can help you with the weather forecast?"`;
}

/**
 * Build the context offloading guidance section.
 *
 * Issue #2351: Informs the agent about the context offloading pattern —
 * creating side group chats for long-form content delivery to keep
 * the main conversation clean. Especially valuable in voice mode.
 *
 * The agent already has the necessary tools (register_temp_chat,
 * send_text, send_card, send_file). This guidance teaches it the
 * workflow and when to use it.
 *
 * @returns Formatted context offloading guidance section
 */
export function buildContextOffloadingGuidance(): string {
  return `

---

## Context Offloading (Long-Form Content Delivery)

**IMPORTANT**: When your response contains long-form content (code files, detailed reports, multi-section documentation), consider offloading it to a side group chat to keep the main conversation clean.

### When to Offload

Use context offloading when:
- Your response contains **multiple code files** or configurations (e.g., "generate a full project setup")
- Your response exceeds **~2000 characters** of structured content
- The user explicitly requests delivery to a separate group (e.g., "发到新群聊", "单独拉一个群")
- The content is better consumed as a **persistent reference** rather than a chat message

### How to Offload

You have the \`register_temp_chat\` tool for creating side groups with automatic lifecycle management:

\`\`\`
Step 1: register_temp_chat
  - chatId: use a descriptive ID (e.g., "lite-llm-config-0417")
  - expiresAt: set expiry (e.g., 24h from now in ISO format)
  - creatorChatId: the current chat ID
  - context: optional metadata about the content
  - triggerMode: "always" so the bot responds in the side group

Step 2: Reply in main chat
  - Brief confirmation: "✅ 已创建群聊「{name}」，内容已发送"
  - Do NOT dump the long content in the main chat

Step 3: Send content to side group
  - Use send_text or send_card to deliver the full content
  - Split into multiple messages if needed (one per file/section)
\`\`\`

### Important Notes

- The \`chats-activation\` schedule will automatically create the Feishu group
- The \`chat-timeout\` skill will automatically dissolve the group when expired
- Side groups are independent sessions — they do not affect the main conversation
- Prefer offloading over sending very long messages directly in the main chat
- If the content is short (< 500 chars) or a direct answer, respond normally without offloading`;
}
