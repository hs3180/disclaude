---
name: temporary-session
description: Temporary session management - create, query, and manage time-limited interactive sessions with users. Use when you need to initiate a question to a user, wait for their response in a dedicated group chat, and take action based on their choice. Keywords: 临时会话, 提问, 等待回复, 群组讨论, session, poll, question.
---

# Temporary Session Management

Create time-limited interactive sessions that automatically create group chats, present questions via interactive cards, and clean up after expiration.

## Session Lifecycle

```
pending → active → expired → (cleanup after 24h)
           ↓          ↓
        failed     orphaned
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | Waiting for group creation | Session file created |
| `active` | Group created, awaiting user response | Schedule activates the session |
| `expired` | Session ended (user responded OR timed out) | User action or timeout |
| `failed` | Activation failed after max retries | Retry limit exceeded |
| `orphaned` | Group exists but session expired, dissolve failed | `dissolve_chat` failure |

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
  "response": null,
  "retryCount": 0,
  "lastError": null
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique session ID (used as filename: `{id}.json`). Format: `[a-zA-Z0-9][a-zA-Z0-9_-]*` |
| `status` | string | Yes | `pending`, `active`, `expired`, `failed`, or `orphaned` |
| `chatId` | string/null | Yes | Populated after group creation |
| `createdAt` | ISO 8601 | Yes | Session creation time |
| `activatedAt` | ISO 8601/null | Yes | Time when group was created |
| `expiresAt` | ISO 8601 | Yes | When the session should expire |
| `createGroup.name` | string | Yes | Name for the group chat |
| `createGroup.memberIds` | string[] | Yes | Initial member IDs (empty = bot only). **Note**: Issue #1547 spec uses `members`; `memberIds` matches MCP `create_chat` tool's parameter name |
| `message` | string | Yes | Question/content to display in the interactive card |
| `options` | array | Yes | Button options for the interactive card |
| `context` | object | No | Arbitrary metadata for downstream processing |
| `actionPrompts` | object | Yes | Maps option values to action prompt instructions |
| `response` | object/null | Yes | Populated when user responds: `{value, respondedAt}` |
| `retryCount` | number | Yes | Number of activation attempts (default: 0) |
| `lastError` | string/null | Yes | Last activation error message (default: null) |

## Operations

### Create a Session

**Step 1**: Ensure the session directory exists:

```bash
mkdir -p workspace/temporary-sessions
```

**Step 2**: Check for ID uniqueness to prevent overwriting existing sessions:

```bash
SESSION_ID="pr-123-review"
if [ -f "workspace/temporary-sessions/${SESSION_ID}.json" ]; then
  echo "❌ Session '${SESSION_ID}' already exists"
  exit 1
fi
```

**Step 3**: Create the session file using atomic write:

```bash
SESSION_ID="pr-123-review"
EXPIRES_AT=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TARGET="workspace/temporary-sessions/${SESSION_ID}.json"

(
  flock -x 200
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
      response: null,
      retryCount: 0,
      lastError: null
    }' > "${TARGET}.tmp" && mv "${TARGET}.tmp" "${TARGET}"
  echo '{"event":"created","sessionId":"'"$SESSION_ID"'"}'
) 200>"workspace/temporary-sessions/.lock"
```

### List Sessions

```bash
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  jq -r '.id + " [" + .status + "] expires: " + .expiresAt' "$f" 2>/dev/null || echo "⚠️ Invalid JSON: $f"
done
```

### Read a Session

```bash
jq '.' "workspace/temporary-sessions/{session-id}.json"
```

### Update Session Status

Always use `jq` + atomic write + `flock` for JSON updates:

```bash
SESSION_ID="pr-123-review"
TARGET="workspace/temporary-sessions/${SESSION_ID}.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Activate a session (after group creation)
(
  flock -x 200
  jq --arg chatId "$CHAT_ID" --arg now "$NOW" \
    '.status = "active" | .chatId = $chatId | .activatedAt = $now | .retryCount = 0 | .lastError = null' \
    "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo '{"event":"activated","sessionId":"'"$SESSION_ID"'","chatId":"'"$CHAT_ID"'"}'
) 200>"workspace/temporary-sessions/.lock"

# Record a user response
(
  flock -x 200
  jq --arg value "$ACTION_VALUE" --arg now "$NOW" \
    '.status = "expired" | .response = {value: $value, respondedAt: $now}' \
    "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo '{"event":"responded","sessionId":"'"$SESSION_ID"'","value":"'"$ACTION_VALUE"'"}'
) 200>"workspace/temporary-sessions/.lock"

# Mark activation failure (increment retry count)
(
  flock -x 200
  jq --arg error "$ERROR_MSG" --arg now "$NOW" \
    '.retryCount = (.retryCount // 0) + 1 | .lastError = $error |
     if .retryCount >= 10 then .status = "failed" else . end' \
    "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo '{"event":"activation_failed","sessionId":"'"$SESSION_ID"'","retryCount":'$(jq '.retryCount' "$TARGET")'}'
) 200>"workspace/temporary-sessions/.lock"
```

### Handle User Response

When a user clicks a button in the interactive card, the action prompt contains the session ID. Follow these steps:

1. **Extract session ID** from the action prompt. The format is `(session: {id})` embedded in the prompt text.

   **Exact extraction pattern** (use `grep -oP`):
   ```bash
   # Extract session ID from action prompt text
   SESSION_ID=$(echo "$ACTION_PROMPT" | grep -oP 'session: \K[a-zA-Z0-9][a-zA-Z0-9_-]*')
   ```

   Example:
   ```
   Input:  "[用户操作] 用户批准了 PR #123 (session: pr-123-review)。请执行合并操作。"
   Output: "pr-123-review"
   ```

2. **Read the session file** to understand the context:
   ```bash
   jq '.' "workspace/temporary-sessions/${SESSION_ID}.json"
   ```

3. **Execute the action** described in the action prompt.

4. **Update the session** to `expired` with the response (see "Record a user response" above).

## Important Rules

1. **Always use `jq`** for JSON manipulation — never use `sed`, `awk`, or string concatenation
2. **Always use atomic write** (write to `.tmp` then `mv`) to prevent file corruption
3. **Always use `flock`** on `.lock` file for concurrent write safety
4. **Session ID format**: `[a-zA-Z0-9][a-zA-Z0-9_-]*` (alphanumeric start, then alphanumeric/hyphen/underscore)
5. **Action prompts must include session ID** in the format `(session: {id})` so responses can be routed correctly
6. **Never modify sessions from other processes** while the Schedule is running

## Dependencies

- **`jq`** (required) — JSON processing
- **`flock`** (required) — File locking for concurrent access safety (part of `util-linux`)
- **`date -d`** (required) — Relative date calculation. **Note**: This is GNU coreutils syntax. On macOS, use `gdate` from Homebrew's `coreutils` package instead.

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
