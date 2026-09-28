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
 * @param pendingQuestionEligible - True only for a genuine empty text @mention
 * @returns Formatted chat history section, or empty string if no context
 */
export function buildChatHistorySection(
  chatHistoryContext?: string,
  pendingQuestionEligible = false,
): string {
  if (!chatHistoryContext) {
    return '';
  }

  const pendingQuestionGuidance = pendingQuestionEligible
    ? '- This is a genuine empty text @mention. Check this history for a clearly unanswered request in the same conversation. Answer it only if it has not already been answered or superseded; do not revive an older completed request. If nothing is clearly pending, ask what the user needs.\n'
    : '';

  return `

---

## Recent Chat History

You were @mentioned in a group chat. Here's the recent conversation context:

${chatHistoryContext}

**Important**:
${pendingQuestionGuidance}- Treat the current message as the primary request. Do not infer that an older request is still pending merely because it appears in history.
- **Coreference resolution**: When a user uses referring expressions like "this link", "this thread", "that message", "这篇", "那个", and the chat history contains multiple possible referents (e.g., multiple links, multiple topics), do NOT guess. Instead, ask the user to clarify which one they mean. Example: "I see several links in the recent history — which one are you referring to?"

---
`;
}

/**
 * Build the persisted history section for session restoration.
 *
 * Issue #955: Provides conversation history from the previous session
 * after a service restart.
 * Issue #3996: Includes chat log file paths so the agent can Read them
 * to access conversation history beyond the context window.
 *
 * @param persistedHistoryContext - Persisted history context string, or undefined to skip
 * @param chatLogFilePaths - Optional array of log file paths to include
 * @returns Formatted persisted history section, or empty string if no context
 */
export function buildPersistedHistorySection(
  persistedHistoryContext?: string,
  chatLogFilePaths?: string[]
): string {
  if (!persistedHistoryContext && (!chatLogFilePaths || chatLogFilePaths.length === 0)) {
    return '';
  }

  // Issue #3996: Build log file paths hint
  const logPathsHint =
    chatLogFilePaths && chatLogFilePaths.length > 0
      ? `\n📁 **Chat log files** (use Read tool to access full history beyond the context window):\n${chatLogFilePaths
          .map((p) => `- \`${p}\``)
          .join('\n')}\n`
      : '';

  if (!persistedHistoryContext) {
    // Only log paths, no history content
    return `

---

## Previous Session Context

The service was recently restarted.${logPathsHint}
---
`;
  }

  return `

---

## Previous Session Context

The service was recently restarted. Here's the conversation history from your previous session:

${persistedHistoryContext}
${logPathsHint}
---
`;
}

/**
 * Build the thread context section for topic groups.
 *
 * Issue #3641 sub-problem 1: Provides thread conversation history
 * when the user sends a message in a Feishu topic group thread.
 *
 * @param threadContext - Thread context string, or undefined to skip
 * @returns Formatted thread context section, or empty string if no context
 */
export function buildThreadContextSection(threadContext?: string): string {
  if (!threadContext) {
    return '';
  }

  return `

---

## Thread Context

You are responding in a topic group thread. Here is the conversation history within this thread (from oldest to newest):

${threadContext}

**Coreference resolution**: When a user uses referring expressions like "this link", "this thread", "that message", "这篇", "那个", and the thread history contains multiple possible referents (e.g., multiple links, multiple topics), do NOT guess. Instead, ask the user to clarify which one they mean. Example: "I see several links in this thread — which one are you referring to?"

---
`;
}

/**
 * Build the lark-cli self-service guidance for topic threads.
 *
 * Issue #4402: extracted from `buildThreadContextSection` so it is injected
 * based on `isTopicThread` (topic mode) — NOT gated on whether `threadContext`
 * was pre-built. The previous embedding meant this guidance disappeared exactly
 * when the harness failed to pre-build thread context (the case where the agent
 * most needs to know it can self-serve via lark-cli). See #4306 / #4401.
 *
 * Returned only for topic threads (the caller gates on `isTopicThread`); the
 * content is shared topic-thread interpretation, card, and on-demand
 * attachment/context guidance (lark-cli) for every connected agent backend.
 */
export function buildThreadSelfServiceGuidance(): string {
  return `

---

## Topic-thread context before replying (Issue #5190)

You are responding inside one specific topic-group thread. Use \`lark-cli\` to inspect missing conversation context. Anchor your interpretation to the supplied Thread Root ID and use only this thread—not flat group history, another thread, or unrelated persisted chat history—to resolve the current message.

The injected Thread Context may be absent, partial, or limited to the parent chain; it is not proof that every earlier reply or attachment is present. First inspect it. If the current message depends on missing earlier context (including short follow-ups such as “那这个呢？” or “继续”), proactively retrieve the current thread's messages and relevant replies before answering; the user does not need to explicitly say “look at this thread.” Do not fetch the full thread when the supplied context already contains everything needed.

Use semantic judgment to decide whether the response leaves a concrete choice, clarification, or confirmation that materially changes what should happen next. If the current Tools section exposes send_interactive, offer at most one concise card that preserves the distinct choices; otherwise ask a necessary question in chat or finish without a card. Do not rely on harness-specific rules, regex triggers, or post-response rewriting. Do not add generic next-step menus, repeat a question already answered, or begin optional work before the user chooses.

- List messages and replies in this exact thread; download resources only when relevant:
  \`npx @larksuite/cli im +threads-messages-list --thread <current-message-id> --as bot --download-resources\`
- Fetch specific messages by id (up to 50), optionally downloading their attachments too:
  \`npx @larksuite/cli im +messages-mget --message-ids <om_xxx>,<om_yyy> --as bot --download-resources\`
- Download one relevant attachment:
  \`npx @larksuite/cli im +messages-resources-download --message-id <om_xxx> --file-key <key> --type image|file --as bot --output ./lark-im-resources/<name>\`

The \`--thread\` flag accepts the current Message ID (or another message ID known to belong to this same thread) and resolves its thread. Read any downloaded resource before relying on it. If required context or an attachment cannot be retrieved, state what is missing and ask the user rather than guessing.

When sending a follow-up/feedback card from a topic thread, keep \`--parent <current-Message-ID>\` for reply attribution and also pass \`--thread-root <Thread-Root-ID>\` so a button click resumes the existing agent session for this same thread. Never substitute the card's own ID for the thread root. Supply an \`--action-prompts\` entry for every button; each should record the selected choice and continue in this same chat/thread context, not start a separate task or session.

Use \`--idempotency-key "followup:<current-message-id>"\` for the card and reuse the same key if sending is retried; the service coalesces concurrent retries and reuses the registered card for the same chat/key.

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
  const researchGuidance = [
    'For research, deliver a human-readable report in the existing Project and link it in chat.',
    'Organize the report around the research question and the evidence behind important judgments, distinguishing observed results from their interpretation.',
    'Keep detailed source material and exploration records in the Project archive rather than turning the report into a tool log.',
    'When the user comments, edits the document, or gives feedback in chat, connect it to the affected evidence or claim, preserve user edits, and make any substantive revision visible.',
    'Ask a concrete follow-up when ambiguity could change the judgment; use a structured card only when it materially helps, otherwise ask in chat.',
    'Cards are for specific feedback, not research navigation or generic next-step menus; do not begin optional work without a user request.',
  ].join(' ');
  if (supportsCards !== false) {
    return `

---

## Next Steps After Response

Use semantic judgment to decide whether the response leaves a concrete choice, clarification, or confirmation that materially changes what should happen next. If the current channel exposes send_interactive, offer at most one concise card preserving the distinct choices; otherwise ask a necessary question in chat or finish without a card. Do not rely on harness-specific rules, regex triggers, or post-response rewriting. Do not add generic next-step menus, repeat a question already answered, or begin optional work before the user chooses. Optional follow-up questions should be grounded in the actual findings and unresolved evidence.

${researchGuidance}

### Sending a feedback card (send_interactive)

Invoke the \`send_interactive\` channel command shown in the Tools section — it is a **command line**, not a JSON payload. Passing a card JSON blob on stdin does not work: it is consumed as the \`--question\` text and rendered verbatim into the card.

\`\`\`bash
<channel-cli> send_interactive --chat <chat-id> \\
  --parent <trigger-message-id> \\
  --title "确认交付格式" \\
  --question "报告需要哪种格式？" \\
  --options '[{"text":"Markdown","value":"action1","type":"primary"},{"text":"PDF","value":"action2"}]' \\
  --action-prompts '{"action1":"[用户操作] 用户选择了Markdown","action2":"[用户操作] 用户选择了PDF"}' \\
  --idempotency-key "followup:<trigger-message-id>"
\`\`\`

Flags:

- \`--chat\` — target chat ID. Required unless \`FEISHU_CLI_CHAT_ID\` or the config \`cliChatId\` supplies it.
- \`--parent\` — the triggering prompt's **Message ID** from the metadata below. Always pass it so the card remains visibly associated with the request in private chats, regular groups, and topic groups. Omit it only when the channel rejects reply attribution, then retry once without it.
- \`--question\` — the prompt text shown above the buttons (or \`--question-file <path>\`, or piped on stdin).
- \`--options\` — JSON array of buttons; each an object with a button \`text\`, a \`value\`, and an optional \`type\` of \`primary\`/\`default\`/\`danger\`.
- \`--action-prompts\` — JSON object mapping each button \`value\` to a short user-action description.
- \`--thread-root\` — optional topic-thread root ID used to route button clicks back to that thread's existing agent session; when present in the current message metadata, pass it for interactive cards. Keep \`--parent\` set to the triggering Message ID.
- \`--idempotency-key\` — stable retry key for one card and trigger message; requires \`--action-prompts\` so the existing card's button context remains registered.
- \`--title\` — card header text (optional; defaults to a generic header). Choose a title that identifies the specific question.
- \`--context\` — optional one-line subtitle under the header.

Do **NOT** paste raw card fields such as \`content\`/\`format\`/\`elements\` — the card body is built by the channel.

### Guidelines

- Offer only the choices relevant to the specific question; allow the user to answer freely in chat
- Make suggestions specific and actionable
- Use \`"type": "primary"\` for the most recommended option
- **CRITICAL**: Always include \`actionPrompts\` that maps each option's \`value\` to a user message
- Each action prompt must preserve the selected choice and continue in the existing conversation context, not start a separate task or session
- **CRITICAL**: Reply to the triggering prompt with \`--parent <trigger-message-id>\`; this applies to non-topic groups and private chats too
- The action prompt format: \`"[用户操作] 用户选择了..."\` describes what the user did
- If there is no concrete feedback to obtain, finish with the answer and relevant artifact links; no card is needed`;
  }

  // Fallback for channels without card support
  return `

---

## Next Steps After Response

When a necessary clarification or decision remains, ask one concrete question in chat; otherwise finish the response without generic next-step menus or optional work.

${researchGuidance}

### Guidelines

- Suggest 2-3 relevant next steps based on the conversation context
- Make suggestions specific and actionable
- Format as a simple list
- Do not append suggestions to a complete answer unless they help the user`;
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

/** Describe the agent-owned workspace environment and its sharing boundaries. */
export function buildRuntimeEnvironmentGuidance(): string {
  return `

## Shared Runtime Environment

\`$DISCLAUDE_WORKSPACE_DIR/.runtime-env\` is shared across sessions and agents using this workspace. It is persistent workspace state, not a private session store. Project changes and session resets do not isolate or remove it.

You own its contents and credential lifecycle. Before changing it, read the current file, preserve unrelated entries, and coordinate concurrent writers; replacing it from a stale snapshot can destroy another agent's changes. Do not store task-private credentials there unless sharing them with other workspace agents is intended and authorized. Keep private material out of replies and logs, and keep the file owner-only and out of version control.

Disclaude reads this file when preparing an execution environment. Already-running processes retain their earlier environment snapshot; writing the file does not update those processes. Decide when to refresh or remove credentials according to the provider and task, without assuming disclaude expires them for you.

### Running commands to completion

When a tool returns a running session, job or cell handle, retain its status and handle, not just its output text. Poll the same handle until the underlying operation reports a terminal result. A wait returning, an empty output chunk, or an outer orchestration cell completing does not mean its child command has exited. An observation timeout is not permission to restart the work.

If a script wraps command tools, inspect and preserve each command's session and exit status through subsequent waits. Before claiming success, check the terminal result and the requested outcome or artifact. Do not end a turn that was asked to await completion while its command is still running: temporary session cleanup can terminate unfinished children. If completion cannot be verified, report the unresolved state rather than success.`;
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
