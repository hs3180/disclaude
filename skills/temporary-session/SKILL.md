---
name: temporary-session
description: Temporary session management specialist - create, query, list, and respond to temporary sessions. Use when user says keywords like "临时会话", "创建会话", "temporary session", "session create", "发起讨论". Triggered by agents/schedules that need to initiate user interactions.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Temporary Session Manager

Manage temporary sessions with a three-state lifecycle: **pending → active → expired**.

Each session is a JSON file in `workspace/temporary-sessions/`. Sessions are automatically activated (group created + card sent) by the companion Schedule, and expired (group dissolved + cleaned up) after timeout.

## Single Responsibility

- ✅ Create session files (pending state)
- ✅ Query session status
- ✅ List sessions with filters
- ✅ Handle user responses (update session with response data)
- ❌ DO NOT create groups or send cards directly (Schedule handles this)
- ❌ DO NOT dissolve groups (Schedule handles this)
- ❌ DO NOT execute callbacks or downstream actions

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Session File Format

Each session is a single JSON file in `workspace/temporary-sessions/`:

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
  "message": "# 🔔 PR Review Request\n\n**PR #123**: Fix authentication bug\n\n...",
  "options": [
    {"value": "merge", "text": "✅ Merge"},
    {"value": "close", "text": "❌ Close"}
  ],
  "context": {"prNumber": 123},
  "response": null
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique session identifier (used as filename: `{id}.json`) |
| `status` | Yes | `pending` → `active` → `expired` |
| `chatId` | No | Group chat ID (filled by Schedule after group creation) |
| `createdAt` | Yes | ISO 8601 timestamp |
| `activatedAt` | No | ISO 8601 timestamp (filled by Schedule upon activation) |
| `expiresAt` | Yes | ISO 8601 timestamp (when session should expire) |
| `createGroup` | Yes | Group creation config with `name` and `members` array |
| `message` | Yes | Markdown message content for the interactive card |
| `options` | Yes | Array of `{value, text}` for interactive card buttons |
| `context` | No | Arbitrary key-value data for consumer use |
| `response` | No | User response data (filled when user clicks a button) |

### Response Format (after user interaction)

```json
{
  "response": {
    "selectedValue": "merge",
    "responder": "ou_developer",
    "repliedAt": "2026-03-24T14:30:00Z"
  }
}
```

## Operations

### 1. Create Session

**Usage**: `/temporary-session create`

Or when an agent/schedule needs to initiate a user interaction:

```bash
# Create session directory if not exists
mkdir -p workspace/temporary-sessions

# Write session file
cat > workspace/temporary-sessions/{id}.json << 'EOF'
{
  "id": "{id}",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-24T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-25T10:00:00Z",
  "createGroup": {
    "name": "Session Title",
    "members": ["ou_xxx"]
  },
  "message": "# 🔔 Session Title\n\nMessage content...",
  "options": [
    {"value": "action1", "text": "✅ Option 1"},
    {"value": "action2", "text": "❌ Option 2"}
  ],
  "context": {},
  "response": null
}
EOF
```

**Validation**:
- `id` must be unique (check existing files first)
- `members` must be a non-empty array of valid open IDs
- `expiresAt` must be after `createdAt`
- `options` must have at least one entry

### 2. Query Session

**Usage**: `/temporary-session query {id}`

```bash
cat workspace/temporary-sessions/{id}.json
```

Display session status in readable format:

```
📋 Session: pr-123
> **Status**: 🟡 Active (waiting for response)
> **Created**: 2026-03-24 10:00
> **Expires**: 2026-03-25 10:00
> **Group**: oc_xxx
> **Response**: None
```

### 3. List Sessions

**Usage**: `/temporary-session list [--status pending|active|expired]`

```bash
# List all sessions
ls workspace/temporary-sessions/*.json 2>/dev/null

# Filter by status (use jq or grep)
for f in workspace/temporary-sessions/*.json; do
  status=$(jq -r '.status' "$f")
  if [ "$status" = "active" ]; then
    echo "$f"
  fi
done
```

Display in table format:

```
📂 Temporary Sessions

| ID | Status | Created | Expires | Response |
|----|--------|---------|---------|----------|
| pr-123 | 🟡 Active | 03-24 10:00 | 03-25 10:00 | - |
| deploy-456 | 🔴 Expired | 03-23 08:00 | 03-24 08:00 | merge |
| ask-789 | 🟢 Pending | 03-24 12:00 | 03-25 12:00 | - |
```

### 4. Handle Response

**Triggered by**: Interactive card button click with action prompt containing session ID.

The action prompt format from the Schedule's interactive card:

```
[用户操作] 用户在临时会话 {id} 中选择了 {selectedValue}
```

**Steps**:

1. Extract `id` and `selectedValue` from the action prompt
2. Read the session file
3. Verify status is `active` (not already expired or responded)
4. Update the session:

```bash
# Update session with response using jq
jq '.status = "expired" |
     .response = {
       "selectedValue": "{selectedValue}",
       "responder": "{senderOpenId}",
       "repliedAt": "{currentTimestamp}"
     }' workspace/temporary-sessions/{id}.json > /tmp/session-update.json \
  && mv /tmp/session-update.json workspace/temporary-sessions/{id}.json
```

5. Send confirmation to the user

**Note**: After updating the session, the **consumer** (PR Scanner, offline questioner, etc.) is responsible for polling the session file and taking downstream action. This skill does NOT execute callbacks.

## Lifecycle States

```
┌─────────────┐     Schedule activates     ┌─────────────┐
│   pending   │ ──────────────────────────>│   active    │
│  等待创建   │     (group + card sent)     │  等待响应   │
└─────────────┘                            └──────┬──────┘
                                                 │
                                 ┌───────────────┼───────────────┐
                                 ▼               │               ▼
                           ┌──────────┐          │         ┌──────────┐
                           │  expired │<─────────┘         │  expired │
                           │ 超时未响应│                     │ 用户已响应│
                           └──────────┘                     └──────────┘
```

| Status | Meaning | Trigger | Who Sets |
|--------|---------|---------|----------|
| `pending` | Waiting for group creation | Session file created | **This Skill** |
| `active` | Group created, waiting for response | Schedule completes activation | **Schedule** |
| `expired` | Session ended | User responded OR timeout | **This Skill** (response) / **Schedule** (timeout) |

## Consumer Usage Pattern

Consumers (PR Scanner, offline questions, etc.) use this pattern:

```
1. Consumer calls this Skill → creates pending session file
2. Schedule detects pending → creates group + sends card → sets active
3. User clicks button → this Skill updates response → sets expired
4. Consumer polls session file → finds expired with response → takes action
```

Or for timeout:

```
1-2. Same as above
3. Schedule detects active + expired → sets expired (no response)
4. Consumer polls session file → finds expired without response → handles timeout
```

## Session Directory

```
workspace/temporary-sessions/
├── pr-123.json              # PR review session
├── offline-deploy-456.json  # Offline question session
└── ask-review-789.json      # Agent ask_user session
```

## DO NOT

- ❌ Create or dissolve groups (Schedule's responsibility via lark-cli)
- ❌ Send interactive cards to groups (Schedule's responsibility via MCP tool)
- ❌ Execute downstream actions based on responses (consumer's responsibility)
- ❌ Modify sessions created by other processes
- ❌ Create sessions without a valid `expiresAt`
- ❌ Use YAML format (always JSON)
- ❌ Delete session files manually (Schedule handles cleanup)

## Error Handling

| Scenario | Action |
|----------|--------|
| Session file not found | Report "Session {id} not found" |
| Session already expired | Report "Session {id} already expired, cannot update" |
| Invalid JSON in session file | Report error, do not overwrite |
| Duplicate `id` | Report "Session {id} already exists" |
| `jq` not available | Use `python3` or `node -e` as fallback |

## Example: PR Review Session

### Agent Creates Session

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-24T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-24T22:00:00Z",
  "createGroup": {
    "name": "PR #123: Fix auth bug",
    "members": ["ou_developer"]
  },
  "message": "# 🔔 PR Review Request\n\n**PR #123**: Fix authentication bug\n\n| Attribute | Value |\n|-----------|-------|\n| Author | @developer |\n| Branch | fix/auth → main |\n| Changes | +42 -18 (5 files) |\n\nPlease review and choose an action.",
  "options": [
    {"value": "merge", "text": "✅ Merge"},
    {"value": "request_changes", "text": "🔄 Request Changes"},
    {"value": "close", "text": "❌ Close"},
    {"value": "later", "text": "⏳ Later"}
  ],
  "context": {
    "prNumber": 123,
    "repository": "hs3180/disclaude"
  },
  "response": null
}
```

### Schedule Activates (automatic)

Schedule reads the pending session, creates group via `lark-cli`, sends card, updates status to `active`.

### User Responds

User clicks "✅ Merge" in the group. The action prompt triggers this Skill, which updates the session file with the response.

### PR Scanner Polls

PR Scanner (consumer) reads `pr-123.json`, finds `status: expired` with `response.selectedValue: "merge"`, executes `gh pr merge 123`.
