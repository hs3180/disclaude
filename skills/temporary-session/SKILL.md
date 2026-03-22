---
name: temporary-session
description: Temporary session management for non-blocking user interactions. Creates sessions that ask user questions via group/private chats and track responses. Use when you need to create a temporary discussion session, ask user for approval/feedback in a separate chat, or implement ask-and-wait workflows. Triggered by keywords: "临时会话", "session", "等待用户", "ask user", "approval", "等待审批", "非阻塞交互". Related issues: #393, #631, #946, #1317.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, mcp__channel-mcp__send_text, mcp__channel-mcp__send_interactive, mcp__channel-mcp__send_card
---

# Temporary Session Management

Manage temporary sessions for non-blocking user interactions. Each session follows a lifecycle: create → send → wait for response → process.

## When to Use This Skill

**✅ Use this skill for:**
- Creating temporary discussion groups for PR reviews
- Sending non-blocking questions to users
- Waiting for user approval/feedback without blocking current work
- Implementing "ask and wait" workflows

**❌ DO NOT use this skill for:**
- Simple inline questions (use `ask_user` tool directly)
- Blocking operations that need immediate response
- Creating permanent chat groups

## Session Lifecycle

```
1. Create session files (session.md + state.yaml)
2. Management schedule picks up pending sessions
3. Schedule creates group chat and sends interactive card
4. User clicks a button or types a response
5. Card click handler updates state.yaml
6. Caller polls session status to get response
```

## Creating a Session

### Step 1: Create Session Directory

Create a folder in `workspace/temporary-sessions/{session-id}/`:
- Use a descriptive ID (e.g., `pr-123-review`, `deploy-confirm-456`)

### Step 2: Create session.md (Static Configuration)

```markdown
---
type: blocking
purpose: pr-review
channel:
  type: group
  name: "PR #123: Fix auth bug"
  members:
    - ou_developer
expiresIn: 24h
context:
  prNumber: 123
  repository: hs3180/disclaude
---

# 🔔 PR 审核请求

**PR #123**: Fix authentication bug

Please review and decide how to proceed.

## Options
- [merge] ✓ 合并
- [close] ✗ 关闭
- [wait] ⏳ 等待
```

### Step 3: Create state.yaml (Initial State)

```yaml
status: pending
createdAt: "2026-03-10T10:00:00.000Z"
expiresAt: "2026-03-11T10:00:00.000Z"
```

### Step 4: Ensure Management Schedule is Enabled

Check if `schedules/temporary-sessions.md` has `enabled: true`. If not, enable it using the Edit tool.

## Session Types

### Blocking Session (`type: blocking`)

Used when the caller needs to wait for a response before proceeding:
- PR Scanner waits for merge/reject decision
- Deploy approval requires explicit confirmation

### Non-Blocking Session (`type: non-blocking`)

Used when the caller can continue working:
- Offline questions for later review
- Informational notifications that don't require action

## Channel Types

| Type | When to Use | Behavior |
|------|-------------|----------|
| `group` | Need dedicated discussion space | Creates new group chat |
| `existing` | Target specific chat | Uses existing chatId |
| `private` | Direct message to user | Sends via private chat |

## Polling for Response

After creating a session, periodically check its status:

```bash
# Read state.yaml
cat workspace/temporary-sessions/{session-id}/state.yaml
```

### Response States

| Status | Meaning | Action |
|--------|---------|--------|
| `pending` | Waiting to be sent | Wait |
| `sent` | Message sent, waiting for response | Wait |
| `replied` | User responded | Process `response.selectedValue` |
| `expired` | Timeout, no response | Handle timeout |

### Handling User Response

When status is `replied`, read the response:

```yaml
response:
  selectedValue: merge
  responder: ou_developer
  repliedAt: "2026-03-10T14:30:00.000Z"
  textInput: "Looks good, approved!"
```

## Card Click Handling

When the user clicks a button on the interactive card:

1. Find the session by `messageId` in `state.yaml`
2. Update `state.yaml`:
   - `status: replied`
   - `response.selectedValue: <button value>`
   - `response.responder: <user open_id>`
   - `response.repliedAt: <current ISO timestamp>`

## Cleanup

After processing a response, optionally clean up:
- Delete the session folder if no longer needed
- Or leave it for audit trail (will be auto-cleaned after 7 days)

## Common Patterns

### PR Review Flow
1. Create session with `purpose: pr-review`, `type: blocking`
2. Include PR details in session.md body
3. Options: merge, request_changes, close, wait
4. Poll until replied, then execute gh pr command

### Offline Question Flow
1. Create session with `purpose: offline-question`, `type: non-blocking`
2. Use `channel.type: existing` with the user's chat
3. Continue working while waiting for response
4. Check response on next interaction

### Agent Confirm Flow
1. Create session with `purpose: agent-confirm`, `type: blocking`
2. Send summary of proposed action
3. Options: approve, reject, modify
4. Only proceed with action after approval
