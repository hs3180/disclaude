---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: [Bash, Read, Glob, Grep, send_text, send_interactive]
---

# Chat Skill — Temporary Chat Lifecycle Management

Manage temporary Feishu group chats for non-blocking agent→user discussions. Agents use this skill to create discussion groups, send context, and track chat lifecycle — without blocking the primary workflow.

## Single Responsibility

- ✅ Create temporary Feishu group chats via lark-cli
- ✅ Dissolve expired/complete group chats via lark-cli
- ✅ Query and list tracked temporary chats
- ✅ Send context and messages to discussion groups via MCP
- ✅ Register chats with ChatStore for lifecycle management
- ❌ DO NOT use IPC Channel for group operations
- ❌ DO NOT create new MCP tools — use existing `send_text`/`send_interactive`
- ❌ DO NOT block the primary workflow while waiting for discussion results

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Sub-commands

### `/chat create` — Create a Temporary Discussion Group

Create a new Feishu group for discussion with specified users.

#### When to Create a Chat

Agents should create a temporary chat when they detect:
1. A topic needing deeper discussion (repeated user instructions, multi-step corrections, implicit complaints)
2. A blocking question that shouldn't halt the current task
3. Feedback collection from specific users
4. PR review or code discussion needing focused conversation

#### Workflow

```
1. Determine discussion topic and participants
2. Run create-chat.ts to create the group
3. Send context message via send_text or send_interactive
4. Return immediately — do NOT wait for responses
```

#### Step 1: Create Group

```bash
CHAT_NAME="讨论主题" \
CHAT_USERS="ou_user1,ou_user2" \
CHAT_TTL_MINUTES=1440 \
CHAT_CREATOR="oc_original_chat_id" \
CHAT_CONTEXT='{"topic":"...","reason":"..."}' \
npx tsx skills/chat/create-chat.ts
```

**Environment Variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `CHAT_NAME` | Yes | Group name (max 64 chars, auto-truncated) |
| `CHAT_USERS` | No | Comma-separated open_id list of members |
| `CHAT_TTL_MINUTES` | No | Minutes until expiry (default: 1440 = 24h) |
| `CHAT_CREATOR` | No | Original chat ID for tracking |
| `CHAT_CONTEXT` | No | JSON context data to attach |
| `CHAT_SKIP_LARK` | No | Set to '1' for dry-run testing |

**Output (JSON on stdout):**
```json
{"ok": true, "chatId": "oc_new_chat_id", "name": "讨论主题"}
{"ok": false, "error": "error description"}
```

#### Step 2: Send Context Message

After successful creation, send the discussion context to the new group:

Use `send_text` or `send_interactive` MCP tool with:
- `chatId`: The chat ID from create-chat output
- `text`/`content`: Discussion context, including the topic, background, and what input is needed

**Example context card:**
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "📋 讨论邀请", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "**主题**: <topic>\n**发起原因**: <reason>\n\n<background context>"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "查看详情", "tag": "plain_text"}, "value": "view_detail", "type": "primary"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<new_chat_id>"
}
```

#### Step 3: Report Back

Report the creation result to the original chat (optional):

Use `send_text` with the original chat ID to confirm the discussion group was created.

---

### `/chat dissolve` — Dissolve a Temporary Group

Dissolve a Feishu group and clean up its tracking record.

```bash
DISSOLVE_CHAT_ID="oc_chat_id" \
npx tsx skills/chat/dissolve-chat.ts
```

**Environment Variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `DISSOLVE_CHAT_ID` | Yes | Chat ID to dissolve (oc_xxx format) |
| `DISSOLVE_SKIP_LARK` | No | Set to '1' for dry-run testing |

**Output (JSON on stdout):**
```json
{"ok": true, "chatId": "oc_chat_id"}
{"ok": false, "error": "error description"}
```

---

### `/chat query` — Query Chat Status

Look up a tracked temporary chat's status.

Read the ChatStore record from `workspace/schedules/.temp-chats/`:

```bash
# Read the chat record file
cat "workspace/schedules/.temp-chats/oc_chat_id.json"
```

**Fields:**
- `chatId`: The Feishu chat ID
- `createdAt`: When it was created (ISO timestamp)
- `expiresAt`: When it expires (ISO timestamp)
- `creatorChatId`: The originating chat ID
- `context`: Attached context data
- `response`: User response data (if any)
- `triggerMode`: Response trigger mode

---

### `/chat list` — List All Tracked Chats

List all tracked temporary chats.

```bash
# List all temp chat records
ls workspace/schedules/.temp-chats/*.json 2>/dev/null
```

For each file, read and display:
- Chat ID
- Group name (from context)
- Created time
- Expiry time
- Response status

---

## Architecture

Group operations use **lark-cli** to call Feishu API directly:

```
Agent → Bash → lark-cli <command> → Feishu API
```

Message sending uses **MCP tools** (`send_text` / `send_interactive`):

```
Agent → MCP send_text/send_interactive → IPC → Primary Node → Feishu API
```

Chat lifecycle tracking uses **ChatStore** (file-based):

```
workspace/schedules/.temp-chats/{chatId}.json
```

The existing `chat-timeout` skill handles automatic expiry detection and group dissolution.

---

## Name Guidelines

Group names should be:
- Concise (max 64 chars, auto-truncated)
- Descriptive of the discussion topic
- Use the format: `[topic]讨论` or `[Agent] → [topic]`
- Examples: "需求分析讨论", "PR #123 Review", "性能优化方案", "用户反馈收集"

---

## Safety Guarantees

- **Input validation**: Chat IDs must match `oc_xxx`, names must be non-empty
- **Name truncation**: Names exceeding 64 chars are truncated at character boundaries (CJK-safe)
- **ChatStore registration**: All created chats are tracked for lifecycle management
- **No IPC for group ops**: Direct lark-cli call, no worker→primary message passing
- **Non-blocking**: Create chat → send context → return immediately

---

## DO NOT

- ❌ Create new MCP tools for group operations
- ❌ Use IPC Channel for create/dissolve group
- ❌ Block the primary workflow waiting for discussion responses
- ❌ Create groups without registering in ChatStore
- ❌ Dissolve groups without cleaning up ChatStore records
- ❌ Send messages to groups that haven't been created yet
- ❌ Skip ChatStore registration (breaks chat-timeout lifecycle management)
