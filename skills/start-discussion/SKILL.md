---
name: start-discussion
description: Non-blocking offline discussion initiator — creates a temporary chat group for focused discussion without blocking current work. Uses lark-cli (Bash) for group operations and MCP tools for messaging. Use when user says keywords like "发起讨论", "离线讨论", "留言", "start discussion", "leave note", "讨论群", "非阻塞", "讨论一下".
allowed-tools: [send_text, send_interactive, Read, Glob, Grep, Bash]
---

# Start Discussion

Non-blocking offline discussion initiator. Creates a temporary chat group for focused discussion without blocking current work.

## Single Responsibility

- ✅ Create a pending discussion chat (via `chat/create.ts`)
- ✅ Send discussion context to the group (via MCP send_text / send_interactive)
- ✅ Query chat status (via `chat/query.ts`)
- ✅ Non-blocking: return immediately after creating the chat
- ❌ DO NOT create or dissolve groups directly (use existing `chat` skill + `chats-activation` schedule)
- ❌ DO NOT use MCP tools for group operations (use lark-cli via Bash only)
- ❌ DO NOT wait for user responses (consumer polls chat file later)

## Context Variables

When invoked, you receive:
- **Chat ID**: Current chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx" in the message header)
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx", if available)

## When to Use This Skill

**Use this skill when:**

1. You identify a topic that needs user discussion but shouldn't block your current task
2. You detect repeated user commands, corrections, or implicit complaints that deserve a dedicated discussion
3. You want to leave a message for users to discuss asynchronously
4. A decision needs input from multiple users before proceeding
5. You discover a pattern that could benefit from a new skill, schedule, or workflow

**Keywords that trigger this skill**: "发起讨论", "离线讨论", "留言", "start discussion", "leave note", "讨论群", "非阻塞", "讨论一下"

## Discussion Workflow

### Step 1: Prepare Discussion Context

Package your discussion context into a clear, structured prompt. The context should help the ChatAgent (subagent) in the new group understand what to discuss with users.

**Context Template:**
```markdown
## Discussion: {topic}

### Background
{Why this discussion is needed — what triggered it}

### Key Points
1. {Point 1}
2. {Point 2}

### Questions for Discussion
1. {Open-ended question 1}
2. {Open-ended question 2}

### Suggested Actions
- {Action option 1}
- {Action option 2}
```

**Context packaging guidelines:**
- Be concise but informative — the ChatAgent needs enough context to facilitate discussion
- Frame questions as open-ended to encourage user participation
- Include relevant data or findings that inform the discussion
- Suggest concrete actions so the discussion has clear outcomes

### Step 2: Create Discussion Chat

Create a pending chat using the existing `chat/create.ts` script:

```bash
DISCUSSION_ID="discuss-$(date +%s)" \
CHAT_ID="discuss-{unique-id}" \
CHAT_EXPIRES_AT="{expiry_timestamp}" \
CHAT_GROUP_NAME="{discussion_topic}" \
CHAT_MEMBERS='["ou_member1", "ou_member2"]' \
CHAT_CONTEXT='{ "topic": "...", "background": "...", "pendingMessage": "...", "sourceChatId": "..." }' \
CHAT_TRIGGER_MODE="always" \
npx tsx skills/chat/create.ts
```

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `CHAT_ID` | Yes | Unique ID (e.g. `discuss-{timestamp}` or `discuss-{topic-slug}`) |
| `CHAT_EXPIRES_AT` | Yes | UTC Z-suffix ISO 8601 expiry (e.g. `2026-04-27T10:00:00Z`) |
| `CHAT_GROUP_NAME` | Yes | Group name (max 64 chars, auto-truncated) |
| `CHAT_MEMBERS` | Yes | JSON array of `ou_xxxxx` open IDs |
| `CHAT_CONTEXT` | No | JSON object with `topic`, `background`, `pendingMessage`, `sourceChatId` |
| `CHAT_TRIGGER_MODE` | No | `'always'` (recommended for discussions so bot responds to all messages) |

**Context field conventions:**

| Key | Description |
|-----|-------------|
| `topic` | Short description of the discussion topic |
| `background` | Why this discussion is needed |
| `pendingMessage` | The initial message to send once the group is activated |
| `sourceChatId` | The chat ID where the discussion was initiated (for follow-up) |
| `suggestedActions` | Array of possible follow-up actions |

### Step 3: Return Immediately (Non-Blocking)

After creating the pending chat, **return control immediately**:

```
✅ 已创建讨论群「{topic}」
   - 群组正在创建中（通常 1-2 分钟内完成）
   - 参与者: {member names}
   - 过期时间: {expiry}
   - 讨论内容将自动发送到群组

我将继续当前的任务，讨论结果可以在群组中查看。
```

**Important**: Do NOT poll or wait for the chat to be activated. The `chats-activation` schedule will create the group automatically (runs every minute).

### Step 4: Send Discussion Context (After Activation)

When you return to this discussion later (e.g., on next interaction), check the chat status:

```bash
CHAT_ID="discuss-{unique-id}" npx tsx skills/chat/query.ts
```

If the chat is `active` (group created), send the discussion context via MCP:

**For simple messages:**
```
send_text({
  text: "{discussion_context}",
  chatId: "{activated_chat_id}"
})
```

**For structured discussions with action buttons:**
```
send_interactive({
  question: "{discussion_topic}",
  options: [
    { text: "Option A", value: "action_a", type: "primary" },
    { text: "Option B", value: "action_b" },
    { text: "Skip", value: "skip" }
  ],
  title: "{discussion_title}",
  context: "{background_context}",
  chatId: "{activated_chat_id}",
  actionPrompts: {
    "action_a": "[User Action] User chose Option A: {detail}",
    "action_b": "[User Action] User chose Option B: {detail}",
    "skip": "[User Action] User chose to skip"
  }
})
```

### Step 5: Follow Up on Results

On subsequent interactions, check if the discussion has responses:

```bash
CHAT_ID="discuss-{unique-id}" npx tsx skills/chat/query.ts
```

If `response` is not null, the user has responded. Take follow-up action based on the response content.

## Usage Scenarios

### Scenario 1: Repeated User Corrections

**Context**: The user has corrected you on the same formatting issue 3 times.

**Action**:
```bash
CHAT_ID="discuss-format-prefs" \
CHAT_EXPIRES_AT="2026-04-27T10:00:00Z" \
CHAT_GROUP_NAME="讨论: 输出格式偏好" \
CHAT_MEMBERS='["ou_user1"]' \
CHAT_CONTEXT='{"topic":"输出格式偏好","background":"连续3次被纠正格式问题","pendingMessage":"Hi! 我想了解您对输出格式的偏好，以避免后续纠正。","sourceChatId":"oc_xxx","suggestedActions":["创建格式指南 Skill","更新系统提示"]}' \
CHAT_TRIGGER_MODE="always" \
npx tsx skills/chat/create.ts
```

### Scenario 2: Feature Discovery

**Context**: During work, you discover a pattern that could benefit from a new scheduled task.

**Action**:
```bash
CHAT_ID="discuss-auto-daily-report" \
CHAT_EXPIRES_AT="2026-04-28T10:00:00Z" \
CHAT_GROUP_NAME="讨论: 自动日报功能" \
CHAT_MEMBERS='["ou_manager", "ou_developer"]' \
CHAT_CONTEXT='{"topic":"自动日报功能","background":"发现每天手动生成日报的工作可以自动化","pendingMessage":"我发现每日报告可以自动化生成，想讨论一下需求和实现方向。","sourceChatId":"oc_xxx"}' \
CHAT_TRIGGER_MODE="always" \
npx tsx skills/chat/create.ts
```

### Scenario 3: Costly Decision

**Context**: A task requires significant resources and user confirmation.

**Action**: Use `send_interactive` in the **current chat** (no new group needed for quick decisions):

```
send_interactive({
  question: "This refactoring will take ~20 min and modify 15 files. Proceed?",
  options: [
    { text: "Proceed", value: "proceed", type: "primary" },
    { text: "Discuss", value: "discuss" },
    { text: "Defer", value: "defer" }
  ],
  title: "Resource-Intensive Task",
  context: "Refactoring message-handler.ts to use new file-utils API",
  chatId: "{current_chat_id}",
  actionPrompts: {
    "proceed": "[User Action] User approved: proceed with refactoring",
    "discuss": "[User Action] User wants to discuss first",
    "defer": "[User Action] User chose to defer this task"
  }
})
```

## Architecture

Group operations use **lark-cli** via Bash — NOT through MCP tools. This follows the same pattern as:

| Component | Operation | Method |
|-----------|-----------|--------|
| `chats-activation` schedule | Create group | `lark-cli im +chat-create` |
| `chat-timeout` skill | Dissolve group | `lark-cli api DELETE` |
| `rename-group` skill | Rename group | `lark-cli api PUT` |
| **This skill** | Orchestrate discussion | `chat/create.ts` + MCP send tools |

```
┌──────────────────────────────────────────────────┐
│           start-discussion Skill                  │
│                                                   │
│  1. chat/create.ts → pending chat file            │
│  2. (async) chats-activation → group via lark-cli │
│  3. send_text / send_interactive → context to grp │
│  4. (async) chat-timeout → dissolve if expired    │
│                                                   │
└──────────────────────────────────────────────────┘
```

## Lifecycle

```
 ┌──────────┐    chats-activation     ┌──────────┐
 │ pending  │ ───────────────────── │  active   │
 │ 等待创建  │   (lark-cli group)    │ 等待响应   │
 └─────┬────┘                        └─────┬────┘
       │                                   │
       │ failed (after 5 retries)          │ response received
       ▼                                   ▼
 ┌──────────┐                        ┌──────────┐
 │  failed  │                        │  expired │
 │ 创建失败  │                        │  已结束   │
 └──────────┘                        └──────────┘
```

## Safety Guarantees

- **Non-blocking**: Returns immediately after creating the pending chat file
- **Idempotent**: Creating a chat with the same ID fails safely ("already exists")
- **Validated inputs**: Chat ID, members, group name all validated by `chat/create.ts`
- **Atomic writes**: Chat files written atomically (temp file + rename)
- **File locking**: Concurrent access protected by `fs.flock`
- **Auto-cleanup**: Expired chats dissolved by `chat-timeout` skill

## DO NOT

- ❌ Use MCP tools for group operations (create/dissolve/add members) — use lark-cli via Bash
- ❌ Wait for chat activation — return immediately after creating the pending chat
- ❌ Poll chat status in a loop — check on next interaction instead
- ❌ Create chats without an expiry time (required field)
- ❌ Send messages to groups that haven't been activated yet
- ❌ Create duplicate chats for the same topic

## Error Handling

| Scenario | Action |
|----------|--------|
| Chat creation fails (validation) | Report error to user, suggest fixing input |
| Chat already exists | Report "Discussion already created", show existing chat ID |
| Chat stuck in `pending` | Schedule will retry; check activationAttempts for progress |
| Chat `failed` | Report failure reason; suggest creating a new discussion |
| Chat `expired` | Report "Discussion expired"; create new if still relevant |
| lark-cli unavailable | Schedule handles this; chat stays pending until lark-cli is available |
