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
 * Build the research mode guidance section.
 *
 * Issue #1709: When the agent is in research mode, inject research-specific
 * behavior rules and guidelines into the prompt.
 *
 * This guidance supplements (or replaces, if soulContent is provided) the
 * default SOUL behavior, creating an isolated research environment.
 *
 * @param options - Research mode context
 * @returns Formatted research mode guidance section, or empty string if not in research mode
 */
export function buildResearchModeGuidance(options: {
  topic?: string;
  cwd?: string;
  soulContent?: string;
}): string {
  const { topic, cwd, soulContent } = options;

  // If custom SOUL content is available, use it as the primary guidance
  if (soulContent) {
    return `

---

## Research Mode 🔬

You are currently in **Research Mode**.

${soulContent}

---

**Research Context:**
- **Topic**: ${topic || 'Not specified'}
- **Working Directory**: \`${cwd || 'default'}\`
- **Commands**: \`/mode normal\` to exit research mode
`;
  }

  // Default research mode guidance when no SOUL is loaded
  return `

---

## Research Mode 🔬

You are currently in **Research Mode** — an isolated research environment.

### Research Behavior Rules

1. **Focus on Research**: Prioritize thorough investigation, analysis, and synthesis of information
2. **Working Directory**: All file operations should be within the research working directory (\`${cwd || 'default'}\`)
3. **Source Citation**: Always cite sources and provide references for findings
4. **Structured Output**: Organize findings with clear sections, summaries, and conclusions
5. **Save Progress**: Save research notes and findings to files in the working directory

### Topic
${topic ? `Your current research topic is: **${topic}**` : 'No specific topic set.'}

### Commands
- \`/mode normal\` — Return to normal conversation mode
- \`/research <new topic>\` — Switch to a different research topic

---
`;
}
