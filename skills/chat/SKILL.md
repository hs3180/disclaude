---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Chat Manager

Manage temporary chats with a four-state lifecycle: **pending → active → expired / failed**.

Each chat is a JSON file in `workspace/chats/`. Chats are automatically activated (group created) by the companion Schedule (`chats-activation`).

## Single Responsibility

- ✅ Create chat files (pending state)
- ✅ Query chat status
- ✅ List chats with filters
- ✅ Handle user responses (update chat with response data)
- ❌ DO NOT create groups (Schedule handles this via lark-cli)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT send messages to groups (handled by consumer skills)
- ❌ DO NOT execute callbacks or downstream actions

## Invocation Modes

### Mode 1: Agent Invocation (Primary)

Called by other agents/schedules that need to initiate a user interaction:

```
Agent → calls this Skill → creates pending chat file
```

No slash command needed; the agent invokes the Skill directly with chat parameters.

### Mode 2: Direct User Invocation

```
/chat create     — Create a new temporary chat
/chat query {id} — Query chat status
/chat list       — List all chats (optional --status filter)
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Chat File Format

Each chat is a single JSON file in `workspace/chats/`:

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

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique chat identifier (used as filename: `{id}.json`) |
| `status` | Yes | `pending` → `active` → `expired` / `failed` |
| `chatId` | No | Group chat ID (filled by Schedule after group creation) |
| `createdAt` | Yes | ISO 8601 timestamp |
| `activatedAt` | No | ISO 8601 timestamp (filled by Schedule upon activation) |
| `expiresAt` | Yes | ISO 8601 timestamp (when chat should expire) |
| `createGroup` | Yes | Group creation config with `name` and `members` array |
| `context` | No | Arbitrary key-value data for consumer use |
| `response` | No | User response data (filled when user responds in group) |
| `activationAttempts` | No | Retry counter for group creation (managed by Schedule, default: 0) |
| `lastActivationError` | No | Last error message from failed group creation (managed by Schedule) |
| `failedAt` | No | ISO 8601 timestamp (set when marked as `failed` by Schedule) |

### Response Format (after user interaction)

```json
{
  "response": {
    "content": "User's response text",
    "responder": "ou_developer",
    "repliedAt": "2026-03-24T14:30:00Z"
  }
}
```

## Operations

### ⚠️ Chat ID Validation (All Operations)

Every operation that takes a `{id}` parameter **MUST** validate it before use:

```bash
# 1. Reject path traversal and special characters
if ! echo "$id" | grep -qE '^[a-zA-Z0-9._-]+$'; then
  echo "ERROR: Invalid chat ID '$id' — only [a-zA-Z0-9._-] allowed"
  exit 1
fi

# 2. Resolve to canonical path and verify it stays within chat directory
chat_dir=$(cd workspace/chats && pwd)
chat_file=$(realpath -m "${chat_dir}/${id}.json" 2>/dev/null)
if [[ "$chat_file" != "${chat_dir}/"* ]]; then
  echo "ERROR: Path traversal detected for chat ID '$id'"
  exit 1
fi
```

### 1. Create Chat

**Usage**: `/chat create`

Or when an agent/schedule needs to initiate a user interaction:

```bash
# Create chat directory if not exists
mkdir -p workspace/chats

# Write chat file
cat > workspace/chats/{id}.json << 'EOF'
{
  "id": "{id}",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-24T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-25T10:00:00Z",
  "createGroup": {
    "name": "Chat Title",
    "members": ["ou_xxx"]
  },
  "context": {},
  "response": null,
  "activationAttempts": 0,
  "lastActivationError": null,
  "failedAt": null
}
EOF
```

**Validation**:
- `id` must be unique (check existing files first)
- `id` must pass the [Chat ID Validation](#-chat-id-validation-all-operations) check
- `members` must be a non-empty array of valid open IDs
- `expiresAt` must be after `createdAt`

### 2. Query Chat

**Usage**: `/chat query {id}`

Apply [Chat ID Validation](#-chat-id-validation-all-operations), then:

```bash
cat "$chat_file"
```

Display chat status in readable format:

```
📋 Chat: pr-123
> **Status**: 🟡 Active (waiting for response)
> **Created**: 2026-03-24 10:00
> **Expires**: 2026-03-25 10:00
> **Group**: oc_xxx
> **Response**: None
```

### 3. List Chats

**Usage**: `/chat list [--status pending|active|expired]`

```bash
# Validate chat directory (protect against symlink attacks)
chat_dir=$(cd workspace/chats && pwd)
canonical_dir=$(realpath "$chat_dir")
if [[ "$canonical_dir" != "$(pwd)/workspace/chats" ]]; then
  echo "ERROR: Chat directory is a symlink or outside expected path"
  exit 1
fi

# List all chats
ls "$canonical_dir"/*.json 2>/dev/null

# Filter by status (use jq or grep)
for f in "$canonical_dir"/*.json; do
  [ -f "$f" ] || continue
  # Verify file is still within chat directory after symlink resolution
  file_dir=$(dirname "$(realpath "$f")")
  if [[ "$file_dir" != "$canonical_dir" ]]; then
    echo "WARN: Skipping file outside chat directory: $f"
    continue
  fi
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" = "active" ]; then
    echo "$f"
  fi
done
```

Display in table format:

```
📂 Temporary Chats

| ID | Status | Created | Expires | Response |
|----|--------|---------|---------|----------|
| pr-123 | 🟡 Active | 03-24 10:00 | 03-25 10:00 | - |
| deploy-456 | 🔴 Expired | 03-23 08:00 | 03-24 08:00 | approved |
| ask-789 | 🟢 Pending | 03-24 12:00 | 03-25 12:00 | - |
```

### 4. Handle Response

**Triggered by**: User responds in the group chat (natural conversation).

**Steps**:

1. Identify the chat ID from context (e.g., group name, message context)
2. Apply [Chat ID Validation](#-chat-id-validation-all-operations)
3. Read the chat file
4. Verify status is `active` (not already expired)
5. Update the chat:

```bash
# Update chat with response using jq (atomic write)
tmpfile=$(mktemp "${chat_file}.XXXXXX")
jq --arg msg "{user_message}" \
    --arg responder "{senderOpenId}" \
    --arg ts "{currentTimestamp}" \
    '.response = {
       "content": $msg,
       "responder": $responder,
       "repliedAt": $ts
     }' "$chat_file" > "$tmpfile" \
  && mv "$tmpfile" "$chat_file"
```

**Note**: After updating the chat, the **consumer** (PR Scanner, offline questioner, etc.) is responsible for polling the chat file and taking downstream action. This skill does NOT execute callbacks.

## Lifecycle States

```
┌─────────────┐     Schedule activates     ┌─────────────┐
│   pending   │ ──────────────────────────>│   active    │
│  等待创建   │     (group created)         │  等待响应   │
└──────┬──────┘                            └──────┬──────┘
       │                                          │
       │  重试 ≥ 5 次             ┌───────────────┼───────────────┐
       │  (members 无效等)        ▼               │               ▼
       │                    ┌──────────┐          │         ┌──────────┐
       └───────────────────>│  failed  │          │         │  expired │
                            │ 创建失败 │          │         │ 用户已响应│
                            └──────────┘          │         └──────────┘
                                                  │               ▲
                                                  ▼               │
                                            ┌──────────┐          │
                                            │  expired │──────────┘
                                            │ 超时未响应│
                                            └──────────┘
```

| Status | Meaning | Trigger | Who Sets |
|--------|---------|---------|----------|
| `pending` | Waiting for group creation | Chat file created | **This Skill** |
| `active` | Group created, waiting for response | Schedule completes activation | **`chats-activation` Schedule** |
| `failed` | Group creation failed after max retries | Invalid members, API error, etc. | **`chats-activation` Schedule** |
| `expired` | Chat ended | User responded OR timeout | **Consumer** (response) / **`chat-timeout` Skill** (timeout) |

## Consumer Usage Pattern

Consumers (PR Scanner, offline questions, etc.) use this pattern:

```
1. Consumer calls this Skill → creates pending chat file
2. Schedule detects pending → creates group via lark-cli → sets active
   (or marks as failed after 5 retries if members are invalid)
3. Consumer detects chat is active (polls chat file) → sends message to group
4. User responds in group → consumer/skill updates chat file with response
5. chat-timeout Skill detects timeout → marks as expired, dissolves group
6. Consumer polls chat file → finds response → takes downstream action
```

## Chat Directory

```
workspace/chats/
├── pr-123.json              # PR review chat
├── offline-deploy-456.json  # Offline question chat
└── ask-review-789.json      # Agent ask_user chat
```

## DO NOT

- ❌ Create or dissolve groups (Schedule creates, `chat-timeout` skill dissolves)
- ❌ Send messages to groups (consumer skill's responsibility)
- ❌ Execute downstream actions based on responses (consumer's responsibility)
- ❌ Modify chats created by other processes
- ❌ Create chats without a valid `expiresAt`
- ❌ Use YAML format (always JSON)
- ❌ Delete chat files manually

## Error Handling

| Scenario | Action |
|----------|--------|
| Chat file not found | Report "Chat {id} not found" |
| Chat already expired | Report "Chat {id} already expired, cannot update" |
| Chat status is `failed` | Report "Chat {id} failed to activate: {lastActivationError}" |
| Invalid JSON in chat file | Report error, do not overwrite |
| Duplicate `id` | Report "Chat {id} already exists" |
| Invalid chat ID (path traversal) | Report "Invalid chat ID" and reject immediately |
| `jq` not available | Use `node -e` as fallback |

## Example: PR Review Chat

### Agent Creates Chat

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
  "context": {
    "prNumber": 123,
    "repository": "hs3180/disclaude"
  },
  "response": null,
  "activationAttempts": 0,
  "lastActivationError": null,
  "failedAt": null
}
```

### Schedule Activates (automatic)

`chats-activation` Schedule reads the pending chat, creates group via `lark-cli`, updates status to `active`.

### User Responds

User replies in the group naturally (types text). Consumer or this skill updates the chat file with the response.

### PR Scanner Polls

PR Scanner reads `pr-123.json`, finds `response` with user's decision, executes `gh pr merge 123`.
