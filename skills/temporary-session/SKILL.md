---
name: temporary-session
description: Temporary session management for creating interactive sessions that wait for user responses. Use when needing to create a session that asks user a question via group chat, waits for their response, and retrieves the result. Keywords: "临时会话", "等待回复", "发起讨论", "session", "waiting for response", "ask user".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Temporary Session Management

Manage file-based temporary sessions for the "ask user → wait for response → get response" pattern.

## Overview

Temporary sessions allow agents to:
1. Create a session with a question and options
2. Optionally create a group chat for discussion
3. Send an interactive card with options
4. Wait for the user to respond (via polling)
5. Retrieve the user's response

## Session Lifecycle

```
pending → active → expired
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | Created, waiting for group chat setup | Agent creates session file |
| `active` | Group chat created, waiting for response | Schedule creates group + sends card |
| `expired` | Session ended | User responded OR timed out |

## Session File Location

Session files are stored as JSON in `workspace/temporary-sessions/`:
- Path: `workspace/temporary-sessions/{session-id}.json`

## Session File Format (JSON)

```json
{
  "id": "pr-123-review",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "expiresAt": "2026-03-11T10:00:00Z",
  "createGroup": {
    "name": "PR #123: Fix auth bug",
    "members": ["ou_developer"]
  },
  "message": "# 🔔 PR Review Request\n\nPlease review PR #123",
  "options": [
    { "value": "merge", "text": "✅ Merge" },
    { "value": "close", "text": "❌ Close" },
    { "value": "wait", "text": "⏳ Wait" }
  ],
  "context": { "prNumber": 123, "repository": "hs3180/disclaude" },
  "response": null,
  "createdAt": "2026-03-10T10:00:00Z",
  "updatedAt": "2026-03-10T10:00:00Z"
}
```

## Usage Guide

### Creating a Session

Use the `Write` tool to create a new session file:

```json
// workspace/temporary-sessions/pr-123-review.json
{
  "id": "pr-123-review",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "expiresAt": "2026-03-11T10:00:00Z",
  "createGroup": {
    "name": "PR #123 Review",
    "members": []
  },
  "message": "Please review this PR and select an action.",
  "options": [
    { "value": "approve", "text": "✅ Approve" },
    { "value": "request_changes", "text": "🔄 Request Changes" },
    { "value": "skip", "text": "⏭️ Skip" }
  ],
  "context": { "prNumber": 123 },
  "response": null,
  "createdAt": "2026-03-10T10:00:00Z",
  "updatedAt": "2026-03-10T10:00:00Z"
}
```

**Important**:
- `id` must be unique across all sessions
- `expiresAt` should be set to a future ISO timestamp
- `createGroup.members` can be empty (only invite current user)
- `context` is arbitrary data for your own use

### Checking Session Status

Use the `Read` tool to read the session file:

```bash
cat workspace/temporary-sessions/pr-123-review.json
```

Then check:
- `status === "expired" && response !== null` → User has responded, use `response.selectedValue`
- `status === "expired" && response === null` → Timed out with no response
- `status === "pending"` → Not yet picked up by the schedule
- `status === "active"` → Waiting for user response

### Handling User Response

When a session has expired with a response:
```json
{
  "status": "expired",
  "response": {
    "selectedValue": "approve",
    "responder": "ou_xxx",
    "repliedAt": "2026-03-10T10:30:00Z"
  }
}
```

Use `response.selectedValue` to determine the user's choice.

### Cleaning Up

After processing a completed session, delete the file:
```bash
rm workspace/temporary-sessions/pr-123-review.json
```

## Integration with Schedules

The `temporary-sessions` schedule handles the automated parts:
- Scanning for `pending` sessions and creating group chats
- Sending interactive cards with options
- Checking for timed-out `active` sessions

You only need to:
1. Create the session file
2. Poll the file until it expires
3. Process the response

## Card Action Format

When the schedule creates the interactive card, it uses `actionPrompts` to map button values to prompts:

```json
{
  "approve": "[用户操作] 用户选择了「✅ Approve」。会话ID: {sessionId}",
  "request_changes": "[用户操作] 用户选择了「🔄 Request Changes」。会话ID: {sessionId}",
  "skip": "[用户操作] 用户选择了「⏭️ Skip」。会话ID: {sessionId}"
}
```

## Best Practices

1. **Use descriptive session IDs**: `pr-123-review`, `deploy-approval-20260310`
2. **Set reasonable timeouts**: 60 minutes is default, adjust based on urgency
3. **Clean up expired sessions**: Delete files after processing to avoid clutter
4. **Include context**: Store all data needed for post-response processing in `context`
5. **Poll at intervals**: Check session status every 1-5 minutes, don't busy-wait
