---
name: temporary-session
description: Temporary session management for asynchronous user interactions. Use when user needs to create a temporary session to ask questions and wait for responses, or when managing pending/active/expired sessions. Triggered by keywords: "临时会话", "temporary session", "create session", "发起提问", "等待回复", "session management". For scheduled session processing, see schedules/temporary-sessions.md.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Temporary Session Management

Manage temporary sessions for asynchronous "ask → wait → respond" interactions.

## When to Use This Skill

**✅ Use this skill for:**
- Creating a temporary session to ask a user a question
- Checking the status of an existing temporary session
- Listing all active/pending sessions
- Cleaning up expired sessions
- Any scenario requiring "create group → send card → wait for user action"

**❌ DO NOT use this skill for:**
- Direct user interaction (just send a message directly)
- Scheduling recurring tasks → Use `/schedule` skill instead
- One-time code changes → Use `/deep-task` skill instead

## Core Concepts

### Three-State Lifecycle

```
┌─────────────┐     Group created      ┌─────────────┐
│   pending   │ ──────────────────────>│   active    │
│  Awaiting   │                        │  Awaiting   │
│  group chat │                        │  user reply │
└─────────────┘                        └──────┬──────┘
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               │               ▼
                        ┌──────────┐          │         ┌──────────┐
                        │  expired │<─────────┘         │  expired │
                        │ Timed out│                    │ Replied  │
                        └──────────┘                    └──────────┘
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | Session created, awaiting group chat creation | Session file written |
| `active` | Group chat created, awaiting user response | Schedule creates group + sends card |
| `expired` | Session ended | User responded OR timed out |

### Session File Format

Sessions are stored as JSON files in `workspace/temporary-sessions/`.

**Filename**: `{session-id}.json` (e.g., `pr-123.json`, `offline-deploy.json`)

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "createdAt": "2026-03-10T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-11T10:00:00Z",
  "createGroup": {
    "name": "PR #123: Fix auth bug",
    "members": ["ou_developer", "ou_reviewer1"]
  },
  "message": "# 🔔 PR Review Request\n\n**PR #123**: Fix authentication bug\n\nPlease review and decide.",
  "options": [
    {"value": "merge", "text": "✅ Merge"},
    {"value": "close", "text": "❌ Close"},
    {"value": "wait", "text": "⏳ Wait"}
  ],
  "context": {
    "prNumber": 123,
    "repository": "hs3180/disclaude"
  },
  "response": null
}
```

**Field Reference:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique session identifier (alphanumeric, hyphens, underscores) |
| `status` | Yes | string | `pending`, `active`, or `expired` |
| `chatId` | No | string\|null | Feishu group chat ID (filled when activated) |
| `messageId` | No | string\|null | Card message ID (filled when activated) |
| `createdAt` | Yes | string | ISO 8601 creation timestamp |
| `activatedAt` | No | string\|null | ISO 8601 activation timestamp |
| `expiresAt` | Yes | string | ISO 8601 expiration timestamp |
| `createGroup` | Yes | object | Group creation config: `name` (string) and `members` (string[]) |
| `message` | Yes | string | Card message content (Markdown) |
| `options` | No | array | Interactive card buttons: `[{value, text}]` |
| `context` | No | object | Arbitrary metadata for the caller |
| `response` | No | object\|null | User response: `{selectedValue, responder, repliedAt}` |

---

## Operations

### 1. Create a Session

**Steps:**
1. Determine session purpose and content
2. Choose a unique session ID (e.g., `pr-123`, `ask-{topic}`)
3. Calculate `expiresAt` (default: 24 hours from now)
4. Write JSON file to `workspace/temporary-sessions/{id}.json`
5. Inform the user that a session has been created

**Example** (Agent creates a PR review session):

```bash
# Create session file using jq (safe JSON construction)
SESSION_ID="pr-123"
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
EXPIRES=$(date -u -d '+24 hours' '+%Y-%m-%dT%H:%M:%SZ')

jq -n \
  --arg id "$SESSION_ID" \
  --arg now "$NOW" \
  --arg expires "$EXPIRES" \
  '{
    id: $id,
    status: "pending",
    chatId: null,
    messageId: null,
    createdAt: $now,
    activatedAt: null,
    expiresAt: $expires,
    createGroup: {
      name: "PR #123: Fix auth bug",
      members: ["ou_developer"]
    },
    message: "# 🔔 PR Review Request\n\n**PR #123**: Fix authentication bug\n\nPlease review and decide.",
    options: [
      {"value": "merge", "text": "✅ Merge"},
      {"value": "close", "text": "❌ Close"}
    ],
    context: {
      prNumber: 123,
      repository: "hs3180/disclaude"
    },
    response: null
  }' > "workspace/temporary-sessions/${SESSION_ID}.json"
```

### 2. Check Session Status

Read the session file and check the status:

```bash
SESSION_ID="pr-123"
SESSION_FILE="workspace/temporary-sessions/${SESSION_ID}.json"

if [[ -f "$SESSION_FILE" ]]; then
  STATUS=$(jq -r '.status' "$SESSION_FILE")
  echo "Session status: $STATUS"

  if [[ "$STATUS" == "expired" ]]; then
    RESPONSE=$(jq -r '.response' "$SESSION_FILE")
    if [[ "$RESPONSE" != "null" ]]; then
      SELECTED=$(jq -r '.response.selectedValue' "$SESSION_FILE")
      echo "User selected: $SELECTED"
    else
      echo "Session expired without response (timeout)"
    fi
  fi
fi
```

### 3. List All Sessions

```bash
for f in workspace/temporary-sessions/*.json; do
  if [[ -f "$f" ]]; then
    ID=$(jq -r '.id' "$f")
    STATUS=$(jq -r '.status' "$f")
    EXPIRES=$(jq -r '.expiresAt' "$f")
    echo "- $ID: $STATUS (expires: $EXPIRES)"
  fi
done
```

### 4. Handle User Response

When a user clicks a button on an interactive card, update the session:

```bash
SESSION_ID="pr-123"
SESSION_FILE="workspace/temporary-sessions/${SESSION_ID}.json"

# Only allow responses to active sessions
CURRENT_STATUS=$(jq -r '.status' "$SESSION_FILE")
if [[ "$CURRENT_STATUS" != "active" ]]; then
  echo "ERROR: Cannot respond to session with status: $CURRENT_STATUS"
  exit 1
fi

NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Use jq to atomically update the session (never sed!)
jq \
  --arg now "$NOW" \
  --arg value "$SELECTED_VALUE" \
  --arg responder "$RESPONDER_OPEN_ID" \
  '{
    id, status: "expired", chatId, messageId, createdAt, activatedAt, expiresAt,
    createGroup, message, options, context,
    response: {
      selectedValue: $value,
      responder: $responder,
      repliedAt: $now
    }
  }' "$SESSION_FILE" > "${SESSION_FILE}.tmp" && mv "${SESSION_FILE}.tmp" "$SESSION_FILE"
```

---

## Shell Scripts

The `scripts/` directory contains shell utilities for Feishu API operations:

### `scripts/create-group.sh`

Create a Feishu group chat:

```bash
# Create a group with specific name and members
./skills/temporary-session/scripts/create-group.sh \
  --name "PR #123 Review" \
  --members "ou_user1,ou_user2"

# Output: {"success": true, "chatId": "oc_xxx"}
```

### `scripts/dissolve-group.sh`

Dissolve a Feishu group chat:

```bash
./skills/temporary-session/scripts/dissolve-group.sh \
  --chat-id "oc_xxx"

# Output: {"success": true, "chatId": "oc_xxx"}
```

### `scripts/common.sh`

Shared utilities (sourced by other scripts, not called directly):
- `load_feishu_credentials()` - Load Feishu appId/appSecret from config
- `get_tenant_token()` - Get Feishu tenant_access_token
- `ensure_authenticated()` - Combined credential loading + token fetch
- `validate_chat_id()` - Validate Feishu chatId format (`oc_xxx`)
- `validate_session_id()` - Validate session ID format
- `update_session()` - Atomically update session JSON using jq

---

## Schedule Integration

A schedule (`schedules/temporary-sessions.md`) handles the session lifecycle automatically:

1. **Activate pending sessions**: Creates group chats and sends interactive cards
2. **Expire timed-out sessions**: Marks active sessions as expired when `expiresAt` passes
3. **Clean up old sessions**: Deletes expired sessions older than 24 hours

The schedule runs periodically (every 5 minutes) and processes all session files in `workspace/temporary-sessions/`.

---

## Dependencies

| Dependency | Purpose | Required |
|------------|---------|----------|
| `jq` | JSON parsing and construction | Yes |
| `curl` | HTTP API calls | Yes |
| `yq` | Robust YAML config parsing | Optional (fallback to grep) |

---

## Important Notes

1. **Always use `jq` for JSON operations** — Never use string concatenation or `sed` for JSON
2. **Validate inputs** — Always validate session IDs and chat IDs before use
3. **Atomic writes** — Use write-to-temp-then-rename pattern for session file updates
4. **Use shell scripts for API calls** — Agent cannot import npm packages; use `scripts/*.sh` via Bash tool
5. **State transitions only forward** — pending → active → expired (never backwards)
6. **Only active sessions can receive responses** — Check `status === "active"` before writing response
