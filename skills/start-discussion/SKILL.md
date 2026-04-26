---
name: start-discussion
description: Start a non-blocking discussion with users via temporary group chat. Use when the Agent identifies a topic needing user input — repeated corrections, complaints, costly decisions, or any situation requiring human feedback without blocking current work. Keywords: "发起讨论", "离线提问", "start discussion", "offline question", "ask user", "discuss".
allowed-tools: [send_text, send_interactive, Read, Write, Glob, Grep, Bash]
---

# Start Discussion

Non-blocking discussion initiation — create a temporary group chat, deliver context, and return immediately.

## When to Start a Discussion

Start a discussion when you identify any of these signals:

| Signal | Example |
|--------|---------|
| **Repeated corrections** | User corrects your output 3+ times on the same topic |
| **Implicit complaints** | "你又搞错了", "怎么还是不行" |
| **Costly decisions** | About to spend significant resources (time, compute, API calls) |
| **Ambiguous requirements** | Multiple valid interpretations, no clear winner |
| **Proactive improvement** | "Users keep asking for X" — a pattern worth discussing |

## How It Works

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  This Skill  │────▶│  chats-activation │────▶│  chat-timeout    │
│  creates     │     │  Schedule creates │     │  Skill expires   │
│  pending chat│     │  group via        │     │  & dissolves     │
│              │     │  lark-cli         │     │  on timeout      │
└─────────────┘     └─────────────────┘     └──────────────────┘
```

1. **You** create a pending chat file (quick, non-blocking)
2. **`chats-activation` Schedule** picks it up, creates the group via `lark-cli`, marks as `active`
3. **You** (or the invoking Agent) poll for `active` status, then send context to the group via MCP tools
4. **User** responds in the group naturally
5. **`chat-timeout` Skill** dissolves the group if no response within the expiry window

## Step-by-Step Guide

### Step 1: Create the Discussion Chat

```bash
CHAT_ID="discuss-<unique-id>" \
CHAT_EXPIRES_AT="<ISO 8601 UTC, e.g. 2026-04-27T10:00:00Z>" \
CHAT_GROUP_NAME="<descriptive name, max 64 chars>" \
CHAT_MEMBERS='["ou_xxx"]' \
CHAT_CONTEXT='{
  "topic": "<discussion topic>",
  "background": "<why this discussion is needed>",
  "question": "<specific question to ask>",
  "followUpAction": "<what to do after getting response>"
}' \
npx tsx skills/chat/create.ts
```

**Environment Variables**:

| Variable | Required | Description |
|----------|----------|-------------|
| `CHAT_ID` | Yes | Unique ID (e.g. `discuss-taste-prefs-001`). Must match `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$` |
| `CHAT_EXPIRES_AT` | Yes | UTC Z-suffix ISO 8601 (e.g. `2026-04-27T10:00:00Z`). Recommended: 24-48 hours from now |
| `CHAT_GROUP_NAME` | Yes | Group display name (max 64 chars). Only `a-zA-Z0-9_\-.#:/ ()` allowed. E.g. `"Discuss: expense prefs"` |
| `CHAT_MEMBERS` | Yes | JSON array of `ou_xxxxx` open IDs of people to include |
| `CHAT_CONTEXT` | No | JSON object with discussion details (max 4096 bytes) |

**Example — Full invocation**:

```bash
CHAT_ID="discuss-expense-categories" \
CHAT_EXPIRES_AT="2026-04-28T10:00:00Z" \
CHAT_GROUP_NAME="Discuss: expense category prefs" \
CHAT_MEMBERS='["ou_abc123", "ou_def456"]' \
CHAT_CONTEXT='{
  "topic": "expense category preferences",
  "background": "user corrected classification 3 times - current logic may not match expectations",
  "question": "How should expenses be classified? By type (food/transport/entertainment) or by scenario (work/life/social)?",
  "followUpAction": "update classification Skill based on user feedback",
  "sourceChatId": "oc_current_chat_id",
  "triggerCount": 3
}' \
npx tsx skills/chat/create.ts
```

### Step 2: Return Immediately (Non-Blocking)

After creating the chat file, **return to the user** with a brief confirmation:

```
✅ 已创建讨论群「<group_name>」，等待激活。
讨论话题：<topic>
参与人：<member count> 人
过期时间：<expiresAt>

我会在收到回复后继续处理。
```

**Do NOT**:
- ❌ Wait for group creation (handled by `chats-activation` schedule)
- ❌ Block the current conversation
- ❌ Poll for status in the same turn

### Step 3: Check Status Later (On Next Invocation)

When invoked again (by schedule, user message, or follow-up), check if the discussion chat is active:

```bash
CHAT_ID="discuss-expense-categories" \
npx tsx skills/chat/query.ts
```

**If status is `active` and no message sent yet**:
Send the discussion context to the group using MCP tools (`send_text` or `send_interactive`):

```
Use send_text or send_interactive MCP tool to send the discussion context to the group:
- chatId: <the chatId from the query result>
- Message should include: topic, background, specific question, and call-to-action
```

**If status is `active` and has a response**:
Process the response and take follow-up action as defined in `CHAT_CONTEXT.followUpAction`.

**If status is `pending`**:
Group not yet created. Report to user and suggest waiting.

**If status is `expired`**:
Discussion timed out without response. Inform the user.

**If status is `failed`**:
Group creation failed. Report error and suggest retry.

## Context Field Best Practices

The `CHAT_CONTEXT` JSON object should include these recommended fields:

| Field | Purpose | Example |
|-------|---------|---------|
| `topic` | Short topic name | "支出分类偏好" |
| `background` | Why this discussion is needed | "用户3次修正分类结果" |
| `question` | Specific question to ask | "您偏好按大类还是场景分类？" |
| `followUpAction` | What to do with the response | "更新分类逻辑 Skill" |
| `sourceChatId` | Original chat where the need was detected | "oc_xxx" |
| `triggerCount` | How many times the signal was detected | 3 |
| `suggestedOptions` | Pre-defined options for the user to choose from | `["A", "B", "C"]` |

## Discussion Message Template

When sending the initial message to the group (after activation), use this template:

```
📋 讨论话题: {topic}

📌 背景: {background}

❓ 问题: {question}

{suggestedOptions, if any}
请选择或直接回复您的想法。

⏰ 本讨论将于 {expiresAt} 自动关闭。
```

## Integration with Other Skills

| Skill/Component | Relationship |
|----------------|--------------|
| `chat` skill | Underlying chat file management (create/query/list/response) |
| `chats-activation` schedule | Activates pending chats (creates groups via lark-cli) |
| `chat-timeout` skill | Expires and dissolves inactive groups |
| `daily-chat-review` skill | Can review discussion patterns over time |

## DO NOT

- ❌ Create groups directly via `lark-cli` (let `chats-activation` handle it)
- ❌ Dissolve groups (let `chat-timeout` handle it)
- ❌ Block the current conversation waiting for a response
- ❌ Send messages to the group before it's activated (status must be `active`)
- ❌ Use MCP tools for group operations (create/dissolve/members)
- ❌ Create chats without a clear `expiresAt` (must be UTC Z-suffix)
- ❌ Store sensitive data in `CHAT_CONTEXT` (it's stored as plain JSON on disk)

## Error Handling

| Scenario | Action |
|----------|--------|
| Chat ID already exists | Choose a different ID (add timestamp suffix) |
| Invalid member ID format | Verify `ou_xxxxx` format, ask user for correct ID |
| `expiresAt` in the past | Use a future timestamp (recommended: 24-48 hours) |
| Chat stuck in `pending` | Wait for next `chats-activation` run (every 1 minute) |
| Chat status is `failed` | Report error details from `lastActivationError`, suggest retry |
| Group dissolved before response | Inform user, offer to create a new discussion |
