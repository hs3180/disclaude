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
export function buildThreadSelfServiceGuidance(supportsCards?: boolean): string {
  return `

## Topic-thread context before replying

Use only the current Thread Root ID and this thread's messages to interpret the request, not flat group history or another thread. The injected context may be partial. For follow-ups such as “那这个呢？” or “继续”, proactively retrieve missing replies and relevant attachments before answering; skip retrieval when the supplied context is sufficient. If retrieval fails, say what is missing and ask rather than guessing.

Use lark-cli on demand:
- \`npx @larksuite/cli im +threads-messages-list --thread <current-message-id> --as bot --download-resources\`
- \`npx @larksuite/cli im +messages-mget --message-ids <ids> --as bot --download-resources\`
- \`npx @larksuite/cli im +messages-resources-download --message-id <id> --file-key <key> --type image|file --as bot --output ./lark-im-resources/<name>\`

Read downloaded resources before relying on them. The --thread value must belong to this same thread. Keep any follow-up card in this thread using the current Message ID and Thread Root ID, as described in Channel CLI guidance.

${buildContextualNextStepGuidance(supportsCards)}`;
}

/** Shared policy for ordinary chats and topic threads; each prompt includes it once. */
function buildContextualNextStepGuidance(supportsCards?: boolean): string {
  const delivery = supportsCards === false
    ? 'Offer the recommendation briefly in chat; ask a question only when a real decision or ambiguity needs an answer.'
    : 'Use one concise send_interactive card when a concrete choice or feedback request materially benefits from buttons; otherwise recommend it briefly in chat.';
  return `After substantive work, proactively offer one concrete, optional next step when it advances the user's stated goal, even when the immediate request is complete. Ground it in current context, constraints, prior decisions, findings or artifacts. Skip routine exchanges and finish naturally when no useful continuation is apparent. Do not invent goals, add generic menus, repeat answered questions, or start optional work before the user chooses. ${delivery}

Base feedback-related choices only on feedback already received. After sending a preview with no reviewer feedback, confirm delivery and finish; revisit revision when specific feedback arrives. Do not ask the user to precommit to hypothetical future feedback.

For research, deliver a human-readable report in the existing Project, link it in chat, and distinguish observed results from interpretation. Keep detailed sources and exploration in the Project archive. Apply actual comments or feedback to the affected evidence or claim, preserve user edits, and make substantive revisions visible. Clarify ambiguity that could change the judgment; cards serve specific feedback or decisions, not research navigation.`;
}

/** Build conditional next-step guidance without a full card command template. */
export function buildNextStepGuidance(supportsCards?: boolean): string {
  return `\n## Next Steps After Response\n\n${buildContextualNextStepGuidance(supportsCards)}`;
}

/** Respect explicit output formats; readable Markdown is only the default. */
export function buildOutputFormatGuidance(): string {
  return `\n## Output Format Requirements

Answer concisely in readable Markdown by default. Respect the user's explicit output format, including raw JSON or code-only output; do not add a preamble, card, or unrelated task record that would break that format.`;
}

/** Describe the persistent workspace environment and command ownership boundaries. */
export function buildRuntimeEnvironmentGuidance(): string {
  return `\n## Shared Runtime Environment

\`$DISCLAUDE_WORKSPACE_DIR/.runtime-env\` persists across sessions and agents using this workspace; Project changes and resets do not isolate it. Read the current file, preserve unrelated entries, and coordinate concurrent writers before editing. Share credentials there only when intended and authorized; keep the file owner-only, out of version control, and private material out of replies and logs. You own credential expiry/removal. Running processes retain their previous environment; editing the file does not refresh them.

For a running session, job or cell, retain and poll the same handle until its underlying command reaches a terminal result. Empty output, an observation timeout, or an outer orchestration cell completing does not mean its child exited and is not permission to restart it. Preserve child handles and exit status through waits. When asked to await completion, keep working until verified; session cleanup can terminate unfinished children. Verify the requested outcome or artifact before claiming success, otherwise report the unresolved state.`;
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
  return `\n## Location Awareness

The server's timezone, IP address, Wi-Fi or locale does not reveal the user's physical location. For location-dependent requests, ask for the location only when it is needed and has not been provided.`;
}
