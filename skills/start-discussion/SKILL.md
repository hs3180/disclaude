---
name: start-discussion
description: Start a focused discussion with specific users in a new Feishu group. Creates a group via lark-cli, sends discussion context via MCP, and returns immediately (non-blocking). Use when you discover a topic that needs deep discussion, want to ask users offline questions, or need feedback without blocking your current work. Keywords: "start discussion", "发起讨论", "讨论群", "离线提问", "start-discussion".
allowed-tools: [Bash, send_text, send_interactive, Read, Glob, Grep]
---

# Start Discussion

Create a focused discussion group with specific users, send the discussion context, and return immediately — **non-blocking**.

This skill follows the **lark-cli architecture**: group operations via Bash → lark-cli, messaging via MCP tools. No IPC, no MCP group tools.

## Single Responsibility

- ✅ Create a new Feishu discussion group via lark-cli
- ✅ Send initial discussion context message via MCP
- ✅ Return immediately with the chat ID
- ❌ DO NOT wait for user responses (consumer's responsibility)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT track discussion lifecycle (use chat files separately if needed)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Workflow

### Step 1: Prepare Discussion Parameters

Gather the following information:

| Parameter | Required | Description |
|-----------|----------|-------------|
| Discussion Name | Yes | Concise group name (max 64 chars, auto-truncated) |
| Members | Yes | One or more Feishu open IDs (`ou_xxxxx` format) |
| Topic | Yes | Clear description of what to discuss |
| Context | Yes | Background information for the ChatAgent |
| Questions | No | Specific questions for the discussion |

### Step 2: Create the Discussion Group

Run the TypeScript helper script to create the group:

```bash
DISCUSSION_NAME="Discussion Topic Summary" \
DISCUSSION_MEMBERS="ou_user1,ou_user2" \
npx tsx skills/start-discussion/create-group.ts
```

**Parse the output** to extract the chat ID. The script outputs:
```
OK: {"chatId":"oc_xxxxx","name":"Discussion Topic Summary"}
```

Extract the `chatId` value from the `OK:` line — this is the Feishu group chat ID.

**Error handling**: If the script exits with code 1, report the error to the user and stop.

### Step 3: Send Discussion Context

Use MCP tools to send the discussion context to the newly created group. Format the message as a clear briefing for the ChatAgent:

**Using `send_text`** (for simple text context):
```
send_text with chat_id=<chatId from Step 2>
```

**Using `send_interactive`** (for formatted card context — recommended):
```
send_interactive with chat_id=<chatId from Step 2> and a card containing:
- Header: Discussion topic
- Body: Context and questions
```

**Context message format** (recommended card structure):
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "📋 讨论主题: {topic}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**背景信息:**\n{context}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**讨论要点:**\n{questions or discussion points}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "_请在群内回复你的观点和建议_"}
  ]
}
```

### Step 4: Return Immediately

After sending the context message, report the result and **return immediately**:

```
✅ 讨论群已创建

> **群名**: {group name}
> **Chat ID**: {chatId}
> **成员**: {member count} 人
> **状态**: ChatAgent 已启动，等待讨论响应
```

**DO NOT** wait for user responses. The ChatAgent in the new group will handle the discussion autonomously.

## Architecture

```
Agent (current) → Bash → lark-cli → Feishu API (create group)
                → MCP → send_text/send_interactive (send context)
                → returns immediately

Primary Node detects new group → spawns ChatAgent → ChatAgent handles discussion
```

Group operations use **lark-cli** directly — NOT through IPC Channel or MCP group tools. This follows the same pattern as:
- `chats-activation.ts` (group creation)
- `chat-timeout.ts` (group dissolution)
- `rename-group.ts` (group renaming)

## When to Use

1. **Offline questions**: Agent discovers a topic that needs user input but shouldn't block current work
2. **Deep discussion**: Complex topic requiring focused conversation with specific stakeholders
3. **Feedback collection**: Ask specific users for their opinion on a decision
4. **Follow-up investigation**: Spawn a sub-discussion for a side topic discovered during work

## DO NOT

- ❌ Wait for user responses (return immediately after sending context)
- ❌ Use MCP group tools for creating/dissolving groups (use lark-cli via Bash)
- ❌ Include too many discussion points in one message (keep it focused)
- ❌ Create groups without a clear discussion topic
- ❌ Create groups with invalid member IDs (must be `ou_xxxxx` format)
- ❌ Send messages to the discussion group after the initial context (the ChatAgent handles this)

## Error Handling

| Scenario | Action |
|----------|--------|
| lark-cli not found | Report "lark-cli not installed" and suggest `npm install -g @larksuite/cli` |
| Group creation failed | Report error and suggest retrying |
| Invalid member ID | Report which ID is invalid and ask for correction |
| MCP send failed | Report error; group was created but context not sent |
| Group name too long | Auto-truncated to 64 chars (handled by script) |

## Example: PR Design Discussion

Agent discovers a design decision that needs stakeholder input:

```bash
# Step 1: Create discussion group
DISCUSSION_NAME="API 设计讨论: 认证方案选型" \
DISCUSSION_MEMBERS="ou_developer,ou_architect" \
npx tsx skills/start-discussion/create-group.ts
# Output: OK: {"chatId":"oc_abc123","name":"API 设计讨论: 认证方案选型"}

# Step 2: Send context via MCP send_interactive
# Card with design options and trade-offs

# Step 3: Return immediately
# ✅ 讨论群已创建 (oc_abc123), ChatAgent 已启动
```

## Related

- **Lifecycle**: `chat-timeout` skill handles group dissolution
- **Chat tracking**: `chat` skill manages temporary chat files (optional integration)
- **Discussion focus**: #1228 (future — keep discussions on track)
- **Smart ending**: #1229 (future — intelligent session ending)
