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
 * Build the task record guidance section.
 *
 * Issue #1234: Instructs the agent to record task execution information
 * in a Markdown file for future ETA estimation. The agent records
 * estimated time, actual time, and review notes after completing
 * significant tasks.
 *
 * Phase 1 of the task ETA system: task record format and guidance.
 * Records are stored as unstructured Markdown in `.claude/task-records.md`.
 *
 * @returns Formatted task record guidance section
 */
export function buildTaskRecordGuidance(): string {
  return `

---

## Task Execution Recording

**After completing each significant task, record the execution information.**

### When to Record

Record a task entry when you have completed a meaningful unit of work, such as:
- Implementing a feature or bug fix
- Conducting research or analysis
- Running tests or diagnostics
- Any task that took more than a few minutes

### Storage Location

Append entries to \`.claude/task-records.md\` in the current working directory.
Create the file if it does not exist.

### Record Format

Append each task as a new \`##\` section with today's date and task description:

\`\`\`markdown
## YYYY-MM-DD {Brief Task Description}

- **Type**: {bugfix | feature | refactoring | research | test | docs | chore}
- **Estimated Time**: {Your estimate before starting}
- **Estimation Basis**: {Why you estimated this time — reference similar past tasks or complexity factors}
- **Actual Time**: {How long it actually took}
- **Review**: {What went well, what was underestimated, lessons learned}
\`\`\`

### Example

\`\`\`markdown
# Task Records

## 2026-05-07 Fix WebSocket Reconnection Bug

- **Type**: bugfix
- **Estimated Time**: 30 minutes
- **Estimation Basis**: Similar to the previous connection timeout fix, mostly error handling
- **Actual Time**: 45 minutes
- **Review**: Underestimated the edge case where multiple reconnects fire simultaneously. Need to add debouncing logic next time.

## 2026-05-07 Add Markdown Export Feature

- **Type**: feature
- **Estimated Time**: 1 hour
- **Estimation Basis**: Need data query + format conversion + file download, similar to the report feature
- **Actual Time**: 55 minutes
- **Review**: Estimation was accurate. The existing format helpers made conversion straightforward.
\`\`\`

### Guidelines

- **Be honest about estimates**: Even rough estimates help build estimation accuracy over time
- **Include estimation basis**: Reference similar past tasks or specific complexity factors
- **Keep reviews concise**: One or two sentences about what was learned
- **Do NOT skip recording**: Consistent records are essential for improving future estimates
- **Read existing records before estimating**: Check \`task-records.md\` for similar past tasks to improve your estimate`;
}

/**
 * Build the ETA learning guidance section.
 *
 * Issue #1234 Phase 2: Instructs the agent to maintain an `eta-rules.md`
 * file with estimation rules learned from task records. After each task
 * recording, the agent analyzes estimation accuracy and updates rules
 * incrementally.
 *
 * Phase 2 of the task ETA system: learning from task records to improve
 * estimation accuracy over time. Rules are stored as unstructured Markdown
 * in `.claude/eta-rules.md`.
 *
 * @returns Formatted ETA learning guidance section
 */
export function buildETALearningGuidance(): string {
  return `

---

## ETA Learning

**After recording a task entry, update the estimation rules based on what you learned.**

### Rules File

Maintain \`.claude/eta-rules.md\` in the current working directory.
Create the file if it does not exist.

### Initial Template

When creating \`eta-rules.md\` for the first time, use this structure:

\`\`\`markdown
# ETA Estimation Rules

## Task Type Baselines

| Type | Baseline Time | Notes |
|------|---------------|-------|
| bugfix | 15-30 minutes | Depends on reproduction difficulty |
| feature-small | 30-60 minutes | Single functionality point |
| feature-medium | 2-4 hours | Multiple components involved |
| refactoring | Varies by scope | Assess impact area first |
| research | 30-90 minutes | Depends on domain familiarity |
| test | 15-45 minutes | Depends on test complexity |
| docs | 15-30 minutes | Straightforward writing |
| chore | 5-15 minutes | Routine maintenance |

## Adjustment Rules

*(Add rules here as you learn from task records)*

## Underestimation Patterns

*(Track which task characteristics tend to be underestimated)*

## Overestimation Patterns

*(Track which task characteristics tend to be overestimated)*

## Last Updated: YYYY-MM-DD
\`\`\`

### Update Triggers

Update \`eta-rules.md\` after recording a task when **any** of these apply:

1. **Actual time differed significantly from estimate** (≥ 50% deviation)
2. **New task type** encountered for the first time
3. **New complexity factor** discovered (e.g., "async logic always takes longer")
4. **Repeated pattern** noticed across 2+ similar tasks (e.g., "refactoring auth modules consistently takes 2x baseline")

### How to Update

1. **Read existing rules** before making changes
2. **Adjust baseline times** if recent tasks consistently deviate in one direction
3. **Add new adjustment rules** when you discover a pattern, using this format:

\`\`\`markdown
- **{Pattern Description}** → baseline × {multiplier} {+/- offset}
  - Learned from: {reference to specific task or tasks}
  - Date added: YYYY-MM-DD
\`\`\`

4. **Record underestimation/overestimation patterns** in the corresponding sections
5. **Update the "Last Updated" date**

### Example Rule Addition

After completing a task where you underestimated the complexity of async error handling:

\`\`\`markdown
- **Involves async error handling** → baseline × 1.5
  - Learned from: 2026-05-07 WebSocket reconnection bug (estimated 30m, actual 45m)
  - Date added: 2026-05-07
\`\`\`

### Guidelines

- **Rules should be concise**: One-line pattern + multiplier, with a source reference
- **Don't over-specify**: Keep rules general enough to apply to similar future tasks
- **Remove stale rules**: If a rule hasn't been referenced in recent estimates, consider removing it
- **Multipliers should be conservative**: Start with small adjustments (× 1.2-1.5) and refine over time
- **Read rules before estimating**: Always check \`eta-rules.md\` and \`task-records.md\` when starting a new task`;
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
