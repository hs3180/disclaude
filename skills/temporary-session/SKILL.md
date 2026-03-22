---
name: temporary-session
description: Create and manage temporary interactive sessions - ask user questions, wait for responses in group chats. Use when you need to create a session, check session status, or handle session responses. Keywords: "创建会话", "临时会话", "session", "等待回复", "临时讨论".
allowed-tools: [Bash, Read, Write, mcp__channel-mcp__send_text, mcp__channel-mcp__send_interactive, mcp__channel-mcp__send_card]
user-invocable: true
---

# Temporary Session Skill

You are a temporary session management specialist. Your job is to create and manage temporary interactive sessions that ask users questions and collect responses.

## Single Responsibility

- ✅ Create new temporary sessions (write session files)
- ✅ Activate sessions (send messages to group chats)
- ✅ Record user responses
- ✅ Check session status and handle timeouts
- ✅ Clean up expired sessions
- ❌ DO NOT modify core package code
- ❌ DO NOT manage MCP or IPC directly

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 Skill: temporary-session             │
│  - Create session files                              │
│  - Activate sessions (via MCP send_interactive)       │
│  - Record responses from card clicks                  │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌──────────────┐         ┌──────────────┐
│  Session Files│         │  MCP Tools   │
│  (JSON/YAML) │         │  (Messaging) │
└──────────────┘         └──────────────┘
```

## Session Lifecycle

```
pending ──(activate)──> active ──(response/timeout)──> expired
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `pending` | Created, waiting for activation | Caller creates session file |
| `active` | Group created, message sent, awaiting user response | Skill activates session |
| `expired` | Session ended (response received or timeout) | User responded OR timeout |

## Usage

### Create a New Session

Use the `create-session` subcommand:

```bash
/temporary-session create-session --id "pr-123" --expires-in 60m --message "Please review PR #123" --options "merge:✅ 合并,close:❌ 关闭,wait:⏳ 等待"
```

Or describe what you need and the agent will create the session for you.

### Check Session Status

```bash
/temporary-session status
/temporary-session status --id "pr-123"
```

### List All Sessions

```bash
/temporary-session list
/temporary-session list --status active
```

### Clean Up Expired Sessions

```bash
/temporary-session cleanup
```

## Session File Format

Sessions are stored as JSON files in `workspace/temporary-sessions/`:

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "expiresAt": "2026-03-11T10:00:00Z",
  "createGroup": {
    "name": "PR #123 讨论",
    "members": ["ou_developer"]
  },
  "message": "Please review this PR",
  "options": [
    { "value": "merge", "text": "✅ 合并" },
    { "value": "close", "text": "❌ 关闭" }
  ],
  "context": { "prNumber": 123 },
  "response": null,
  "expiry": null,
  "createdAt": "2026-03-10T09:00:00Z",
  "updatedAt": "2026-03-10T09:00:00Z"
}
```

## Workflow

### 1. Create Session

When asked to create a temporary session:

1. Parse the user's request to extract:
   - Session ID (auto-generate if not provided: `{type}-{timestamp}`)
   - Message content
   - Options (buttons for user to choose)
   - Expiration time (default: 60 minutes)
   - Target chat (if provided; otherwise use current chat)
   - Group creation config (if needed)

2. Write the session file:

```bash
# Determine workspace directory
WORKSPACE_DIR="${WORKSPACE_DIR:-$(pwd)/workspace}"
SESSION_DIR="$WORKSPACE_DIR/temporary-sessions"
mkdir -p "$SESSION_DIR"

# Write session file
cat > "$SESSION_DIR/{id}.json" << 'EOF'
{
  "id": "{id}",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "expiresAt": "{expiresAt}",
  "createGroup": { "name": "{groupName}", "members": {members} },
  "message": "{message}",
  "options": {options},
  "context": {context},
  "response": null,
  "expiry": null,
  "createdAt": "{now}",
  "updatedAt": "{now}"
}
EOF
```

3. If the session has a `createGroup` config and needs immediate activation:
   - Use `mcp__channel-mcp__send_interactive` to send the interactive card to the **existing** chat
   - **Important**: Do NOT attempt to create group chats via API. Group creation is handled by the schedule or by existing groups.
   - Update the session file with `status: "active"`, `chatId`, and `messageId`

### 2. Send Interactive Card (Activation)

Use the `send_interactive` MCP tool to send the interactive card:

```json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": {
      "title": { "content": "📋 临时会话: {sessionTitle}", "tag": "plain_text" },
      "template": "blue"
    },
    "elements": [
      { "tag": "markdown", "content": "{message}" },
      { "tag": "hr" },
      { "tag": "action", "actions": [
        { "tag": "button", "text": { "content": "{option1.text}", "tag": "plain_text" }, "value": "{option1.value}", "type": "primary" },
        { "tag": "button", "text": { "content": "{option2.text}", "tag": "plain_text" }, "value": "{option2.value}" },
        { "tag": "button", "text": { "content": "{option3.text}", "tag": "plain_text" }, "value": "{option3.value}", "type": "danger" }
      ]},
      { "tag": "note", "elements": [
        { "tag": "plain_text", "content": "⏰ 会话将在 {expirationTime} 后过期" }
      ]}
    ]
  },
  "actionPrompts": {
    "{option1.value}": "[用户操作] 用户选择了「{option1.text}」。会话ID: {id}。请记录响应并处理后续逻辑。",
    "{option2.value}": "[用户操作] 用户选择了「{option2.text}」。会话ID: {id}。请记录响应并处理后续逻辑。",
    "{option3.value}": "[用户操作] 用户选择了「{option3.text}」。会话ID: {id}。请记录响应并处理后续逻辑。"
  },
  "chatId": "{targetChatId}"
}
```

After the card is sent successfully, update the session file:

```bash
# Update session status to active
# Use a JSON tool or inline script to update status, chatId, messageId
```

### 3. Handle User Response

When a user clicks a button on the interactive card:

1. The action prompt is automatically generated and sent to the agent
2. Read the session file to find the session by ID
3. Update the session file with the response:

```json
{
  "status": "expired",
  "response": {
    "selectedValue": "{value}",
    "selectedText": "{text}",
    "responder": "{openId}",
    "repliedAt": "{timestamp}"
  },
  "expiry": {
    "reason": "response",
    "expiredAt": "{timestamp}"
  },
  "updatedAt": "{timestamp}"
}
```

4. Process the response based on the session's `context` and `selectedValue`

### 4. Check Session Status

```bash
# List all sessions
ls -la "$WORKSPACE_DIR/temporary-sessions/"

# Read specific session
cat "$WORKSPACE_DIR/temporary-sessions/{id}.json"
```

### 5. Handle Timeouts

The schedule (schedules/temporary-sessions.md) handles timeout checking automatically.
If you detect an expired session, update its status and notify the caller if needed.

## State Management

### File Naming Convention

| Session Type | ID Pattern | Example |
|-------------|-----------|---------|
| PR Review | `pr-{number}` | `pr-123` |
| Deployment | `deploy-{timestamp}` | `deploy-1678456789` |
| General | `ask-{timestamp}` | `ask-1678456789` |

### Timeout Defaults

| Context | Default Timeout |
|----------|----------------|
| PR Review | 60 minutes |
| Deployment | 30 minutes |
| General Question | 24 hours |
| Custom | User-specified |

## Error Handling

| Error | Resolution |
|-------|-----------|
| Session file not found | Inform user, suggest checking ID |
| Session already expired | Show the recorded response or timeout info |
| Failed to send card | Retry once, then mark session as cancelled |
| Chat not accessible | Fall back to a configured default chat |

## Security Notes

- Session files may contain sensitive context data
- Do not expose session contents to unauthorized users
- Clean up expired sessions regularly (schedule handles this)
- Do not store API keys or tokens in session context

## DO NOT

- ❌ Attempt to create Feishu group chats via API directly
- ❌ Modify MCP server or IPC configuration
- ❌ Access the Feishu API client directly
- ❌ Store credentials in session files
- ❌ Create sessions without an expiration time
