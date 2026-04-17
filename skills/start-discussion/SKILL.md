---
name: start-discussion
description: Non-blocking discussion initiator — creates a temporary discussion group for a specific topic, sends context, and collects user feedback. Primarily invoked by agents that detect topics needing human input (e.g. repeated corrections, architecture decisions, ambiguous requirements). Use when user says keywords like "发起讨论", "start discussion", "need input", "向用户提问", "留言", "offline question". Also supports direct invocation via /start-discussion.
allowed-tools: send_text, send_interactive, Read, Glob, Grep, Bash
---

# Start Discussion

Non-blocking discussion initiator. Creates a temporary discussion group for a specific topic, sends context, and collects user feedback without blocking the current agent work.

## Single Responsibility

- ✅ Create pending discussion chats (via `chat` skill)
- ✅ Send discussion context to active groups (via MCP)
- ✅ Query discussion status and read responses
- ✅ Non-blocking — returns immediately after creating the chat
- ❌ DO NOT create groups directly (Schedule handles this via lark-cli)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT execute follow-up actions based on responses (caller's responsibility)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Invocation Modes

### Mode 1: Agent Invocation (Primary)

Called by agents that detect topics needing human discussion:

```
Agent detects topic → calls this Skill → creates pending discussion chat → returns immediately
```

Later, the Agent checks back and sends context once the group is active.

### Mode 2: Direct User Invocation

```
/start-discussion <topic>
```

Creates a discussion group for the specified topic.

---

## Workflow

### Phase 1: Create Discussion (Non-blocking)

**Input**: topic, members, background context, expiry duration

1. **Generate a unique chat ID**: Use pattern `discuss-{topic-slug}-{timestamp}` (e.g. `discuss-auth-refactor-1713475200`)

2. **Determine expiry**: Default 24 hours from now. Use UTC Z-suffix ISO 8601 format.

3. **Build discussion context** as a JSON object:

```json
{
  "type": "discussion",
  "topic": "Short description of the discussion topic",
  "background": "Why this discussion is needed, what triggered it",
  "question": "The specific question to ask the user",
  "sourceChatId": "The chat ID where the topic was detected",
  "suggestedActions": ["action 1", "action 2"]
}
```

4. **Create the pending chat** by running:

```bash
CHAT_ID="discuss-{topic-slug}-{timestamp}" \
CHAT_EXPIRES_AT="{24h-from-now-in-UTC-Z}" \
CHAT_GROUP_NAME="Discussion: {topic}" \
CHAT_MEMBERS='["ou_member1"]' \
CHAT_CONTEXT='{the-discussion-context-json}' \
CHAT_TRIGGER_MODE='mention' \
npx tsx skills/chat/create.ts
```

> **Note**: `CHAT_TRIGGER_MODE='mention'` ensures the bot only responds when mentioned in the discussion group.
> **Group Name**: Must use ASCII-safe characters only: `[a-zA-Z0-9_\-.#:/ ()]`. Non-ASCII characters (e.g. Chinese) are not allowed in group names.

5. **Return immediately** with confirmation:

```
✅ 讨论已创建 (ID: discuss-{topic-slug}-{timestamp})
- 主题: {topic}
- 成员: {members}
- 过期时间: {expiry}
- 状态: 等待群组创建（自动进行）

群组将由 Schedule 自动创建，之后上下文将发送给参与者。
```

### Phase 2: Send Context (After Activation)

After creating the discussion, on the next invocation or when checking back:

1. **Query the chat status**:

```bash
CHAT_ID="discuss-{topic-slug}-{timestamp}" npx tsx skills/chat/query.ts
```

2. **If status is `active`** (group created successfully):
   - Extract `chatId` from the chat file (this is the Feishu group chat ID)
   - Compose a clear discussion message including topic, background, and question
   - Send via `send_text` or `send_interactive` MCP tool to the group `chatId`

   **Message format**:

   ```
   📋 讨论主题: {topic}

   背景: {background}

   ❓ 问题: {question}

   💡 建议方案:
   {suggestedActions}

   请回复您的意见或决定。
   ```

3. **If status is `pending`**: Group not yet created, try again later
4. **If status is `failed`**: Report the failure and suggest manual intervention

### Phase 3: Read Response

After the user responds in the discussion group:

1. **Query the chat**:

```bash
CHAT_ID="discuss-{topic-slug}-{timestamp}" npx tsx skills/chat/query.ts
```

2. **If response exists**: Return the response content to the caller
3. **If no response yet**: Report that the discussion is still waiting

---

## Discussion Context Schema

The `CHAT_CONTEXT` JSON object should follow this structure:

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Always `"discussion"` |
| `topic` | Yes | Short description (≤100 chars) |
| `background` | Yes | Why this discussion is needed |
| `question` | Yes | The specific question for the user |
| `sourceChatId` | No | Original chat where topic was detected |
| `suggestedActions` | No | Array of potential actions |

---

## Topic Detection Guidelines

When invoked by an Agent (not direct user call), the Agent should detect discussion-worthy topics:

| Signal | Example | Priority |
|--------|---------|----------|
| Repeated user corrections | "不对，改成...", "不是这个..." | 🔴 High |
| Ambiguous requirements | User says "随便", "都行" | 🟡 Medium |
| Architecture decisions | Multiple implementation approaches | 🟡 Medium |
| Cost/effort concerns | User seems hesitant about approach | 🟡 Medium |
| Feature requests | User asks "能不能..." | 🟢 Low |
| Error patterns | Similar errors 3+ times | 🔴 High |

---

## Member Selection

When selecting discussion members:

1. **Primary**: The user who triggered the topic (`Sender Open ID`)
2. **Additional**: Stakeholders identified from context (e.g. PR author, task assignee)
3. **Minimum**: At least one member required

---

## Expiry Defaults

| Discussion Type | Default Expiry |
|----------------|---------------|
| Quick question | 4 hours |
| Architecture decision | 24 hours |
| Feature request | 24 hours |
| Urgent bug | 2 hours |

---

## Example: Agent-Initiated Discussion

### Agent detects a topic

The Agent notices the user has corrected the same thing 3 times:

```
Agent internal: "User corrected output format 3 times — should start a discussion about preferred format"
```

### Create discussion

```bash
CHAT_ID="discuss-output-format-1713475200" \
CHAT_EXPIRES_AT="2026-04-19T10:00:00Z" \
CHAT_GROUP_NAME="Discussion: Output Format" \
CHAT_MEMBERS='["ou_user123"]' \
CHAT_CONTEXT='{"type":"discussion","topic":"Output format preference","background":"User corrected output format 3 times","question":"What is your preferred default output format?","sourceChatId":"oc_abc123","suggestedActions":["Create format-preference Skill","Update CLAUDE.md"]}' \
CHAT_TRIGGER_MODE='mention' \
npx tsx skills/chat/create.ts
```

### Return immediately

```
✅ 讨论已创建 (ID: discuss-output-format-1713475200)
- 主题: 输出格式偏好
- 成员: ou_user123
- 过期时间: 2026-04-19 10:00 UTC
- 状态: 等待群组创建（自动进行）
```

### Send context (after activation)

Query the chat status, find it's `active` with `chatId: "oc_newgroup456"`, then send:

```
📋 讨论主题: 输出格式偏好

背景: 用户已3次修正输出格式，需要确认长期偏好

❓ 问题: 您希望的默认输出格式是什么？

💡 建议方案:
- 创建 format-preference Skill
- 更新 CLAUDE.md

请回复您的意见或决定。
```

---

## DO NOT

- ❌ Create or dissolve groups directly (Schedule creates, `chat-timeout` skill dissolves)
- ❌ Block the current task waiting for a response (always return immediately)
- ❌ Send context to groups that are not `active` (wait for activation)
- ❌ Create discussions without a clear topic and question
- ❌ Use MCP tools for group operations (use `chat` skill + Schedule)
- ❌ Modify discussions created by other processes
- ❌ Create discussions without a valid `expiresAt` (must be UTC Z-suffix)
- ❌ Delete discussion chat files manually
