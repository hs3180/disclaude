---
name: temporary-session
description: Temporary session management - create, query, and manage time-limited interactive sessions with users. Use when you need to initiate a question to a user, wait for their response in a dedicated group chat, and take action based on their choice. Keywords: 临时会话, 提问, 等待回复, 群组讨论, session, poll, question.
---

# Temporary Session Management

Create time-limited interactive sessions that automatically create group chats, present questions via interactive cards, and clean up after expiration.

## Session Lifecycle

```
pending → active → expired
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | Waiting for group creation | Session file created |
| `active` | Group created, awaiting user response | Schedule activates the session |
| `expired` | Session ended (user responded OR timed out) | User action or timeout |

## Session File Format

Sessions are stored as JSON files in `workspace/temporary-sessions/`:

```json
{
  "id": "pr-123-review",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-25T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-25T11:00:00Z",
  "createGroup": {
    "name": "PR #123 Review",
    "memberIds": []
  },
  "message": "Please review this PR and choose an action.",
  "options": [
    {"value": "approve", "text": "Approve", "type": "primary"},
    {"value": "request_changes", "text": "Request Changes"},
    {"value": "skip", "text": "Skip"}
  ],
  "context": {
    "prNumber": 123,
    "source": "pr-scanner"
  },
  "actionPrompts": {
    "approve": "[用户操作] 用户批准了 PR #123 (session: pr-123-review)。请执行合并操作。",
    "request_changes": "[用户操作] 用户请求修改 PR #123 (session: pr-123-review)。请询问具体修改内容。",
    "skip": "[用户操作] 用户跳过了 PR #123 (session: pr-123-review)。标记为已处理。"
  },
  "response": null
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique session ID (used as filename: `{id}.json`) |
| `status` | string | Yes | `pending`, `active`, or `expired` |
| `chatId` | string/null | Yes | Populated after group creation |
| `createdAt` | ISO 8601 | Yes | Session creation time |
| `activatedAt` | ISO 8601/null | Yes | Time when group was created |
| `expiresAt` | ISO 8601 | Yes | When the session should expire |
| `createGroup.name` | string | Yes | Name for the group chat |
| `createGroup.memberIds` | string[] | Yes | Initial member IDs (empty = bot only) |
| `message` | string | Yes | Question/content to display in the interactive card |
| `options` | array | Yes | Button options for the interactive card |
| `context` | object | No | Arbitrary metadata for downstream processing |
| `actionPrompts` | object | Yes | Maps option values to action prompt instructions |
| `response` | object/null | Yes | Populated when user responds |

## Operations

### Create a Session

Create a JSON file in `workspace/temporary-sessions/`:

```bash
SESSION_ID="pr-123-review"
EXPIRES_AT=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg id "$SESSION_ID" \
  --arg createdAt "$CREATED_AT" \
  --arg expiresAt "$EXPIRES_AT" \
  '{
    id: $id,
    status: "pending",
    chatId: null,
    createdAt: $createdAt,
    activatedAt: null,
    expiresAt: $expiresAt,
    createGroup: { name: "PR #123 Review", memberIds: [] },
    message: "Please review this PR and choose an action.",
    options: [
      {value: "approve", text: "Approve", type: "primary"},
      {value: "request_changes", text: "Request Changes"},
      {value: "skip", text: "Skip"}
    ],
    context: {prNumber: 123, source: "pr-scanner"},
    actionPrompts: {
      approve: "[用户操作] 用户批准了 PR #123 (session: pr-123-review)。请执行合并操作。",
      request_changes: "[用户操作] 用户请求修改 PR #123 (session: pr-123-review)。请询问具体修改内容。",
      skip: "[用户操作] 用户跳过了 PR #123 (session: pr-123-review)。标记为已处理。"
    },
    response: null
  }' > "workspace/temporary-sessions/${SESSION_ID}.json"
```

### List Sessions

```bash
# List all sessions with their status
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  jq -r '"\(.id) [\(.status)] expires: \(.expiresAt)"' "$f"
done
```

### Read a Session

```bash
jq '.' "workspace/temporary-sessions/{session-id}.json"
```

### Update Session Status

Always use `jq` for JSON updates:

```bash
# Activate a session (after group creation)
jq --arg chatId "$CHAT_ID" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.status = "active" | .chatId = $chatId | .activatedAt = $now' \
  "workspace/temporary-sessions/${SESSION_ID}.json" > "workspace/temporary-sessions/${SESSION_ID}.json.tmp" \
  && mv "workspace/temporary-sessions/${SESSION_ID}.json.tmp" "workspace/temporary-sessions/${SESSION_ID}.json"

# Expire a session
jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.status = "expired"' \
  "workspace/temporary-sessions/${SESSION_ID}.json" > "workspace/temporary-sessions/${SESSION_ID}.json.tmp" \
  && mv "workspace/temporary-sessions/${SESSION_ID}.json.tmp" "workspace/temporary-sessions/${SESSION_ID}.json"

# Record a user response
jq --arg value "$ACTION_VALUE" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.status = "expired" | .response = {value: $value, respondedAt: $now}' \
  "workspace/temporary-sessions/${SESSION_ID}.json" > "workspace/temporary-sessions/${SESSION_ID}.json.tmp" \
  && mv "workspace/temporary-sessions/${SESSION_ID}.json.tmp" "workspace/temporary-sessions/${SESSION_ID}.json"
```

### Handle User Response

When a user clicks a button in the interactive card, the action prompt contains the session ID. Follow these steps:

1. **Extract session ID** from the action prompt (format: `session: {id}`)
2. **Read the session file** to understand the context
3. **Execute the action** described in the action prompt
4. **Update the session** to `expired` with the response

## Important Rules

1. **Always use `jq`** for JSON manipulation — never use `sed` or string concatenation
2. **Always use atomic write** (write to `.tmp` then `mv`) to prevent corruption
3. **Session ID format**: `[a-zA-Z0-9][a-zA-Z0-9_-]*` (safe for filenames)
4. **Action prompts must include session ID** so responses can be routed correctly
5. **Never modify sessions from other processes** while the Schedule is running

## MCP Tools Used

| Tool | Purpose | When |
|------|---------|------|
| `create_chat` | Create group chat for session | Schedule activation |
| `send_interactive` | Send interactive card with options | Schedule activation |
| `dissolve_chat` | Dissolve group after expiration | Schedule cleanup |

## Related

- Issue #1391: Parent issue (temporary session management system)
- Issue #1546: MCP tools (`create_chat` / `dissolve_chat`)
- Issue #1547: Schedule integration (this file)
