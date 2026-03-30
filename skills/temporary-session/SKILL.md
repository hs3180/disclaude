---
name: temporary-session
description: Temporary session lifecycle manager for creating, querying, and responding to time-bound group discussions. Use when user wants to create a temporary session, check session status, list sessions, or handle session responses. Triggered by keywords: "临时会话", "temporary session", "创建会话", "发起讨论", "session", "会话管理".
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, send_user_feedback, create_chat, dissolve_chat, register_temp_chat]
---

# Temporary Session Manager

Manage time-bound temporary sessions with full lifecycle: creation → activation → expiration.

## When to Use This Skill

**✅ Use this skill for:**
- Creating a new temporary session (group chat with time limit)
- Listing all sessions and their statuses
- Querying a specific session's details
- Handling user responses from session group chats
- Manually expiring or dissolving a session

**❌ DO NOT use this skill for:**
- Managing persistent group chats → Use `create_chat` / `dissolve_chat` directly
- Creating scheduled tasks → Use `/schedule` skill instead
- One-time messages without lifecycle → Use `send_user_feedback` directly

## Session Lifecycle

```
┌─────────────┐     Group chat created     ┌─────────────┐
│   pending   │ ──────────────────────────>│   active    │
│  Waiting to │                             │  Waiting for│
│  be created │                             │  user resp. │
└─────────────┘                             └──────┬──────┘
                                                   │
                                   ┌───────────────┼───────────────┐
                                   ▼                               ▼
                             ┌──────────┐                     ┌──────────┐
                             │  expired │                     │ resolved │
                             │  Timed   │                     │  User    │
                             │  out     │                     │  replied │
                             └──────────┘                     └──────────┘
```

## Session Storage

Session files are stored in `workspace/sessions/` as JSON files.

**Filename format**: `{sessionId}.json`

### Session File Format

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
    "description": "Review discussion for PR #123",
    "memberIds": []
  },
  "message": {
    "title": "🔔 PR Review Request",
    "body": "Please review PR #123...",
    "options": [
      {"value": "approve", "text": "✅ Approve"},
      {"value": "request_changes", "text": "🔄 Request Changes"},
      {"value": "skip", "text": "⏭️ Skip"}
    ]
  },
  "context": {"prNumber": 123, "repo": "hs3180/disclaude"},
  "response": null
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique session identifier |
| `status` | string | Yes | `pending`, `active`, `expired`, or `resolved` |
| `chatId` | string/null | Yes | Group chat ID (null until activated) |
| `createdAt` | string | Yes | ISO 8601 creation timestamp |
| `activatedAt` | string/null | Yes | ISO 8601 activation timestamp |
| `expiresAt` | string | Yes | ISO 8601 expiration timestamp |
| `createGroup` | object | Yes | Group creation parameters |
| `createGroup.name` | string | Yes | Group name |
| `createGroup.description` | string | No | Group description |
| `createGroup.memberIds` | string[] | No | Initial member IDs |
| `message` | object | Yes | Card message content |
| `message.title` | string | Yes | Card header title |
| `message.body` | string | Yes | Card body text (Markdown) |
| `message.options` | array | Yes | Button options for user interaction |
| `context` | object | No | Arbitrary context data |
| `response` | object/null | Yes | User response (null until user replies) |

---

## Operations

### 1. Create Session

Create a new pending session file.

**Steps:**
1. Collect session parameters:
   - **id**: Unique identifier (e.g., `pr-123`, `review-20260324`)
   - **expiresAt**: Expiration time (ISO 8601, default: 24h from now)
   - **createGroup**: Group name, description, member IDs
   - **message**: Card title, body, and button options
   - **context**: Optional context data

2. Validate:
   - Session ID must be unique (no existing file with same ID)
   - `expiresAt` must be in the future
   - `message.options` must have at least one option

3. Ensure session directory exists:
   ```bash
   mkdir -p workspace/sessions
   ```

4. Create session file with `Write` tool at `workspace/sessions/{id}.json`

5. **SEND FEEDBACK** confirming session creation:
   ```
   ✅ 临时会话已创建

   - **ID**: {id}
   - **状态**: pending（等待 Schedule 激活）
   - **过期时间**: {expiresAt}
   - **群组名称**: {createGroup.name}

   该会话将在下一次 Schedule 执行时自动激活（创建群组并发送卡片）。
   ```

**Example Session File:**
```json
{
  "id": "pr-456",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-31T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-04-01T10:00:00Z",
  "createGroup": {
    "name": "PR #456 Review",
    "description": "Review PR #456: Add feature X",
    "memberIds": []
  },
  "message": {
    "title": "🔔 PR Review Request",
    "body": "## PR #456: Add feature X\n\n**Author**: @developer\n**Branch**: feat/feature-x → main\n\nPlease review and decide:",
    "options": [
      {"value": "approve", "text": "✅ Approve"},
      {"value": "request_changes", "text": "🔄 Request Changes"},
      {"value": "skip", "text": "⏭️ Skip"}
    ]
  },
  "context": {"prNumber": 456, "repo": "hs3180/disclaude"},
  "response": null
}
```

---

### 2. List Sessions

List all sessions with optional status filter.

**Steps:**
1. List session files:
   ```bash
   ls workspace/sessions/*.json 2>/dev/null || echo "NO_SESSIONS"
   ```

2. Read each session file and collect status information

3. **SEND FEEDBACK** with formatted table:
   ```
   📋 临时会话列表

   | ID | 状态 | 群组 | 过期时间 |
   |-----|------|------|----------|
   | pr-456 | active | PR #456 Review | 2026-04-01 10:00 |
   | pr-123 | expired | PR #123 Review | 2026-03-25 10:00 |
   ```

   If no sessions exist:
   ```
   📋 暂无临时会话

   使用此 Skill 创建新的临时会话。
   ```

---

### 3. Query Session

Get details of a specific session.

**Steps:**
1. Read session file: `workspace/sessions/{id}.json`

2. If not found, send feedback: `❌ 会话 "{id}" 不存在`

3. **SEND FEEDBACK** with full session details:
   ```
   📋 会话详情: {id}

   - **状态**: {status}
   - **群组**: {chatId or "未创建"}
   - **创建时间**: {createdAt}
   - **激活时间**: {activatedAt or "未激活"}
   - **过期时间**: {expiresAt}
   - **上下文**: {context}
   - **用户响应**: {response or "等待中"}
   ```

---

### 4. Handle Session Response

Process user action from a session group chat.

**Context**: When a user clicks a button in the session group chat, the Agent receives an action prompt containing the session context. This operation processes that response.

**Steps:**
1. Extract session info from the action prompt (session ID and selected option)

2. Read session file: `workspace/sessions/{sessionId}.json`

3. If session not found or already resolved/expired, send feedback and stop

4. Update session file with the response:
   ```json
   {
     "response": {
       "option": "approve",
       "respondedAt": "2026-03-31T11:00:00Z"
     },
     "status": "resolved"
   }
   ```

5. **SEND FEEDBACK** confirming response:
   ```
   ✅ 会话 {sessionId} 已收到响应

   - **选择**: {option}
   - **时间**: {respondedAt}

   该会话状态已更新为 resolved。群组将在 Schedule 执行时自动清理。
   ```

---

### 5. Expire / Dissolve Session

Manually expire or dissolve a session before its natural expiration.

**Steps:**
1. Read session file: `workspace/sessions/{id}.json`

2. If session has an active `chatId`, call `dissolve_chat` MCP tool:
   ```
   dissolve_chat(chatId: "{chatId}")
   ```

3. Update session status to `expired`

4. **SEND FEEDBACK** confirming dissolution

---

## Error Handling

| Error | Handling |
|-------|----------|
| Session ID already exists | Reject creation, suggest different ID |
| Session file not found | Inform user, list available sessions |
| Invalid status transition | Reject and show valid transitions |
| `create_chat` fails | Keep session as `pending`, report error |
| `dissolve_chat` fails | Mark as expired but note dissolution failure |
| Session directory missing | Auto-create with `mkdir -p` |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## DO NOT

- ❌ Create sessions without confirming required parameters
- ❌ Modify session status directly (use the defined operations)
- ❌ Delete session files (mark as expired instead)
- ❌ Create group chats outside of the session lifecycle
- ❌ Forget to send feedback after every operation
- ❌ Hardcode chat IDs or session IDs
