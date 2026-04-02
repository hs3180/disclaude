---
name: start-discussion
description: Non-blocking discussion initiator - creates group chats and sends context via lark-cli and MCP tools without blocking current work. Use when agent identifies topics needing user discussion (repeated commands, implicit complaints, costly work decisions, or explicit user requests). Keywords: "start discussion", "发起讨论", "离线提问", "offline message", "create chat", "非阻塞", "讨论".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Start Discussion — Non-Blocking Discussion Initiator

You are a non-blocking discussion initiator. Your job is to create a group chat (or use an existing one), send discussion context to ChatAgent, and **return immediately** without waiting for a response.

## When to Use

**Use this skill when:**
- Agent identifies a topic needing deep user discussion
- User explicitly requests to start a discussion on a topic
- Repeated user commands suggest confusion that needs clarification
- A costly work decision needs user approval before proceeding
- Agent needs to leave a message without blocking current work

**DO NOT use this skill when:**
- A simple text reply suffices → Reply directly
- The discussion is already happening in the current chat → Continue in current chat

## Architecture

```
Agent (this Skill)
  ├── Bash → lark-cli <command>     (group operations: create, dissolve, members)
  └── MCP  → send_text / send_interactive  (message sending)
```

**Key principle**: Group lifecycle operations go through `lark-cli` via Bash. Message sending goes through MCP tools.

## Context Variables

When invoked, you will receive context in the system message:

- **Chat ID**: The Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: The message ID (from "**Message ID:** xxx")
- **Sender Open ID**: The sender's open ID (from "**Sender Open ID:** xxx", if available)

## Workflow

### Step 1: Determine Chat Target

Decide whether to:
- **Use existing chat**: If a `chatId` is provided or the discussion can happen in the current chat
- **Create new chat**: If a fresh discussion space is needed

### Step 2: Create Chat (if needed)

Use `lark-cli` via Bash to create a new group chat:

```bash
# Create a new group chat (bot identity)
lark-cli im +chat-create --name "<discussion-topic>" --users "<open_id_1>,<open_id_2>"
```

**Example**:
```bash
lark-cli im +chat-create --name "是否应该自动化代码格式化？" --users "ou_abc123"
```

The command returns a `chat_id` — save this for the next step.

### Step 3: Send Discussion Context

Send the discussion context using MCP tools:

- Use `send_text` for simple text context
- Use `send_interactive` for rich card context with action buttons

**With send_text**:
```
Call send_text with:
- chatId: <the chat_id from Step 2, or the provided chatId>
- text: <the discussion context/prompt>
```

**With send_interactive** (recommended for richer context):
```
Call send_interactive with:
- chatId: <the chat_id from Step 2, or the provided chatId>
- content: <interactive card with discussion context>
```

### Step 4: Return Immediately

**CRITICAL**: After sending the context, return immediately. Do NOT wait for a response. The ChatAgent in the target chat will handle the discussion asynchronously.

Report the result to the current user:

```
Discussion started in chat <chat_id>.
Topic: <topic summary>
Context has been sent. The ChatAgent will discuss with users asynchronously.
```

## lark-cli Command Reference

### Create Group Chat

```bash
lark-cli im +chat-create --name "<topic>" --users "<open_ids>"
```

- `--name`: Chat name (discussion topic)
- `--users`: Comma-separated list of user open IDs to add

### Dissolve Group Chat

```bash
lark-cli api DELETE "/open-apis/im/v1/chats/<chat_id>"
```

### Add Group Members

```bash
lark-cli im chat.members create \
  --params '{"chat_id":"<chat_id>","member_id_type":"open_id","succeed_type":1}' \
  --data '{"id_list":["<open_id_1>","<open_id_2>"]}' --as user
```

### Query Group Members

```bash
lark-cli im chat.members get --params '{"chat_id":"<chat_id>","member_id_type":"open_id"}'
```

## Prerequisites

Before using this skill, verify `lark-cli` is available:

```bash
which lark-cli || npx @larksuite/cli --version
```

If `lark-cli` is not installed, guide the user to install it:

```bash
npm install -g @larksuite/cli
```

## Error Handling

| Scenario | Action |
|----------|--------|
| `lark-cli` not found | Inform user to install: `npm install -g @larksuite/cli` |
| Chat creation fails | Retry once, then fall back to sending in current chat |
| MCP send fails | Log the error and inform the current user |
| Permission denied | Check `lark-cli` authentication configuration |

## Non-Blocking Principle

**This skill MUST be non-blocking.** The workflow is:

1. Create chat / identify target chat
2. Send context
3. Return immediately

The actual discussion happens asynchronously when users reply in the target chat. The ChatAgent in that chat handles the conversation.

## DO NOT

- Wait for user response after sending context
- Create complex state management or tracking
- Build infrastructure beyond what `lark-cli` and MCP tools provide
- Implement group lifecycle management in MCP layer
