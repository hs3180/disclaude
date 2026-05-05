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
 * Mask sensitive values in runtime-env entries.
 *
 * Tokens, keys, and secrets are masked to prevent accidental exposure
 * in agent logs or outputs. Only the first 8 characters are shown.
 *
 * @param key - The environment variable key
 * @param value - The environment variable value
 * @returns Masked value string
 */
function maskSensitiveValue(key: string, value: string): string {
  const sensitiveKeywords = ['token', 'secret', 'key', 'password', 'credential', 'auth'];
  const lowerKey = key.toLowerCase();
  const isSensitive = sensitiveKeywords.some(kw => lowerKey.includes(kw));

  if (isSensitive && value.length > 8) {
    return `${value.slice(0, 8)}${'*'.repeat(8)}`;
  }
  return value;
}

/**
 * Known runtime-env variable descriptions.
 *
 * Provides a human-readable description for commonly used runtime-env
 * variables so the agent understands what each variable is for.
 */
const KNOWN_VARS: Record<string, string> = {
  GH_TOKEN: 'GitHub API token (from GitHub App JWT auth)',
  GH_TOKEN_EXPIRES_AT: 'GitHub token expiration time (ISO 8601)',
};

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
 * Build the runtime environment awareness guidance section.
 *
 * Issue #1371: Informs the agent about available runtime-env variables
 * that are shared between the main process and agent subprocess.
 *
 * The agent runs in an SDK subprocess where in-memory singletons from
 * the main process are inaccessible. Runtime-env provides a file-based
 * mechanism to share state. This guidance section tells the agent what
 * variables are currently available so it can use them proactively.
 *
 * @param runtimeEnv - Current runtime environment variables (from loadRuntimeEnv)
 * @returns Formatted runtime-env awareness section, or empty string if no vars
 */
export function buildRuntimeEnvGuidance(runtimeEnv: Record<string, string>): string {
  const keys = Object.keys(runtimeEnv);
  if (keys.length === 0) {
    return '';
  }

  const varEntries = keys
    .map(key => {
      const description = KNOWN_VARS[key] ? ` — ${KNOWN_VARS[key]}` : '';
      const maskedValue = maskSensitiveValue(key, runtimeEnv[key]);
      return `- \`${key}\` = \`${maskedValue}\`${description}`;
    })
    .join('\n');

  return `

---

## Runtime Environment Variables

The following environment variables are available in the workspace \`.runtime-env\` file. These are shared between the main process and your agent subprocess for cross-process state sharing.

### Available Variables

${varEntries}

### Usage Guidelines

- **Reading**: You can read the \`.runtime-env\` file directly using the Read tool at \`{workspace}/.runtime-env\`
- **Writing**: Use the Write tool to add or update variables in \`.runtime-env\`
- **Sensitive values**: Token values above are partially masked for safety. The full values are available in the actual file.
- **Expiration**: Some variables (e.g., \`GH_TOKEN_EXPIRES_AT\`) indicate when tokens expire. Check expiration before using tokens.
- **GitHub operations**: When you need to run \`gh\` commands, ensure \`GH_TOKEN\` is set and not expired. Use \`export GH_TOKEN=<value>\` before running \`gh\` commands.

---`;
}
