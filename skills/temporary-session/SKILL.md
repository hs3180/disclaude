---
name: temporary-session
description: Temporary session management specialist for creating, querying, listing, and responding to ephemeral group discussions. Use when user wants to initiate a temporary group discussion, check session status, or handle session responses. Triggered by keywords: "临时会话", "创建会话", "session", "群组讨论", "发起提问", "temporary session". For scheduled lifecycle management, see schedules/temporary-sessions.md.
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# Temporary Session Manager

Manage temporary discussion sessions with file-based state tracking. Sessions follow a three-state lifecycle: `pending` → `active` → `expired`.

## When to Use This Skill

**✅ Use this skill for:**
- Creating a new temporary session (发起临时会话)
- Querying a specific session's status
- Listing all sessions with optional status filtering
- Handling user responses to session cards
- Manually updating session state

**❌ DO NOT use this skill for:**
- Scheduled lifecycle management → Handled by `schedules/temporary-sessions.md`
- Creating permanent groups → Use direct MCP tools
- General chat operations → Use channel tools directly

**Keywords that trigger this skill**: "临时会话", "创建会话", "session", "群组讨论", "发起提问", "temporary session", "创建讨论", "会话状态"

## Core Principle

**All session state is stored in JSON files under `workspace/temporary-sessions/`**. Each session is a single JSON file named `{session-id}.json`.

## Session File Format

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-24T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-25T10:00:00Z",
  "createGroup": {
    "name": "PR #123 Review",
    "members": ["ou_user1"]
  },
  "message": "# 🔔 PR Review Request\n...",
  "options": [
    {"value": "merge", "text": "✅ Merge"}
  ],
  "context": {"prNumber": 123},
  "response": null
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique session identifier (used as filename) |
| `status` | string | Yes | `pending` → `active` → `expired` |
| `chatId` | string\|null | Yes | Group chat ID, filled after group creation |
| `createdAt` | string | Yes | ISO 8601 timestamp of creation |
| `activatedAt` | string\|null | Yes | ISO 8601 timestamp of activation |
| `expiresAt` | string | Yes | ISO 8601 timestamp for auto-expiration |
| `createGroup` | object | Yes | Group creation config (`name`, `members`) |
| `message` | string | Yes | Card message content (Markdown) |
| `options` | array | Yes | Button options (`value`, `text`) |
| `context` | object | No | Arbitrary metadata for caller use |
| `response` | object\|null | Yes | User response data after card click |

### Response Format (after user clicks button)

```json
{
  "selectedValue": "merge",
  "responder": "ou_user1",
  "repliedAt": "2026-03-24T14:30:00Z"
}
```

## Session Lifecycle

```
┌─────────────┐     Group created + card sent     ┌─────────────┐
│   pending   │ ──────────────────────────────────>│   active    │
│  Waiting    │                                    │  Awaiting   │
└─────────────┘                                    └──────┬──────┘
                                                         │
                                         ┌───────────────┼───────────────┐
                                         ▼               │               ▼
                                   ┌──────────┐          │         ┌──────────┐
                                   │  expired │<─────────┘         │  expired │
                                   │ Timeout  │                     │ Responded│
                                   └──────────┘                     └──────────┘
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | Waiting for group creation | Caller creates session file |
| `active` | Group created, awaiting user response | Schedule activates session |
| `expired` | Session ended | User responded OR timeout |

## Operations

### 1. Create Session

**Steps:**
1. Collect session parameters:
   - `id`: Unique identifier (e.g., `pr-123`, `deploy-20260324`)
   - `createGroup.name`: Group name
   - `createGroup.members`: List of member open IDs (optional)
   - `message`: Card content (Markdown)
   - `options`: Button options array
   - `expiresAt`: Expiration timestamp (default: 24h from now)
   - `context`: Optional metadata

2. Validate:
   - `id` must be URL-safe (alphanumeric, hyphens, underscores only)
   - `id` must not conflict with existing session files
   - `options` must have at least 1 item
   - `expiresAt` must be in the future

3. Create session directory if not exists:
   ```bash
   mkdir -p workspace/temporary-sessions
   ```

4. Write session file:
   ```json
   {
     "id": "{id}",
     "status": "pending",
     "chatId": null,
     "createdAt": "{now_ISO8601}",
     "activatedAt": null,
     "expiresAt": "{expiresAt}",
     "createGroup": {
       "name": "{groupName}",
       "members": ["{member1}"]
     },
     "message": "{messageContent}",
     "options": [{"value": "{val}", "text": "{label}"}],
     "context": {},
     "response": null
   }
   ```

5. **SEND FEEDBACK** confirming creation with session ID and summary

### 2. Query Session

**Steps:**
1. Read session file: `workspace/temporary-sessions/{id}.json`
2. If not found, report error
3. Format and display session status

### 3. List Sessions

**Steps:**
1. List files: `workspace/temporary-sessions/*.json`
2. Read each file
3. Optionally filter by status
4. Format as a table:

```
| ID | Status | Group | Created | Expires |
|----|--------|-------|---------|---------|
| pr-123 | active | PR #123 Review | 2026-03-24 10:00 | 2026-03-25 10:00 |
```

### 4. Handle Response (User clicked card button)

When a user clicks a button on a session card, the action prompt contains the session context. To update a session:

**Steps:**
1. Identify the session by matching the action prompt context
2. Read the session file
3. Update:
   ```json
   {
     "status": "expired",
     "response": {
       "selectedValue": "{button_value}",
       "responder": "{user_open_id}",
       "repliedAt": "{now_ISO8601}"
     }
   }
   ```
4. Write updated session file
5. **SEND FEEDBACK** confirming response recorded

### 5. Cancel Session

**Steps:**
1. Read session file
2. Verify status is `pending` (only pending sessions can be cancelled)
3. Update status to `expired`
4. Write updated session file
5. **SEND FEEDBACK** confirming cancellation

## Action Prompt Format

When the Schedule sends an interactive card for a session, the `actionPrompts` must include the session ID so the response can be routed:

```json
{
  "actionPrompts": {
    "merge": "[会话响应] 用户在临时会话 {session_id} 中选择了「✅ Merge」(value: merge)。请更新 session 文件并通知调用方。",
    "close": "[会话响应] 用户在临时会话 {session_id} 中选择了「❌ Close」(value: close)。请更新 session 文件并通知调用方。"
  }
}
```

## Context Variables

When invoked, you receive:
- **Chat ID**: From "**Chat ID:** xxx"
- **Message ID**: From "**Message ID:** xxx"
- **Sender Open ID**: From "**Sender Open ID:** xxx"

## Checklist

After each operation, verify:
- [ ] Session file written to correct path?
- [ ] JSON format valid?
- [ ] Status transition valid? (pending→active, active→expired, pending→expired)
- [ ] **Sent feedback to user?** (CRITICAL)

## DO NOT

- Modify `active` or `expired` sessions directly (only the Schedule should manage lifecycle)
- Create sessions without proper `expiresAt`
- Use YAML format (always use JSON for session files)
- Delete session files (mark as expired instead)
- Execute scheduled lifecycle management (handled by `schedules/temporary-sessions.md`)

## Example: Create a PR Review Session

```
User: Create a temporary session for PR #123 review

Agent:
1. Validate parameters
2. Write workspace/temporary-sessions/pr-123.json
3. Send feedback:
   "✅ 临时会话已创建

   | 属性 | 值 |
   |------|-----|
   | ID | pr-123 |
   | 状态 | pending |
   | 群组名 | PR #123 Review |
   | 过期时间 | 2026-03-25 10:00 |

   Schedule 将自动激活此会话（创建群组 + 发送卡片）。"
```

## Dependencies

- MCP Tool: `feishu_create_chat` (for group creation by Schedule)
- MCP Tool: `feishu_dissolve_chat` (for group dissolution by Schedule)
- MCP Tool: `send_interactive` (for card sending by Schedule)
- Directory: `workspace/temporary-sessions/`

## Related

- Parent Issue: #1391
- Schedule: `schedules/temporary-sessions.md`
- MCP Tools: #1546 (PR #1550)
