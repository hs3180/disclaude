---
name: code-review
description: Code review request skill for the "imperial court" review experience. Use when completing a coding task and needing user review/approval, or when the user asks for a code review workflow. Implements Issue #946.
---

# Code Review Skill — 御书房批奏折

> "御书房批奏折" — Agent 完成任务后，在独立群聊中呈现变更摘要，用户一键决策。

## Overview

This skill guides the agent through a streamlined code review workflow using the **temporary session** MCP tools (`start_discussion` + `check_discussion`). No new MCP tools are needed — the existing infrastructure provides the full "imperial court" experience.

## Workflow

```
┌──────────────────────────────────────────────────┐
│  Step 1: Prepare Review Content                  │
│  Summarize what was done, changed, and why       │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│  Step 2: Start Discussion                        │
│  start_discussion → auto-creates group + card    │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│  Step 3: Poll for Response                       │
│  check_discussion → wait for user decision       │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│  Step 4: Execute Decision                        │
│  Approve / Reject / Revise / Defer               │
└──────────────────────────────────────────────────┘
```

## Step-by-Step Instructions

### Step 1: Prepare Review Content

Before starting the discussion, gather the following information:

1. **What was done**: Summary of the task completed
2. **What was changed**: List of files modified/added/deleted (use `git diff --stat`)
3. **Why**: Brief rationale for key decisions
4. **Testing**: What tests were run and their results

Format this as a concise review card message (Markdown):

```markdown
## 📋 Code Review Request

**Task**: [brief description]

### Changes
- `path/to/file.ts` — [what changed]
- `path/to/file2.ts` — [what changed]

### Key Decisions
- [decision 1 and rationale]
- [decision 2 and rationale]

### Test Results
- ✅ [test suite 1]: passed
- ✅ [test suite 2]: passed

### Summary
[One-paragraph summary of the overall change]
```

> ⚠️ **Keep it concise** — the user should understand everything at a glance. Avoid lengthy diffs or raw code blocks. Focus on *what* and *why*, not *how*.

### Step 2: Start Discussion

Use `start_discussion` to create the review session. This single call handles group creation and interactive card sending:

```json
{
  "topic": "Code Review - [brief task description]",
  "message": "[the review content from Step 1]",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "✏️ Request Changes", "value": "revise", "type": "default" },
    { "text": "❌ Reject", "value": "reject", "type": "danger" },
    { "text": "⏳ Defer", "value": "defer", "type": "default" }
  ],
  "actionPrompts": {
    "approve": "[用户操作] 用户批准了代码变更，请继续后续操作（如提交 PR、部署等）",
    "revise": "[用户操作] 用户要求修改代码，请根据用户反馈进行调整",
    "reject": "[用户操作] 用户拒绝了代码变更，请撤销或回退相关更改",
    "defer": "[用户操作] 用户选择稍后处理，请暂停当前操作并告知用户"
  },
  "context": {
    "type": "code-review",
    "task": "[task description]",
    "branch": "[current branch name]"
  },
  "expiresInMinutes": 1440
}
```

**Key parameters**:
- `topic`: Used as group name and session identifier prefix. Keep it descriptive but short.
- `options`: Four standard review actions. Adjust based on context if needed.
- `actionPrompts`: Maps each button to an instruction that the agent will receive when the user clicks it.
- `context`: Stores metadata about the review for future reference.

> **Important**: Do NOT set `chatId` — let `start_discussion` auto-create a dedicated review group. This provides the "imperial court" isolation experience.

### Step 3: Poll for Response

After starting the discussion, poll for the user's response:

```
Use check_discussion with the sessionId returned from start_discussion.
```

**Polling strategy**:
- Wait a reasonable interval (e.g., 30 seconds) between polls
- Do not spam — the user may need time to review
- If the session expires (status: `expired`), inform the user and ask how to proceed

### Step 4: Execute Decision

Based on the user's response, take the appropriate action:

| Decision | Action |
|----------|--------|
| **✅ Approve** | Proceed with next steps (commit, push, create PR, deploy, etc.) |
| **✏️ Request Changes** | Apply the requested changes and restart the review from Step 1 |
| **❌ Reject** | Revert changes or stash them. Confirm with the user what to do. |
| **⏳ Defer** | Pause work. Summarize current progress for when the user returns. |

After executing the decision, always confirm the outcome to the user in the review group.

## Design Principles (from Issue #946)

| Principle | How This Skill Achieves It |
|-----------|---------------------------|
| **一目了然** (At a glance) | Concise review card with structured summary |
| **快速决策** (Quick decision) | One-click buttons via `start_discussion` options |
| **上下文完整** (Full context) | Dedicated group chat isolates the review discussion |
| **操作便捷** (Low friction) | `actionPrompts` auto-generate agent instructions from button clicks |

## Constraints

- **No new MCP tools** — uses existing `start_discussion` and `check_discussion`
- **No TypeScript changes** — pure prompt guidance (SKILL.md)
- **Single responsibility** — this skill only handles the review request flow, not the actual code changes

## DO NOT

- ❌ Include raw diffs or lengthy code blocks in the review card
- ❌ Create the group manually with `create_chat` — use `start_discussion` instead
- ❌ Use `send_interactive` directly — `start_discussion` wraps it with session management
- ❌ Send the review in the current chat — always create a dedicated review group
- ❌ Skip the polling step — always check for the user's response

## Example Usage

### Scenario: Agent fixes a bug and requests review

```
1. Agent completes bug fix
2. Agent runs tests → all pass
3. Agent prepares review content:
   - Bug: X crashes when Y
   - Fix: Added null check in Z
   - Tests: 142 passed
4. Agent calls start_discussion with review content
5. User sees review card in dedicated group
6. User clicks "✅ Approve"
7. Agent receives action prompt, commits and pushes the fix
8. Agent confirms completion in the review group
```
