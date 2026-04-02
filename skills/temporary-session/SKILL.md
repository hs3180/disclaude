---
name: temporary-session
description: Temporary session lifecycle management for creating short-lived group chats with interactive cards. Creates session files, manages three-state lifecycle (pending -> active -> expired). Use when user says "临时会话", "temporary session", "创建会话", "发起评审", "request review", or needs to create a time-limited group discussion. Triggered by keywords: "临时会话", "temporary session", "创建会话", "发起评审", "request review", "create group".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Temporary Session Manager

Manage temporary sessions with a three-state lifecycle: **pending** → **active** → **expired**.

## When to Use This Skill

**✅ Use this skill for:**
- Creating temporary group chats with interactive cards
- Managing session lifecycle (create, query, list, respond, expire)
- Requesting reviews or decisions via time-limited group discussions

**❌ DO NOT use this skill for:**
- One-time messages → Use direct `send_text` / `send_interactive` instead
- Persistent groups → Use group management directly
- Scheduled periodic tasks → Use `/schedule` skill instead

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Session File Format

Session files are stored in `workspace/sessions/` as JSON files.

**Filename**: `{sessionId}.json`

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
    "memberIds": ["ou_user1"]
  },
  "message": {
    "title": "PR Review Request",
    "context": "Please review PR #123",
    "question": "How should we proceed with this PR?",
    "options": [
      {"text": "✅ Merge", "value": "merge", "type": "primary"},
      {"text": "🔄 Request Changes", "value": "changes", "type": "default"},
      {"text": "❌ Close", "value": "close", "type": "danger"}
    ]
  },
  "actionPrompts": {
    "merge": "[Session: {id}] User approved merge. Execute merge for the associated item.",
    "changes": "[Session: {id}] User requested changes. Ask what needs to be modified.",
    "close": "[Session: {id}] User chose to close. Clean up and dismiss."
  },
  "response": null,
  "metadata": {}
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique session identifier (e.g., `pr-123`, `review-456`) |
| `status` | Yes | One of: `pending`, `active`, `expired` |
| `chatId` | No | Group chat ID (set when activated) |
| `createdAt` | Yes | ISO 8601 timestamp of creation |
| `activatedAt` | No | ISO 8601 timestamp of activation |
| `expiresAt` | Yes | ISO 8601 timestamp for session expiry |
| `createGroup` | Yes | Group creation config (`name`, `description`, `memberIds`) |
| `message` | Yes | Card message config (`title`, `context`, `question`, `options`) |
| `actionPrompts` | Yes | Map of option value → action prompt for Agent |
| `response` | No | User's response after interaction |
| `metadata` | No | Arbitrary key-value data for context |

---

## Operations

### 1. Create Session

**Steps:**
1. Generate a unique session ID
2. Collect session parameters:
   - Session ID (descriptive, e.g., `pr-123`)
   - Group name and members
   - Card message content (title, context, question, options)
   - Action prompts for each option
   - Expiry duration (default: 24 hours)
3. Ensure `workspace/sessions/` directory exists
4. Write session file using `Write` tool
5. **Notify user** that session has been created and will be activated by schedule

**Example:**
```bash
# Ensure sessions directory exists
mkdir -p workspace/sessions
```

Then write the session JSON file to `workspace/sessions/{sessionId}.json`.

### 2. List Sessions

**Steps:**
1. Use `Glob` to find `workspace/sessions/*.json`
2. Read each file and parse JSON
3. Display as a formatted table

**Output Format:**
```
| ID | Status | Group | Created | Expires |
|----|--------|-------|---------|---------|
| pr-123 | pending | PR #123 Review | 2026-03-24 10:00 | 2026-03-25 10:00 |
```

### 3. Query Session

**Steps:**
1. Read `workspace/sessions/{sessionId}.json`
2. Display full session details

### 4. Handle Response

When an action prompt is received containing `[Session: {id}]`:
1. Extract session ID from the action prompt
2. Read the session file
3. Update `response` field with user's choice
4. Write updated session file

### 5. Expire Session

**Steps:**
1. Read session file
2. Update `status` to `expired`
3. Write updated session file

---

## MCP Tools Used

The following MCP tools are used by the **Schedule** (not directly by this Skill):

| Tool | Purpose | When Used |
|------|---------|-----------|
| `create_chat` | Create group chat | Session activation |
| `send_interactive` | Send interactive card | Session activation |
| `register_temp_chat` | Register for auto-expiry | Session activation |
| `dissolve_chat` | Dissolve expired group | Session expiry |

---

## Session Lifecycle

```
┌──────────┐     Schedule activates     ┌──────────┐     Timeout or     ┌──────────┐
│ pending  │ ─────────────────────────→ │  active  │ ────────────────→ │ expired  │
└──────────┘                            └──────────┘                   └──────────┘
                                              │                            │
                                         User responds              Clean up
                                         via action prompt         session file
```

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| `pending` | `active` | Schedule creates group + sends card |
| `active` | `expired` | Timeout reached or manual expiry |
| `expired` | (deleted) | Schedule cleanup after grace period |

---

## Design Principles

1. **Skill creates, Schedule manages**: This Skill only creates session files. The Schedule handles activation, expiry, and cleanup.
2. **File-based state**: All state is in JSON files under `workspace/sessions/`. No in-memory state.
3. **Action prompts include session ID**: Every action prompt contains `[Session: {id}]` so responses can be routed to the correct session.
4. **MCP tools for platform ops**: Group creation, card sending, and dissolution use MCP tools via IPC.
5. **Graceful degradation**: If group creation fails, the session remains `pending` and will be retried on the next schedule run.

---

## DO NOT

- ❌ Directly activate sessions (that's the Schedule's job)
- ❌ Use `create_chat` or `dissolve_chat` MCP tools directly from this Skill
- ❌ Create sessions without specifying an expiry time
- ❌ Delete session files (mark as expired, let Schedule clean up)
- ❌ Use hardcoded paths (always use `workspace/sessions/`)
