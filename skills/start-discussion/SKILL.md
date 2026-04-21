---
name: start-discussion
description: Start a non-blocking discussion with users in a Feishu group chat. Use when the Agent identifies a topic that needs user input — repeated corrections, implicit complaints, costly decisions, or any scenario requiring human judgment. Keywords: "发起讨论", "讨论群", "离线提问", "start discussion", "ask user", "offline question".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Start Discussion

Start a non-blocking discussion with users by creating a temporary Feishu group chat. The Agent returns immediately and can continue its current work.

## Single Responsibility

- ✅ Create a pending discussion chat (reuses `chat` skill infrastructure)
- ✅ Package discussion context into the chat file
- ✅ Non-blocking — returns immediately after creating the chat
- ❌ DO NOT create groups directly (Schedule handles activation via lark-cli)
- ❌ DO NOT send messages to groups (Agent sends context after activation)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT wait for responses (poll later or handle asynchronously)

## When to Start a Discussion

Identify topics that warrant user discussion:

| Trigger | Example |
|---------|---------|
| Repeated corrections | User corrects the Agent 3+ times on the same topic |
| Implicit complaints | "又不对", "还是不行", "这个不对" |
| Costly decisions | Large refactors, deleting data, irreversible changes |
| Ambiguous requirements | Multiple valid approaches with different trade-offs |
| Feature requests | User describes a desired behavior without explicit request |
| Taste/preferences | Agent notices patterns in user preferences worth discussing |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Workflow

### Step 1: Create Discussion Chat

Run the script to create a pending discussion chat:

```bash
DISCUSSION_ID="discuss-<unique-slug>" \
DISCUSSION_TOPIC="<concise topic title>" \
DISCUSSION_CONTEXT="<detailed context for the ChatAgent>" \
DISCUSSION_MEMBERS='["ou_user1","ou_user2"]' \
DISCUSSION_EXPIRES_HOURS="24" \
npx tsx skills/start-discussion/start-discussion.ts
```

#### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCUSSION_ID` | Yes | Unique ID (used as filename, e.g. `discuss-code-style`) |
| `DISCUSSION_TOPIC` | Yes | Discussion topic — becomes the group name |
| `DISCUSSION_CONTEXT` | Yes | Full context to send to the ChatAgent in the group |
| `DISCUSSION_MEMBERS` | Yes | JSON array of Feishu open IDs (e.g. `["ou_xxx"]`) |
| `DISCUSSION_EXPIRES_HOURS` | No | Hours until expiry (default: 24) |

The script outputs the chat file path. The chat starts in `pending` status.

### Step 2: Immediate Return

After creating the chat, **return immediately** to the user. The `chats-activation` schedule will automatically create the Feishu group via lark-cli (typically within 1 minute).

Inform the user:
```
✅ 已发起讨论: {topic}
讨论群正在创建中，群成员将收到通知。
```

### Step 3: Send Context (After Activation)

Once the chat is activated (check with `CHAT_ID="<discussion-id>" npx tsx skills/chat/query.ts`), the **Agent** (or a consumer schedule) sends the discussion context to the group via MCP tools:

- Use `send_text` or `send_interactive` to send the context to the group
- The ChatAgent spawned in the group will handle the discussion
- Include clear instructions for the ChatAgent on what to discuss and how to summarize

### Step 4: Handle Response

The consumer (Agent or schedule) polls the chat file:
- When `response` field is populated → user has responded
- When `status` is `expired` → discussion timed out
- Take downstream action based on the response

## Architecture

```
Agent → start-discussion Skill → creates pending chat file
                                      ↓
                          chats-activation Schedule
                          (creates group via lark-cli)
                                      ↓
                          Agent sends context via MCP
                          (send_text / send_interactive)
                                      ↓
                          ChatAgent handles discussion
                          in the Feishu group
                                      ↓
                          chat-timeout Skill
                          (dissolves group on timeout)
```

### Why This Approach

1. **Skill, not MCP tool** — Business logic belongs in Skills; MCP exposes atomic capabilities
2. **Reuses chat infrastructure** — Pending → Active → Expired lifecycle is already implemented
3. **Non-blocking** — Agent creates chat and returns immediately
4. **Declarative** — Discussion context is stored in the chat file for any consumer to use

## Discussion Context Guidelines

When packaging context for the ChatAgent:

1. **State the problem clearly**: What question needs answering?
2. **Provide background**: Relevant history, data, or decisions that led here
3. **List options** (if applicable): Trade-offs for each approach
4. **Specify desired outcome**: What kind of response is expected (decision, feedback, priority)?

Example context:
```
用户在过去3次任务中反复修正代码风格（空格 vs Tab、分号使用）。
需要讨论是否应该：
A) 引入 Prettier 自动格式化
B) 在 CLAUDE.md 中明确风格规范
C) 每次生成前询问用户偏好

请与用户讨论并确定最佳方案。
```

## DO NOT

- ❌ Create or dissolve groups directly (Schedule creates, `chat-timeout` dissolves)
- ❌ Wait for the group to be created (non-blocking — return immediately)
- ❌ Send messages before the chat is activated (will fail)
- ❌ Use MCP group tools (create_chat/dissolve_chat are deprecated; use lark-cli via Schedule)
- ❌ Create discussions without a clear purpose and context

## Error Handling

| Scenario | Action |
|----------|--------|
| Duplicate discussion ID | Report "Discussion {id} already exists" |
| Invalid member IDs | Script validates and reports invalid format |
| Missing required variables | Script reports which variable is missing |
| Chat activation fails | Schedule retries up to 5 times, then marks as `failed` |
| No user response | `chat-timeout` skill dissolves group after expiry |
