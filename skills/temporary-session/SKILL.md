---
name: temporary-session
description: Temporary session lifecycle management - create, query, list, and respond to temporary sessions with group chat integration. Use when user says keywords like "临时会话", "创建会话", "会话管理", "temporary session", "session create". Part of Issue #1547.
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# Temporary Session Manager

Manage temporary session lifecycle: create sessions, send interactive cards to group chats, handle user responses, and auto-expire.

## When to Use This Skill

**Use this skill for:**
- Creating a temporary session (group chat + interactive card) to collect user feedback
- Querying the status of an existing session
- Listing all active/pending sessions
- Handling user responses from session interactive cards

**Do NOT use this skill for:**
- Permanent group chats → Use `create_chat` tool directly
- Scheduled recurring tasks → Use `/schedule` skill
- Simple polls → Use `send_interactive` tool directly

## Session File Format

Sessions are stored as JSON files in `workspace/temporary-sessions/`.

### File Naming: `{id}.json`

- `id` must be URL-safe (alphanumeric, hyphens, underscores)
- Examples: `pr-123.json`, `deploy-review-20260327.json`, `ask-frontend-choices.json`

### Schema

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "createdAt": "2026-03-27T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-27T11:00:00Z",
  "timeoutMinutes": 60,
  "createGroup": {
    "name": "PR #123: Fix auth bug",
    "description": "Review and decide on PR #123",
    "memberIds": []
  },
  "card": {
    "title": "PR Review Request",
    "question": "Please review PR #123 and decide how to proceed.",
    "context": "PR #123 fixes the authentication bug reported in issue #100."
  },
  "options": [
    {"value": "approve", "text": "Approve", "type": "primary"},
    {"value": "request_changes", "text": "Request Changes", "type": "default"},
    {"value": "reject", "text": "Reject", "type": "danger"}
  ],
  "actionPrompts": {
    "approve": "[Session:pr-123] User approved the request.",
    "request_changes": "[Session:pr-123] User requested changes.",
    "reject": "[Session:pr-123] User rejected the request."
  },
  "response": null
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique session identifier (URL-safe) |
| `status` | string | Yes | `pending` / `active` / `expired` |
| `chatId` | string\|null | Yes | Group chat ID (set when activated) |
| `messageId` | string\|null | Yes | Interactive card message ID (set when activated) |
| `createdAt` | ISO 8601 | Yes | Session creation time |
| `activatedAt` | ISO 8601\|null | Yes | Time when session was activated |
| `expiresAt` | ISO 8601 | Yes | Session expiration time |
| `timeoutMinutes` | number | Yes | Default timeout in minutes (for display) |
| `createGroup` | object | Yes | Group creation parameters |
| `createGroup.name` | string | Yes | Group chat name |
| `createGroup.description` | string | No | Group description |
| `createGroup.memberIds` | string[] | Yes | Initial member IDs |
| `card` | object | Yes | Interactive card content |
| `card.title` | string | No | Card title |
| `card.question` | string | Yes | Main question/prompt |
| `card.context` | string | No | Additional context above the question |
| `options` | array | Yes | Button options |
| `options[].value` | string | Yes | Action value (unique) |
| `options[].text` | string | Yes | Button display text |
| `options[].type` | string | No | `primary` / `default` / `danger` |
| `actionPrompts` | object | Yes | Action prompt templates |
| `actionPrompts.{value}` | string | Yes | Prompt for each option value |
| `response` | object\|null | Yes | User response (filled when expired) |

### Response Object (when session expires)

```json
{
  "selectedValue": "approve",
  "responder": "ou_user_xxx",
  "repliedAt": "2026-03-27T10:30:00Z"
}
```

---

## Operations

### Create Session

**Input**: Session configuration (group, card, options, timeout)

**Steps**:
1. Validate the session ID (URL-safe, no collisions)
2. Build the session JSON object
3. Write to `workspace/temporary-sessions/{id}.json`
4. Report success

**Bash commands**:
```bash
# Check for existing session
ls workspace/temporary-sessions/{id}.json 2>/dev/null && echo "EXISTS" || echo "OK"

# Write session file
cat > workspace/temporary-sessions/{id}.json << 'SESSION_EOF'
{session_json}
SESSION_EOF
```

### List Sessions

**Input**: Optional filter by status

**Bash commands**:
```bash
# List all sessions
ls workspace/temporary-sessions/*.json 2>/dev/null | while read f; do
  status=$(jq -r '.status' "$f")
  id=$(jq -r '.id' "$f")
  echo "$status $id"
done

# List by status (e.g., pending)
for f in workspace/temporary-sessions/*.json; do
  [ "$(jq -r '.status' "$f")" = "pending" ] && echo "$f"
done
```

### Query Session

**Input**: Session ID

**Bash commands**:
```bash
# Read session
cat workspace/temporary-sessions/{id}.json | jq .

# Check if expired
expiresAt=$(jq -r '.expiresAt' workspace/temporary-sessions/{id}.json)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
[ "$expiresAt" \< "$now" ] && echo "EXPIRED" || echo "VALID"
```

### Handle Response

**Input**: Session ID, selected value, responder info

This is typically triggered by an action prompt from the interactive card.

**Steps**:
1. Read the session file
2. Verify status is `active`
3. Update `response` field
4. Set `status` to `expired`
5. Write back to file

**Bash commands**:
```bash
# Update session response
jq '.status = "expired" | .response = {"selectedValue": "{value}", "responder": "{responder}", "repliedAt": "{timestamp}"}' \
  workspace/temporary-sessions/{id}.json > /tmp/session_update.json \
  && mv /tmp/session_update.json workspace/temporary-sessions/{id}.json
```

---

## Session Lifecycle

```
                  create_chat + send_interactive
pending ───────────────────────────────────────► active
                                                  │
                                    ┌─────────────┼─────────────┐
                                    ▼                           ▼
                              user response               timeout
                              (card click)             (schedule check)
                                    │                           │
                                    ▼                           ▼
                                 expired ◄──────────────────expired
                                    │
                                    ▼
                              dissolve_chat
                              (schedule cleanup)
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | Waiting for group creation | Caller creates session file |
| `active` | Group created, awaiting response | Schedule activates session |
| `expired` | Session ended | User responded OR timed out |

---

## Integration with Schedule

The `schedules/temporary-sessions.md` schedule handles the lifecycle:

1. **Activation**: Scans `pending` sessions → calls `create_chat` + `send_interactive` → updates to `active`
2. **Expiration check**: Scans `active` sessions past `expiresAt` → updates to `expired` with timeout marker
3. **Cleanup**: Scans `expired` sessions older than 24h → calls `dissolve_chat` → deletes session file

**Important**: This skill handles session file I/O and querying. The schedule handles the automated lifecycle transitions.

---

## Action Prompt Format

When creating action prompts for interactive card buttons, include the session ID for traceability:

```
[Session:{id}] {description of what user chose}
```

Example:
```
"approve": "[Session:pr-123] User approved PR #123. Execute merge after CI passes."
```

This format allows the receiving agent to:
1. Identify which session triggered the action
2. Read the session file for full context
3. Execute the appropriate response handler

---

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Error Handling

| Error | Action |
|-------|--------|
| Session ID already exists | Return error, suggest different ID |
| Invalid session ID | Reject (must be URL-safe) |
| Session file not found | Return "not found" error |
| Session not in expected state | Return current status, suggest correct operation |
| `jq` not available | Fall back to `cat` + manual JSON parsing |

---

## Checklist

- [ ] Session ID is URL-safe and unique
- [ ] All required fields are present
- [ ] `expiresAt` is a valid ISO 8601 timestamp
- [ ] `actionPrompts` has an entry for each option value
- [ ] Session file written to `workspace/temporary-sessions/{id}.json`
- [ ] Action prompts follow `[Session:{id}]` format
