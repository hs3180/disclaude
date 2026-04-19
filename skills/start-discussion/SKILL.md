---
name: start-discussion
description: Initiate non-blocking offline discussions with users in group chats. Use when the Agent identifies a topic needing user input (repeated commands, implicit complaints, costly work decisions) and wants to start a discussion without blocking current work. Also invoked by agents/schedules that need user feedback. Keywords: 离线提问, 发起讨论, offline question, start discussion, 用户讨论, ask user.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Start Discussion — Non-blocking Offline Question

Initiate a discussion with users in a new or existing Feishu group chat. The Agent creates a group, sends context, and **returns immediately** — the discussion proceeds asynchronously.

## Architecture

```
Agent → this Skill → lark-cli (group ops) + chat/create.ts (lifecycle) + MCP tools (messages)
```

| Operation | Tool | Example |
|-----------|------|---------|
| Create group | `lark-cli` via Bash | `lark-cli im +chat-create --name "topic" --users "ou_xxx"` |
| Track lifecycle | `chat/create.ts` via Bash | `CHAT_ID=... npx tsx skills/chat/create.ts` |
| Activate chat | `chat/activate.ts` via Bash | `CHAT_ID=... CHAT_CHAT_ID=oc_xxx npx tsx skills/chat/activate.ts` |
| Send context | MCP `send_text` / `send_interactive` | Via Agent's MCP tools |
| Dissolve group | `lark-cli` via Bash (handled by `chat-timeout`) | `lark-cli api DELETE /open-apis/im/v1/chats/oc_xxx` |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Workflow

### Step 1: Prepare Discussion Context

Package the discussion topic and relevant context:

```
- Topic: What needs to be discussed
- Background: Why this discussion is needed
- Questions: Specific questions for the user
- Options: Optional predefined choices (if applicable)
```

### Step 2: Create Chat File (Lifecycle Tracking)

Create a pending chat file for lifecycle management:

```bash
# Generate a unique chat ID (use topic + timestamp for uniqueness)
CHAT_ID="discussion-{topic-slug}-{timestamp}" \
CHAT_EXPIRES_AT="{24 hours from now in UTC Z-suffix}" \
CHAT_GROUP_NAME="{Discussion topic}" \
CHAT_MEMBERS='["{sender_open_id}"]' \
CHAT_CONTEXT='{"topic": "...", "source": "start-discussion"}' \
CHAT_TRIGGER_MODE='always' \
npx tsx skills/chat/create.ts
```

**Validation rules** (built into `create.ts`):
- `CHAT_ID`: `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$` (no leading dots)
- `CHAT_EXPIRES_AT`: UTC Z-suffix ISO 8601 (e.g. `2026-04-20T10:00:00Z`)
- `CHAT_MEMBERS`: Non-empty JSON array of `ou_xxxxx` open IDs
- `CHAT_GROUP_NAME`: Safe characters, max 64 chars

### Step 3: Create Group via lark-cli

Create the Feishu group immediately using the official CLI:

```bash
lark-cli im +chat-create \
  --name "{group name}" \
  --users "{member1},{member2}"
```

**Parse the response** to extract the group chat ID:

```json
{"data": {"chat_id": "oc_xxxxx"}}
```

If the response contains `chat_id`, the group was created successfully.

**Error handling**:
- If `lark-cli` fails, log the error. The `chats-activation` schedule will retry later.
- Do **NOT** block or retry immediately — return the error and let the user decide.

### Step 4: Activate Chat (Link Group to Chat File)

Update the chat file to `active` status with the real chatId:

```bash
CHAT_ID="{chat-id}" \
CHAT_CHAT_ID="oc_{group_chat_id}" \
npx tsx skills/chat/activate.ts
```

This is idempotent — safe to call multiple times.

### Step 5: Send Discussion Context

Send the discussion context to the newly created group using MCP tools:

**For simple text context**:
```
Use send_text MCP tool with:
  - chatId: The Feishu group chat ID from Step 3
  - text: The formatted discussion context
```

**For interactive context with options**:
```
Use send_interactive MCP tool with an interactive card:
  - Header: Discussion topic
  - Body: Background and questions
  - Actions: Optional buttons for predefined responses
```

### Step 6: Return Immediately

After sending the context, **return immediately**. Do NOT:
- Wait for user response
- Poll the chat file for changes
- Block the current workflow

The discussion proceeds asynchronously:
- User responds in the group naturally
- Consumer polls `chat/query.ts` to check for responses
- `chat-timeout` skill handles expiration and group dissolution

## Using an Existing Group

If you want to use an existing group instead of creating a new one:

1. Skip Step 3 (no `lark-cli` group creation needed)
2. In Step 4, activate with the existing `oc_xxx` chat ID
3. Continue with Step 5 (send context to existing group)

## Response Handling

To check for user responses later (non-blocking):

```bash
CHAT_ID="{chat-id}" npx tsx skills/chat/query.ts
```

The consumer (your main Agent, PR Scanner, etc.) is responsible for polling and processing responses.

## Dissolving Groups

Group dissolution is handled by the `chat-timeout` skill when the chat expires. Do NOT dissolve groups manually unless explicitly requested.

If manual dissolution is needed:

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chat_id}
```

## lark-cli Reference

| Operation | Command |
|-----------|---------|
| Create group | `lark-cli im +chat-create --name "name" --users "ou_a,ou_b"` |
| Dissolve group | `lark-cli api DELETE /open-apis/im/v1/chats/oc_xxx` |
| Add members | `lark-cli im chat.members create --params '{"chat_id":"oc_xxx","member_id_type":"open_id","succeed_type":1}' --data '{"id_list":["ou_a"]}' --as user` |
| Query members | `lark-cli im chat.members get --params '{"chat_id":"oc_xxx","member_id_type":"open_id"}'` |

## Output Format

After completing all steps, report the result:

```
✅ Discussion started successfully

📋 Chat: {chat-id}
👥 Group: oc_{group_chat_id}
⏰ Expires: {expires_at}
📝 Topic: {discussion topic}

The discussion is now active. Users can respond in the group.
```

**On failure**:
```
❌ Failed to start discussion

Reason: {error message}
Chat file: {chat-id} (status: pending — will be retried by chats-activation schedule)
```

## DO NOT

- ❌ Block waiting for user response
- ❌ Create groups without a chat file (breaks lifecycle tracking)
- ❌ Dissolve groups manually (handled by `chat-timeout`)
- ❌ Retry `lark-cli` failures immediately (schedule will retry)
- ❌ Send messages to the original chat about the discussion (send to the new group only)
- ❌ Skip the chat file creation (needed for expiry tracking and group cleanup)
- ❌ Use MCP `create_chat` / `dissolve_chat` tools (deprecated — use `lark-cli` instead)

## Example: Full Flow

```bash
# Step 1: Identify topic (Agent logic)
# Agent notices user repeated a command 3 times
TOPIC="自动化代码格式化配置"
CONTEXT="在最近的任务中，发现代码格式化存在不一致的情况。用户已多次手动修正格式问题。"

# Step 2: Create chat file
CHAT_ID="discussion-auto-format-1776575400" \
CHAT_EXPIRES_AT="2026-04-20T10:00:00Z" \
CHAT_GROUP_NAME="讨论: 代码格式化自动化" \
CHAT_MEMBERS='["ou_developer"]' \
CHAT_CONTEXT='{"topic":"auto-format","source":"start-discussion"}' \
CHAT_TRIGGER_MODE='always' \
npx tsx skills/chat/create.ts

# Step 3: Create group
lark-cli im +chat-create --name "讨论: 代码格式化自动化" --users "ou_developer"

# Step 4: Activate (using chat_id from Step 3 response)
CHAT_ID="discussion-auto-format-1776575400" \
CHAT_CHAT_ID="oc_new_group_id" \
npx tsx skills/chat/activate.ts

# Step 5: Send context via MCP send_interactive
# (Agent sends interactive card to oc_new_group_id)

# Step 6: Return immediately — done!
```
