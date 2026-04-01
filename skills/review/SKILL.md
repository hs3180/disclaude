---
name: review
description: Imperial review experience specialist - guides the agent to request user review after completing tasks using temp chat + interactive cards. Use when task is done and user approval/feedback is needed. Keywords: "review", "审批", "御书房", "approve", "确认", "请求review", "提交审批".
allowed-tools: Read, Glob, Bash, Task, send_user_feedback
---

# Review - Imperial Study Review Experience

When you complete a task and need the user's approval, feedback, or decision, use the **Imperial Study (御书房)** workflow to provide a smooth, one-click review experience.

## Core Principle

> **御书房体验 = 临时群聊基础设施 + 现有工具组合**

Do NOT invent new tools. Use the existing tool combination:
- `create_chat` — create a dedicated review group
- `register_temp_chat` — register lifecycle, auto-cleanup on expiry
- `send_text` — describe what was done
- `send_interactive` — present decision buttons

---

## When to Use This Skill

Use the Imperial Study review workflow when:

1. **Code changes completed** — implemented a feature, fixed a bug, refactored code
2. **Document created** — generated a report, analysis, or documentation
3. **Configuration changed** — modified settings, deployed something
4. **Research completed** — finished an investigation and need direction
5. **User explicitly requests review** — "帮我看看", "检查一下", "review 一下"

**Do NOT use for:**
- Simple questions that don't require approval
- Ongoing conversations that don't need a decision
- Tasks that are fully autonomous (no user decision needed)

---

## Review Workflow

### Step 1: Summarize What Was Done

Before creating the review group, prepare a clear summary of the work:

```
## Summary Points
1. What was the task? (1 sentence)
2. What was done? (2-3 bullet points)
3. What changed? (files, configs, etc.)
4. Why? (rationale for key decisions)
```

**Keep it concise.** The user should understand the full picture in under 10 seconds.

### Step 2: Create Temp Review Group

```json
{
  "name": "📋 Review: [Brief Task Name]",
  "description": "Review session for [task]"
}
```

Use `create_chat` to create a dedicated group for this review.

### Step 3: Register Temp Chat Lifecycle

```json
{
  "chatId": "<new_chat_id>",
  "expiresAt": "<ISO timestamp, e.g., 2 hours from now>",
  "creatorChatId": "<original_chat_id>",
  "context": {
    "taskType": "review",
    "sourceChatId": "<original_chat_id>"
  }
}
```

**Recommended expiry**: 2-4 hours for routine reviews, 24h for complex decisions.

### Step 4: Present Review Content

Send a clear, structured review summary using `send_text`:

```markdown
## 📋 Review Summary

**Task**: [What was requested]
**Status**: ✅ Completed

### Changes
- [Change 1]: [Brief description]
- [Change 2]: [Brief description]

### Key Decisions
- [Decision 1]: [Why this approach was chosen]

### Files Modified
- `path/to/file1.ts` — [what changed]
- `path/to/file2.md` — [what changed]
```

### Step 5: Request Decision via Interactive Card

Send an interactive card with clear action buttons using `send_interactive`:

```json
{
  "question": "请审阅以上变更，选择下一步操作：",
  "options": [
    { "text": "✅ 批准", "value": "approve", "type": "primary" },
    { "text": "✏️ 需要修改", "value": "request_changes", "type": "default" },
    { "text": "❌ 拒绝", "value": "reject", "type": "danger" }
  ],
  "title": "📋 Review Request",
  "actionPrompts": {
    "approve": "[用户操作] 用户选择了「✅ 批准」",
    "request_changes": "[用户操作] 用户选择了「✏️ 需要修改」",
    "reject": "[用户操作] 用户选择了「❌ 拒绝」"
  }
}
```

### Step 6: Handle User Response

When the user clicks a button:

| User Action | Your Response |
|-------------|--------------|
| **✅ 批准** | Confirm completion. Clean up if needed. Report outcome. |
| **✏️ 需要修改** | Ask what to change. Implement changes. Re-submit for review. |
| **❌ 拒绝** | Acknowledge. Ask for rationale. Revert if appropriate. |

---

## Review Card Templates

### Template 1: Code Review (Most Common)

```json
{
  "title": "📋 Code Review",
  "context": "Task: [task description]\nBranch: [branch name]",
  "question": "## Changes\n[summary of changes]\n\n## Impact\n[what areas are affected]\n\n请审阅以上代码变更：",
  "options": [
    { "text": "✅ LGTM", "value": "approve", "type": "primary" },
    { "text": "✏️ 需要修改", "value": "request_changes", "type": "default" },
    { "text": "❌ 不通过", "value": "reject", "type": "danger" }
  ]
}
```

### Template 2: Document Review

```json
{
  "title": "📄 Document Review",
  "context": "Document: [document name]",
  "question": "## 文档摘要\n[key points]\n\n请审阅以上文档内容：",
  "options": [
    { "text": "✅ 确认无误", "value": "approve", "type": "primary" },
    { "text": "✏️ 补充修改", "value": "request_changes", "type": "default" },
    { "text": "🔄 重新生成", "value": "regenerate", "type": "default" }
  ]
}
```

### Template 3: Decision Review

```json
{
  "title": "🤔 Decision Review",
  "context": "Decision needed for: [topic]",
  "question": "## 方案\n[proposed approach]\n\n## 理由\n[why this approach]\n\n请选择：",
  "options": [
    { "text": "✅ 同意方案", "value": "approve", "type": "primary" },
    { "text": "🔄 选择方案 B", "value": "alternative", "type": "default" },
    { "text": "❌ 不同意", "value": "reject", "type": "danger" }
  ]
}
```

### Template 4: Simple Approval (Lightweight)

For minor changes that just need a quick nod:

```json
{
  "title": "✅ Quick Approval",
  "question": "[One-line description of what was done]\n\n确认以上操作？",
  "options": [
    { "text": "👍 OK", "value": "approve", "type": "primary" },
    { "text": "🚫 等一下", "value": "hold", "type": "default" }
  ]
}
```

---

## Best Practices

### DO ✅

1. **Be concise** — The user should understand everything in under 10 seconds
2. **Use one group per review** — Don't mix multiple reviews in one group
3. **Set appropriate expiry** — 2-4h for routine, 24h for complex
4. **Include file paths** — So the user knows exactly what was changed
5. **Provide context** — Brief rationale for key decisions
6. **Use `send_text` for content, `send_interactive` for decisions** — Don't cram everything into the card
7. **Register temp chat** — Always register for auto-cleanup

### DO NOT ❌

1. **Don't create new MCP tools** — Use existing tool combinations (avoid tool hell)
2. **Don't use multiple interaction methods** — One flow, "就事论事" (stick to the point)
3. **Don't overwhelm with details** — Summary first, details on request
4. **Don't skip the review group** — Don't review in the original chat (creates noise)
5. **Don't create custom card builders** — Use `send_interactive` with simple options
6. **Don't block waiting** — After sending the review card, your job is done until the user responds

### Review Content Guidelines

| Aspect | Guideline |
|--------|-----------|
| **Length** | Under 200 words total |
| **Structure** | What → Why → Impact → Decision |
| **Tone** | Professional, objective, no fluff |
| **Evidence** | Include file paths, metrics, test results |
| **Options** | 2-3 buttons max (approve + modify + reject) |

---

## Lifecycle Management

```
create_chat → register_temp_chat → send_text (summary) → send_interactive (decision)
                                                                    ↓
                                                          User responds
                                                                    ↓
                                                    Agent acts on decision
                                                                    ↓
                                              mark_chat_responded (if available)
                                                                    ↓
                                              Temp chat auto-dissolves on expiry
```

The temp chat lifecycle ensures:
- Review groups are automatically cleaned up
- No orphaned groups cluttering the workspace
- The creator chat can be notified on expiry

---

## Example: Complete Review Flow

### Scenario: Agent fixed a bug and needs approval

**Agent's actions:**

1. `create_chat({ name: "📋 Review: Fix login timeout bug" })` → gets `chatId: oc_review123`

2. `register_temp_chat({ chatId: "oc_review123", expiresAt: "2026-04-01T14:00:00.000Z", creatorChatId: "oc_original" })`

3. `send_text({ chatId: "oc_review123", text: "## 📋 Bug Fix Review\n\n**Issue**: Login request times out after 30s\n**Root Cause**: Missing retry logic in auth middleware\n**Fix**: Added exponential backoff retry (3 attempts)\n\n### Changes\n- `src/middleware/auth.ts` — Added retry wrapper with backoff\n- `tests/auth.test.ts` — Added 3 test cases for retry behavior\n\n### Test Results\n- All 47 tests passing ✅\n- New tests cover: success on retry, max retries exceeded, backoff timing" })`

4. `send_interactive({ chatId: "oc_review123", title: "📋 Bug Fix Review", question: "请审阅以上 Bug 修复：", options: [...], actionPrompts: {...} })`

**User clicks "✅ 批准"** → Agent receives: `[用户操作] 用户选择了「✅ 批准」`

**Agent responds:** "✅ Review approved. Bug fix is ready. The temp review group will auto-clean in 2 hours."

---

## Integration with Task Workflow

The review skill fits naturally into the task completion flow:

```
Task Started → Work in Progress → Task Completed → [REVIEW SKILL] → User Decision → Done
```

When you detect that a task is complete and needs user approval, automatically invoke this review workflow. Do not ask the user "do you want me to create a review?" — just create it.
