---
name: temporary-session
description: "Temporary session management - create, query, and manage temporary discussion sessions with automatic lifecycle. Use when user says 'create session', 'temporary chat', 'temp session', '临时会话', '创建会话'."
allowed-tools: Read, Write, Glob, Bash, mcp__channel-mcp__create_chat, mcp__channel-mcp__send_interactive, mcp__channel-mcp__register_temp_chat, mcp__channel-mcp__dissolve_chat, mcp__channel-mcp__send_text
---

# Temporary Session Manager

Create and manage temporary discussion sessions with automatic lifecycle (create group → send card → collect response → auto-dissolve).

## When to Use This Skill

**Use this skill for:**
- Creating a temporary group chat for a specific task (PR review, decision, etc.)
- Managing temporary session files (create, query, list, update, expire)
- Processing user responses from temporary session interactive cards

**Keywords**: "temporary session", "temp chat", "create session", "临时会话", "创建会话", "临时群聊"

## Context Variables

When invoked, you receive:
- **Chat ID**: From `**Chat ID:** xxx` in the prompt
- **Sender Open ID**: From `**Sender Open ID:** xxx` (optional)

---

## Session File Format

Sessions are stored as JSON files in `workspace/sessions/`.

### Directory Structure

```
workspace/sessions/
  pending/     # Sessions waiting to be activated
  active/      # Sessions that have been activated (group created)
  expired/     # Sessions that have been cleaned up
```

### Session File Schema (`{sessionId}.json`)

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
    "members": ["ou_user1"]
  },
  "message": "# 🔔 PR Review Request\n\nPlease review this PR...",
  "options": [
    {"text": "✅ Approve", "value": "approve", "type": "primary"},
    {"text": "🔄 Request Changes", "value": "request_changes", "type": "default"},
    {"text": "⏳ Later", "value": "later", "type": "default"}
  ],
  "context": {"prNumber": 123},
  "response": null
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique session identifier (e.g., `pr-123`, `task-456`) |
| `status` | enum | ✅ | `pending` → `active` → `expired` |
| `chatId` | string\|null | ✅ | Target chat ID (null when pending) |
| `createdAt` | ISO string | ✅ | Session creation time |
| `activatedAt` | ISO string\|null | ✅ | When the group was created |
| `expiresAt` | ISO string | ✅ | When the session should expire |
| `createGroup` | object | ✅ | Group creation config |
| `createGroup.name` | string | ✅ | Group name |
| `createGroup.description` | string | ❌ | Group description |
| `createGroup.members` | string[] | ❌ | Initial member open IDs |
| `message` | string | ✅ | Card content to send to the group |
| `options` | array | ✅ | Interactive card button options |
| `context` | object | ❌ | Arbitrary context data |
| `response` | object\|null | ✅ | User response data (populated on interaction) |

---

## Operations

### 1. Create Session

**When**: User wants to create a temporary discussion session.

**Steps**:
1. Generate a unique session ID based on the purpose (e.g., `pr-123`, `decision-20260401`)
2. Set default expiry (24 hours from now) unless user specifies otherwise
3. Write the session file to `workspace/sessions/pending/{sessionId}.json`
4. Confirm creation to the user

**Example session file creation**:
```bash
mkdir -p workspace/sessions/pending
cat > workspace/sessions/pending/pr-123.json << 'EOF'
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
    "members": ["ou_user1"]
  },
  "message": "# 🔔 PR Review Request\n\nPlease review this PR and provide feedback.",
  "options": [
    {"text": "✅ Approve", "value": "approve", "type": "primary"},
    {"text": "🔄 Request Changes", "value": "request_changes", "type": "default"},
    {"text": "⏳ Later", "value": "later", "type": "default"}
  ],
  "context": {"prNumber": 123},
  "response": null
}
EOF
```

### 2. List Sessions

List sessions by status:

```bash
# List pending sessions
ls workspace/sessions/pending/ 2>/dev/null

# List active sessions
ls workspace/sessions/active/ 2>/dev/null
```

### 3. Query Session

Read a specific session file:

```bash
cat workspace/sessions/active/{sessionId}.json
```

### 4. Activate Session (called by Schedule)

**Steps**:
1. Read session file from `workspace/sessions/pending/{sessionId}.json`
2. Call `create_chat` MCP tool:
   ```
   create_chat({
     name: session.createGroup.name,
     description: session.createGroup.description,
     memberIds: session.createGroup.members
   })
   ```
3. If `create_chat` succeeds, get the `chatId` from the result
4. Call `register_temp_chat` MCP tool for auto-cleanup:
   ```
   register_temp_chat({
     chatId: chatId,
     expiresAt: session.expiresAt,
     context: { sessionId: session.id }
   })
   ```
5. Call `send_interactive` MCP tool to send the card:
   ```
   send_interactive({
     chatId: chatId,
     question: session.message,
     options: session.options,
     title: session.createGroup.name,
     actionPrompts: {
       "<option.value>": "[临时会话 {sessionId}] 用户选择了 {{actionText}}。请根据选择执行相应操作。"
     }
   })
   ```
6. Update session file:
   - Set `status` to `active`
   - Set `chatId` to the returned chat ID
   - Set `activatedAt` to current time
   - Move file from `pending/` to `active/`

### 5. Update Session Response

**When**: User clicks a button in a temporary session group.

**Steps**:
1. Identify the session from the action prompt (contains session ID)
2. Read the session file from `workspace/sessions/active/{sessionId}.json`
3. Update the `response` field:
   ```json
   {
     "selectedValue": "approve",
     "responder": "ou_user1",
     "repliedAt": "2026-03-24T11:00:00Z"
   }
   ```
4. Write the updated file back

### 6. Expire Session

**Steps**:
1. Read session file from `workspace/sessions/active/{sessionId}.json`
2. Optionally call `dissolve_chat` (note: `TempChatLifecycleService` handles this automatically via `register_temp_chat`)
3. Set `status` to `expired`
4. Move file from `active/` to `expired/`

---

## Lifecycle Flow

```
User requests session
    │
    ▼
┌─────────────┐
│  pending     │  ← Session file created in pending/
└──────┬───────┘
       │ Schedule activates
       ▼
┌─────────────┐
│  active      │  ← Group created, card sent, registered for auto-cleanup
└──────┬───────┘
       │ Expires or user responds
       ▼
┌─────────────┐
│  expired     │  ← Group dissolved (by TempChatLifecycleService), file moved
└─────────────┘
```

## Error Handling

- If `create_chat` fails, keep the session in `pending/` and log the error
- If `send_interactive` fails after `create_chat`, the session should still be registered for cleanup
- If a session file is malformed, skip it and log a warning

## DO NOT

- Create sessions with duplicate IDs
- Activate sessions that are already `active`
- Skip `register_temp_chat` (required for auto-cleanup)
- Hardcode member IDs — always use values from the session file or user input
