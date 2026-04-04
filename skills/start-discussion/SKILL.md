---
name: start-discussion
description: Non-blocking offline discussion initiator. Creates a discussion group via the chat lifecycle system (lark-cli) and sends context to ChatAgent, then returns immediately without blocking the caller. Use when the agent identifies a topic worth discussing with users, such as repeated instructions, conflicting requirements, user complaints, or questions about costly work. Also supports sending context to an existing group. Keywords: "离线提问", "发起讨论", "start discussion", "offline question", "留言", "讨论", "非阻塞交互".
allowed-tools: [Bash, Read, Glob, Grep]
---

# Start Discussion

Initiate a non-blocking discussion with users. The caller (main agent) is **not blocked** — this skill runs as a forked sub-agent that handles the full discussion setup.

## Single Responsibility

- Create discussion chats via the chat lifecycle system (`scripts/chat/create.sh`)
- Send discussion context to the active group via MCP tools
- Return immediately after context is delivered
- **DO NOT** execute downstream actions based on discussion results (caller's responsibility)
- **DO NOT** manage discussion focus (handled by #1228)
- **DO NOT** handle intelligent session ending (handled by #1229)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Architecture

```
Caller Agent (not blocked)
    |
    +---> This Skill (forked sub-agent)
              |
              +---> Chat System (scripts/chat/create.sh)  --> pending chat file
              |                                                    |
              +---> Poll chat file until active <------------------+
              |         (chats-activation schedule creates group via lark-cli)
              |
              +---> Send context via MCP (send_text / send_interactive)
              |
              +---> Return
```

Group creation uses **lark-cli** (official `@larksuite/cli`) through the existing `chats-activation` schedule. This skill does **not** call lark-cli directly for group management.

## Two Modes

### Mode 1: Create New Discussion Group

Use when no existing group is available. The chat lifecycle system handles group creation, retry logic, and timeout.

#### Step 1: Create Chat File

```bash
CHAT_ID="<unique-id>" \
CHAT_EXPIRES_AT="<utc-timestamp>" \
CHAT_GROUP_NAME="<discussion-topic>" \
CHAT_MEMBERS='["ou_xxx"]' \
CHAT_CONTEXT='{"topic": "...", "materials": "...", "sourceChatId": "..."}' \
bash scripts/chat/create.sh
```

**Chat ID conventions** (use descriptive prefixes):
- `discuss-<topic-slug>` — General discussions
- `ask-<topic-slug>` — Questions for users
- `review-<pr-number>` — PR reviews

**Expires**: Set to a reasonable window (e.g., 2-24 hours from now). Format: UTC ISO 8601 with Z suffix (e.g., `2026-04-04T22:00:00Z`).

**Members**: At least one user `ou_xxx` open ID. Use the **Sender Open ID** from context if no specific user is targeted.

**Context**: Include structured data for the ChatAgent:
```json
{
  "topic": "The main discussion topic",
  "background": "Why this discussion is needed",
  "materials": "Relevant file paths, PR numbers, or data",
  "sourceChatId": "oc_xxx (original chat where topic was identified)",
  "suggestedActions": ["Create a skill", "Adjust configuration", "Investigate further"]
}
```

#### Step 2: Poll for Activation

After creating the chat file, poll until the `chats-activation` schedule creates the group:

```bash
CHAT_ID="<unique-id>" bash scripts/chat/query.sh
```

**Polling strategy**:
- Check every 10 seconds
- Timeout after 3 minutes (the activation schedule runs every minute)
- If the chat status becomes `active`, proceed to Step 3
- If the chat status becomes `failed`, report the error and stop

```
Status check loop:
  pending  → keep polling (schedule hasn't processed yet)
  active   → proceed to send context
  failed   → report error, stop
  expired  → report timeout, stop
```

#### Step 3: Send Context to Group

Once the chat is active, read the `chatId` from the chat file and send the discussion context.

Use the MCP `send_text` or `send_interactive` tool to send a structured message to the group:

**For simple context** (use `send_text`):
- Chat ID: the `chatId` from the active chat file
- Text: A clear description of the discussion topic, background, and what input is needed from the user

**For rich context** (use `send_interactive`):
- Chat ID: the `chatId` from the active chat file
- Card content: Include topic, background, materials, and suggested actions in a structured card format

**Context message format**:
```
## Discussion: {topic}

**Background**: {why this discussion was initiated}

**Key Points**:
- Point 1
- Point 2

**Materials**: {file paths, PR links, etc.}

Please share your thoughts on this topic.
```

#### Step 4: Return

After sending the context, report success to the caller and return. The Pilot agent in the new group will automatically handle the ongoing discussion.

### Mode 2: Use Existing Group

Use when the caller provides a specific group chat ID to send context to.

```bash
# Verify the group exists and is accessible
CHAT_ID="<existing-chat-id>" bash scripts/chat/query.sh
```

Then send context directly via MCP `send_text` or `send_interactive` to the provided chat ID.

## Group Dissolution

Groups are dissolved automatically by the `chat-timeout` skill when the chat expires. No manual dissolution is needed.

For manual dissolution (e.g., during testing), use lark-cli directly:

```bash
# Dissolve a group by chat_id
lark-cli api DELETE "/open-apis/im/v1/chats/{chat_id}"
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Chat creation fails (validation error) | Report specific error to caller |
| Activation timeout (>3 min) | Report timeout, suggest checking lark-cli configuration |
| Activation fails (max retries) | Report `lastActivationError` from chat file |
| MCP send fails | Report error, suggest retrying or checking chat permissions |
| Chat already exists (duplicate ID) | Report duplicate, use existing chat |
| `lark-cli` not installed | Report: run `npm install -g @larksuite/cli` |

## DO NOT

- Call `lark-cli` directly for group creation (the activation schedule handles this)
- Use deprecated `create_chat` / `dissolve_chat` MCP tools
- Block the caller while waiting for activation (poll with timeout)
- Execute downstream actions based on discussion results
- Send messages to groups not managed by the chat system
- Create chats without a valid `expiresAt` (must be UTC Z-suffix)

## Example

### Agent Discovers a Repeated User Complaint

```bash
# Step 1: Create chat file
CHAT_ID="discuss-code-format" \
CHAT_EXPIRES_AT="2026-04-05T10:00:00Z" \
CHAT_GROUP_NAME="讨论: 是否应该自动化代码格式化？" \
CHAT_MEMBERS='["ou_developer"]' \
CHAT_CONTEXT='{
  "topic": "是否应该自动化代码格式化？",
  "background": "用户在过去3天内多次要求统一代码格式",
  "materials": ["src/formatter.ts", "ESLint config"],
  "suggestedActions": ["添加 prettier 配置", "创建 ESLint 规则", "不采取行动"]
}' \
bash scripts/chat/create.sh

# Step 2: Poll until active (check every 10s, timeout 3min)
CHAT_ID="discuss-code-format" bash scripts/chat/query.sh
# ... repeat until status is "active" ...

# Step 3: Send context via MCP
# (use send_text or send_interactive with the chatId from the chat file)

# Step 4: Report success and return
```
