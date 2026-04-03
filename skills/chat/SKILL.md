---
name: chat
description: Temporary group chat lifecycle management. Create, query, list, and respond to temporary group chats with four-state lifecycle (pending → active → expired / failed). Use when user says "创建群聊", "临时会话", "创建讨论组", "chat status", "list chats", "临时群". Keywords: chat, group, create chat, temporary, session, 群聊, 会话.
allowed-tools: [Read, Write, Edit, Bash, Glob, send_user_feedback]
---

# Chat Lifecycle Manager

Manage temporary group chat lifecycle with file-based state tracking.

## When to Use This Skill

**Use this skill for:**
- Creating a new temporary group chat
- Querying the status of an existing chat
- Listing all chats
- Updating a chat with user response
- Marking a chat as failed

**Keywords**: "创建群聊", "临时会话", "创建讨论组", "chat status", "list chats", "临时群", "会话管理"

## Single Responsibility

- ✅ Create/query/list/update temporary chat sessions
- ✅ Manage chat JSON files in `workspace/chats/`
- ❌ DO NOT send messages to chats (consumer skill's responsibility)
- ❌ DO NOT create or dissolve groups (handled by `chats-activation` schedule via `lark-cli`)
- ❌ DO NOT handle timeout/cleanup (handled by `chat-timeout` skill)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Chat File Format

Chats are stored as JSON files in `workspace/chats/`:

```
workspace/chats/
├── {chatId}.json
├── pr-123.json
└── review-456.json
```

### JSON Schema

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
  "context": {"prNumber": 123},
  "response": null,
  "activationAttempts": 0,
  "lastActivationError": null,
  "failedAt": null
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (slug format, e.g. `pr-123`) |
| `status` | enum | Yes | `pending` / `active` / `expired` / `failed` |
| `chatId` | string\|null | Yes | Feishu group chat ID (null until activated) |
| `createdAt` | ISO 8601 | Yes | Creation timestamp |
| `activatedAt` | ISO 8601\|null | Yes | When the group was created (null until activated) |
| `expiresAt` | ISO 8601 | Yes | Expiration timestamp (set at creation) |
| `createGroup` | object | Yes | Group creation config: `{name, members}` |
| `context` | object | No | Arbitrary context for consumer skills |
| `response` | object\|null | No | User response data (set when user responds in group) |
| `activationAttempts` | number | Yes | Number of activation attempts (default: 0) |
| `lastActivationError` | string\|null | No | Last error during activation attempt |
| `failedAt` | ISO 8601\|null | No | When the chat failed |

### Status Lifecycle

```
pending ──→ active ──→ expired
   │           │
   └──────→ failed
```

| Transition | Trigger | Actor |
|------------|---------|-------|
| → pending | Chat file created | This skill |
| pending → active | Group created via `lark-cli` | `chats-activation` schedule |
| active → expired | Timeout reached | `chat-timeout` skill |
| pending/active → failed | Max retries or manual | `chats-activation` schedule or this skill |

---

## Operations

### 1. Create Chat

**Steps:**
1. Ensure `workspace/chats/` directory exists:
   ```bash
   mkdir -p workspace/chats
   ```
2. Validate required parameters:
   - `id`: Unique slug identifier (no spaces, use hyphens)
   - `createGroup.name`: Group name (string)
   - `createGroup.members`: Array of member open IDs
   - `expiresAt`: Expiration timestamp (default: 24 hours from now)
3. Check for duplicate ID:
   ```bash
   ls workspace/chats/{id}.json 2>/dev/null
   ```
   If file exists, report error and abort.
4. Generate JSON content with defaults:
   - `status`: `"pending"`
   - `chatId`: `null`
   - `createdAt`: Current ISO 8601 timestamp
   - `activatedAt`: `null`
   - `activationAttempts`: 0
   - `response`: `null`
   - `lastActivationError`: `null`
   - `failedAt`: `null`
5. Write file using Write tool: `workspace/chats/{id}.json`
6. Send feedback confirming creation

**Example:**
```bash
# Create a chat file for PR review
cat > workspace/chats/pr-123.json << 'JSONEOF'
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
  "context": {"prNumber": 123},
  "response": null,
  "activationAttempts": 0,
  "lastActivationError": null,
  "failedAt": null
}
JSONEOF
```

### 2. Query Chat

**Steps:**
1. Read the chat file: `workspace/chats/{id}.json`
2. If file does not exist, report error
3. Parse and display chat status

**Output Format:**
```
📋 Chat: {id}
- Status: {status emoji} {status}
- Group Name: {createGroup.name}
- Members: {createGroup.members}
- Created: {createdAt}
- Expires: {expiresAt}
- Chat ID: {chatId or "Not yet created"}
- Activation Attempts: {activationAttempts}
```

Status emojis:
- `pending` → 🟡
- `active` → 🟢
- `expired` → ⚫
- `failed` → 🔴

### 3. List Chats

**Steps:**
1. List all chat files:
   ```bash
   ls workspace/chats/*.json 2>/dev/null
   ```
2. If no files, report "No chats found"
3. Read each file and extract key fields
4. Display as a table sorted by `createdAt` (newest first)

**Output Format:**
```
📋 Chats ({count} total):

| ID | Status | Group Name | Created | Expires |
|----|--------|------------|---------|---------|
| pr-123 | 🟢 active | PR #123 Review | 2026-03-24 10:00 | 2026-03-25 10:00 |
| review-456 | 🟡 pending | Code Review | 2026-03-24 09:00 | 2026-03-25 09:00 |
```

### 4. Update Chat Response

**Steps:**
1. Read the chat file: `workspace/chats/{id}.json`
2. Verify status is `active` (only active chats can receive responses)
3. Update the `response` field with user response data
4. Write the updated file back

### 5. Mark Chat as Failed

**Steps:**
1. Read the chat file: `workspace/chats/{id}.json`
2. Update fields:
   - `status`: `"failed"`
   - `failedAt`: Current ISO 8601 timestamp
3. Write the updated file back

---

## Important Behaviors

1. **File-first design**: All state is stored in JSON files under `workspace/chats/`
2. **ID uniqueness**: Each chat must have a unique `id` (used as filename)
3. **Immutable creation**: Once created, `id`, `createdAt`, `createGroup` should not be modified
4. **Separation of concerns**: This skill only manages files — group operations and message sending are handled by other components

## DO NOT

- ❌ Call `lark-cli` for group creation/dissolution (handled by `chats-activation` schedule)
- ❌ Send messages to groups (consumer skill's responsibility)
- ❌ Delete chat files directly (handled by `chats-cleanup` schedule)
- ❌ Modify `status` to values outside the lifecycle (pending/active/expired/failed)
- ❌ Create chats with duplicate IDs
- ❌ Use `session` terminology — always use `chat`
- ❌ Use MCP tools (`create_chat`/`dissolve_chat`) for group operations

## Related

- `schedules/chats-activation.md` — Auto-activates pending chats via `lark-cli`
- `skills/chat-timeout/SKILL.md` — Handles chat expiration and group dissolution
- `schedules/chats-cleanup.md` — Cleans up stale expired chat files
