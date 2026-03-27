---
name: temporary-session
description: Temporary session lifecycle management — create session files for async user interactions (group creation, card sending, timeout cleanup). Use when user says keywords like "创建会话", "临时会话", "发起提问", "等待回复", "temporary session", "create session", "async question".
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, create_chat, dissolve_chat, send_interactive, send_text, send_card
---

# Temporary Session Management

Manage temporary sessions for asynchronous user interactions — create a session, wait for user response in a group chat, and handle the lifecycle.

## When to Use This Skill

**Use this skill for:**
- Creating temporary sessions that require user action (approval, review, feedback)
- Handling user responses from interactive cards in temporary group chats
- Checking session status or listing sessions

**Keywords that trigger this skill**: "创建会话", "临时会话", "发起提问", "等待回复", "temporary session", "create session", "async question", "pending session"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Session Lifecycle

```
┌─────────────┐     Schedule activates     ┌─────────────┐
│   pending   │ ──────────────────────────>│   active    │
│  等待创建   │    (create_chat + card)     │  等待响应   │
└─────────────┘                            └──────┬──────┘
                                                  │
                                  ┌───────────────┼───────────────┐
                                  ▼               │               ▼
                            ┌──────────┐          │         ┌──────────┐
                            │  expired │<─────────┘         │  expired │
                            │ 超时未响应│                    │ 用户已响应│
                            └──────────┘                    └──────────┘
```

| State | Meaning | Trigger |
|-------|---------|---------|
| `pending` | Waiting for group creation | Caller creates session file |
| `active` | Group created, waiting for user response | Schedule activates session |
| `expired` | Session ended | User responded OR timed out |

---

## Session File Format

Sessions are stored as JSON files in `temporary-sessions/` directory.

**File naming**: `{id}.json` where `id` is a unique identifier (e.g., `pr-123`, `offline-deploy`)

**Session file structure**:

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-28T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-29T10:00:00Z",
  "createGroup": {
    "name": "PR #123 Review",
    "memberIds": ["ou_user1"]
  },
  "message": {
    "title": "PR Review Request",
    "context": "PR #123: Fix authentication bug\nAuthor: @developer",
    "question": "Please review and decide how to proceed.",
    "options": [
      {"text": "✅ Merge", "value": "merge", "type": "primary"},
      {"text": "🔄 Request Changes", "value": "request_changes", "type": "default"},
      {"text": "❌ Close", "value": "close", "type": "danger"},
      {"text": "⏳ Later", "value": "later", "type": "default"}
    ],
    "actionPrompts": {
      "merge": "[用户操作] 用户批准合并 PR #123。请执行以下步骤：\n1. 检查 CI 状态\n2. 执行 gh pr merge 123 --repo hs3180/disclaude --merge\n3. 报告执行结果",
      "request_changes": "[用户操作] 用户请求修改 PR #123。请询问具体修改内容。",
      "close": "[用户操作] 用户关闭 PR #123。请执行 gh pr close 123。",
      "later": "[用户操作] 用户选择稍后处理 PR #123。"
    }
  },
  "context": {
    "prNumber": 123,
    "repository": "hs3180/disclaude"
  },
  "response": null
}
```

**Field descriptions**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique session identifier |
| `status` | string | ✅ | `pending` / `active` / `expired` |
| `chatId` | string\|null | ✅ | Group chat ID (filled after activation) |
| `createdAt` | string | ✅ | ISO 8601 creation timestamp |
| `activatedAt` | string\|null | ✅ | ISO 8601 activation timestamp |
| `expiresAt` | string | ✅ | ISO 8601 expiration timestamp |
| `createGroup` | object | ✅ | Group creation config (`name`, `memberIds`) |
| `message` | object | ✅ | Interactive card config (see below) |
| `context` | object | ❌ | Arbitrary caller-specific data |
| `response` | object\|null | ✅ | User response (filled after user action) |

**message object**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ❌ | Card title |
| `context` | string | ❌ | Context text above the question |
| `question` | string | ✅ | Main question/content |
| `options` | array | ✅ | Button options (`text`, `value`, `type`) |
| `actionPrompts` | object | ❌ | Custom action prompts per button value |

**response object** (after user responds):

```json
{
  "selectedValue": "merge",
  "responder": "ou_developer",
  "repliedAt": "2026-03-28T14:30:00Z"
}
```

---

## Operations

### Create a Session

When you need to ask a user a question asynchronously:

1. Generate a unique session ID (e.g., based on context: `pr-{number}`, `deploy-{env}`)
2. Set the expiration time (recommended: 24 hours from creation)
3. Write the session file to `temporary-sessions/{id}.json`:

```bash
cat > temporary-sessions/{id}.json << 'EOF'
{
  "id": "{id}",
  "status": "pending",
  "chatId": null,
  "createdAt": "{ISO_NOW}",
  "activatedAt": null,
  "expiresAt": "{ISO_EXPIRES}",
  "createGroup": {
    "name": "{group_name}",
    "memberIds": ["{member_open_id}"]
  },
  "message": {
    "title": "{card_title}",
    "context": "{context_info}",
    "question": "{your_question}",
    "options": [
      {"text": "✅ Option A", "value": "option_a", "type": "primary"},
      {"text": "❌ Option B", "value": "option_b", "type": "danger"}
    ],
    "actionPrompts": {
      "option_a": "[用户操作] 用户选择了 option_a，session ID: {id}",
      "option_b": "[用户操作] 用户选择了 option_b，session ID: {id}"
    }
  },
  "context": {},
  "response": null
}
EOF
```

4. Report to the caller: "✅ Session `{id}` created, waiting for schedule to activate."

### Handle User Response

When you receive a message that matches an action prompt pattern (contains `[用户操作]` and a session ID):

1. Extract the session ID from the message
2. Read the session file: `temporary-sessions/{id}.json`
3. Verify the session is in `active` state
4. Extract the selected value from the action prompt
5. Update the session file:

```bash
# Update session status and response
# Use node or jq to update the JSON file
```

Example update:
```bash
node -e "
const fs = require('fs');
const path = 'temporary-sessions/{id}.json';
const session = JSON.parse(fs.readFileSync(path, 'utf8'));
session.status = 'expired';
session.response = {
  selectedValue: '{selected_value}',
  responder: '{responder_open_id}',
  repliedAt: new Date().toISOString()
};
fs.writeFileSync(path, JSON.stringify(session, null, 2));
"
```

6. Process the response according to the caller's context (e.g., merge PR, deploy, etc.)

### Check Session Status

```bash
# Check a specific session
cat temporary-sessions/{id}.json

# List all sessions with their status
for f in temporary-sessions/*.json; do
  id=$(basename "$f" .json)
  status=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$f','utf8')).status)")
  echo "$id: $status"
done
```

### List Sessions

```bash
# List all sessions grouped by status
echo "=== Pending ==="
ls temporary-sessions/*.json 2>/dev/null | while read f; do
  status=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$f','utf8')).status)")
  [ "$status" = "pending" ] && echo "  $(basename $f)"
done

echo "=== Active ==="
ls temporary-sessions/*.json 2>/dev/null | while read f; do
  status=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$f','utf8')).status)")
  [ "$status" = "active" ] && echo "  $(basename $f)"
done
```

---

## Design Principles

1. **MCP tools for group operations**: Always use `create_chat`, `dissolve_chat`, `send_interactive` MCP tools — never hardcode platform APIs
2. **Bash for file I/O only**: Use bash/node for reading/writing session files
3. **Action prompts include session ID**: Every action prompt must contain the session ID so responses can be routed
4. **Graceful degradation**: If a session file is missing or corrupted, log and skip
5. **Idempotent operations**: The schedule should be safe to run multiple times

---

## Integration with Other Skills

- **pr-scanner** schedule: Can create sessions for PR review discussions
- **code-review** skill: Can create sessions for code review requests
- **deep-task** skill: Can create sessions to ask for user decisions during task execution

---

## Checklist

- [ ] Session file created with valid JSON structure
- [ ] All required fields present (id, status, chatId, createdAt, expiresAt, createGroup, message)
- [ ] `expiresAt` is a valid future ISO 8601 timestamp
- [ ] `message.options` is a non-empty array
- [ ] `actionPrompts` include session ID in each prompt
- [ ] Session file written to `temporary-sessions/{id}.json`

---

## DO NOT

- Create sessions without setting a proper expiration time
- Use platform-specific APIs directly (always use MCP tools)
- Delete session files manually (let the schedule handle cleanup)
- Create sessions with empty options array
- Forget to include session ID in action prompts
