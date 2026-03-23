---
name: temporary-session
description: Temporary session management specialist - creates and manages short-lived group discussions for specific tasks like PR reviews, code discussions, or collaborative sessions. NOT for persistent groups or scheduled meetings. Keywords: "临时会话", "创建讨论组", "temporary session", "group discussion", "讨论组".
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Temporary Session Management Skill

You are a temporary session management specialist. Your job is to create, manage, and clean up short-lived group discussions for specific purposes.

## When to Use This Skill

**✅ Use this skill for:**
- Creating temporary group discussions for PR reviews
- Setting up collaborative sessions for code discussions
- Managing short-lived task-specific groups
- Any scenario requiring a time-bounded group chat

**❌ DO NOT use this skill for:**
- Creating persistent groups → Use `/create-group` control command
- Managing existing long-term groups → Use `/list-group` control command
- Scheduled recurring meetings → Use `/schedule` skill

## Session Lifecycle

Sessions follow a three-state lifecycle:

```
pending ──→ active ──→ expired
   │            │
   │            ├── response received → expired
   │            └── timeout → expired
   └── cancelled → (file deleted)
```

| State | Description | Duration |
|-------|-------------|----------|
| `pending` | Session file created, waiting for group creation | Until next schedule run |
| `active` | Group created, card sent, waiting for response | Until timeout or response |
| `expired` | Session completed or timed out, group to be dissolved | Until cleanup (24h) |

## Session File Format

Sessions are stored as JSON files in `workspace/temporary-sessions/`:

```json
{
  "id": "session-20260324-001",
  "status": "pending",
  "topic": "PR #123 Review",
  "context": "Please review the changes in PR #123...",
  "sourceChatId": "oc_xxx",
  "chatId": null,
  "members": [],
  "createdAt": "2026-03-24T10:00:00.000Z",
  "activatedAt": null,
  "expiredAt": null,
  "timeoutMinutes": 60,
  "response": null
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Session ID (alphanumeric, hyphens, underscores only) |
| `status` | string | ✅ | `pending`, `active`, or `expired` |
| `topic` | string | ✅ | Group name / session topic |
| `context` | string | ✅ | Detailed context for the session |
| `sourceChatId` | string | ✅ | Chat ID where the session was requested |
| `chatId` | string\|null | ✅ | Feishu group chat ID (set when activated) |
| `members` | string[] | ✅ | Member open_ids to add to the group |
| `createdAt` | string | ✅ | ISO-8601 creation timestamp |
| `activatedAt` | string\|null | ✅ | ISO-8601 activation timestamp |
| `expiredAt` | string\|null | ✅ | ISO-8601 expiration timestamp |
| `timeoutMinutes` | number | ✅ | Session timeout in minutes (default: 60) |
| `response` | string\|null | ✅ | User response content (set when completed) |

## Workflow

### 1. Create a Session

When asked to create a temporary session:

```bash
# Ensure the sessions directory exists
mkdir -p workspace/temporary-sessions

# Create the session file
SESSION_ID="session-$(date +%Y%m%d-%H%M%S)"
cat > "workspace/temporary-sessions/${SESSION_ID}.json" << 'SESSION_EOF'
{
  "id": "SESSION_ID_PLACEHOLDER",
  "status": "pending",
  "topic": "Your Topic Here",
  "context": "Detailed context...",
  "sourceChatId": "oc_xxx",
  "chatId": null,
  "members": [],
  "createdAt": "TIMESTAMP_PLACEHOLDER",
  "activatedAt": null,
  "expiredAt": null,
  "timeoutMinutes": 60,
  "response": null
}
SESSION_EOF

# Replace placeholders with actual values
sed -i "s/SESSION_ID_PLACEHOLDER/${SESSION_ID}/g" "workspace/temporary-sessions/${SESSION_ID}.json"
sed -i "s/TIMESTAMP_PLACEHOLDER/$(date -u +%Y-%m-%dT%H:%M:%S.000Z)/g" "workspace/temporary-sessions/${SESSION_ID}.json"
```

### 2. Activate a Session (Group Creation)

Use the `create-group.sh` script to create a Feishu group:

```bash
# Create the group
RESULT=$(bash skills/temporary-session/scripts/create-group.sh \
  --name "讨论组: Your Topic Here" \
  --members "ou_xxx,ou_yyy")

# Parse the result
CHAT_ID=$(echo "$RESULT" | grep -o '"chatId":"[^"]*"' | sed 's/"chatId":"//;s/"//')
SUCCESS=$(echo "$RESULT" | grep -o '"success":true')

if [[ -n "$SUCCESS" ]]; then
  # Update the session file to active status
  # Use jq or sed to update the JSON file
  echo "Group created: ${CHAT_ID}"
else
  ERROR=$(echo "$RESULT" | grep -o '"error":"[^"]*"' | sed 's/"error":"//;s/"//')
  echo "Failed to create group: ${ERROR}"
fi
```

### 3. Send Card to Group

After creating the group, send an interactive card using the channel MCP tools:

```
Use mcp__channel-mcp__send_interactive with:
- chatId: the group chatId from activation
- card content with action buttons
- actionPrompts mapping button values to user actions
```

### 4. Expire a Session

When the session times out or receives a response:

```bash
# Update session status to expired
# Update the expiredAt timestamp

# Dissolve the group
bash skills/temporary-session/scripts/dissolve-group.sh --chat-id "oc_xxx"
```

### 5. Cleanup Old Sessions

Delete session files that have been expired for more than 24 hours:

```bash
# Find and delete expired sessions older than 24 hours
find workspace/temporary-sessions/ -name "*.json" -mtime +1 -delete
```

## Script Reference

### create-group.sh

Creates a Feishu group chat.

```bash
bash skills/temporary-session/scripts/create-group.sh \
  --name "Group Name" \
  [--members "ou_xxx,ou_yyy"] \
  [--config /path/to/disclaude.config.yaml]
```

**Output**: `{"success": true, "chatId": "oc_xxx", "name": "Group Name"}`

**Authentication**: Reads credentials from environment variables (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`) or config file (auto-detected or via `--config`).

### dissolve-group.sh

Dissolves a Feishu group chat.

```bash
bash skills/temporary-session/scripts/dissolve-group.sh \
  --chat-id "oc_xxx" \
  [--config /path/to/disclaude.config.yaml]
```

**Output**: `{"success": true, "chatId": "oc_xxx"}`

## Important Rules

1. **Always validate session IDs**: Session IDs must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. Reject IDs with path traversal characters (`..`, `/`).

2. **Atomic writes**: When updating session files, write to a temp file first, then rename:
   ```bash
   # Write to temp file, then atomically move
   echo "$NEW_CONTENT" > "workspace/temporary-sessions/${SESSION_ID}.json.tmp"
   mv "workspace/temporary-sessions/${SESSION_ID}.json.tmp" "workspace/temporary-sessions/${SESSION_ID}.json"
   ```

3. **No hardcoded chatId**: Always read the sourceChatId from the session file or context, never hardcode environment-specific values.

4. **Graceful degradation**: If group creation fails, send the message to the `sourceChatId` instead.

5. **Timeout enforcement**: Always check `createdAt + timeoutMinutes < now` before activating or processing a session.

6. **Status validation**: Only allow these transitions:
   - `pending` → `active` (group created)
   - `active` → `expired` (response received or timeout)
   - Do NOT allow transitioning from `expired` to any other state

## Error Handling

| Scenario | Action |
|----------|--------|
| Group creation fails | Send error to sourceChatId, keep session as pending |
| Dissolve fails | Log error, mark session as expired anyway (cleanup later) |
| Session file corrupt | Delete the file, log warning |
| Script not found | Report error, suggest checking skill installation |

## DO NOT

- ❌ Create modules in `packages/core/` for session management
- ❌ Use MCP tools for group creation/dissolution (use the scripts)
- ❌ Hardcode environment-specific chat IDs
- ❌ Store sensitive credentials in session files
- ❌ Use YAML format for session files (always JSON)
- ❌ Create Manager classes or complex abstractions
