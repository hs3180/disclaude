---
name: start-discussion
description: Initiate non-blocking group discussions with users. Agent creates a discussion group, sends context, and returns immediately. Use when the agent identifies a topic requiring deeper exploration, user feedback, or decision-making. Triggered by keywords like "start discussion", "发起讨论", "离线提问", "ask user", "需要用户意见".
allowed-tools: [send_text, send_interactive, Read, Glob, Grep, Bash]
---

# Start Discussion Skill

Initiate a non-blocking group discussion with a user. Create a discussion group, send the discussion context, and return immediately — your current work continues uninterrupted.

## Single Responsibility

- ✅ Analyze context and identify discussion topics
- ✅ Create discussion group via `lark-cli`
- ✅ Register chat in the lifecycle system (for auto-expiry/dissolution)
- ✅ Send discussion context via MCP tools
- ✅ Return immediately (non-blocking)
- ❌ DO NOT wait for user response
- ❌ DO NOT manage group lifecycle (handled by `chat-timeout` skill)
- ❌ DO NOT use MCP tools for group operations (use `lark-cli` via Bash)

## When to Use This Skill

The agent should proactively start a discussion when it identifies:

| Trigger | Example |
|---------|---------|
| Repeated corrections | User has corrected the agent 3+ times on the same topic |
| Ambiguous requirements | Multiple interpretations exist, user input needed |
| Costly work without confirmation | About to start a task that takes significant time/resources |
| User frustration detected | User expresses dissatisfaction or confusion |
| Decision point reached | Multiple valid approaches, need user's preference |
| Proactive insight | Agent discovers something the user should know about |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Workflow

### Step 1: Prepare Discussion Context

Before creating the group, prepare:

1. **Topic**: Clear, concise discussion topic (used as group name)
2. **Context**: Background information the ChatAgent needs for the discussion
3. **Initial message**: The opening message to send to the group
4. **Target user(s)**: Open IDs of users to include (from the current chat's sender or mentioned users)
5. **Expiry**: When the discussion should auto-expire (default: 24 hours from now)

### Step 2: Create Discussion Group

Use `lark-cli` to create a new group chat:

```bash
lark-cli im +chat-create \
  --name "{discussion_topic}" \
  --users "{user_open_ids_comma_separated}"
```

**Parse the response** to extract the `chat_id`:

```
{"data":{"chat_id":"oc_xxxxx"}}
```

**Error handling**:
- If lark-cli fails, report the error and stop
- If the response doesn't contain a valid `chat_id`, report the error and stop

### Step 3: Register Chat in Lifecycle System

Register the discussion in the chat lifecycle system so it gets auto-expired and dissolved:

```bash
CHAT_ID="discussion-{unique_id}" \
CHAT_FEISHU_ID="{oc_xxxxx from step 2}" \
CHAT_EXPIRES_AT="{ISO 8601 UTC Z-suffix, e.g. 2026-04-18T10:00:00Z}" \
CHAT_GROUP_NAME="{discussion topic}" \
CHAT_MEMBERS='["ou_xxxxx"]' \
CHAT_CONTEXT='{"initialMessage": "...", "topic": "..."}' \
CHAT_TRIGGER_MODE="always" \
npx tsx skills/start-discussion/register.ts
```

**Parameters**:
| Variable | Required | Description |
|----------|----------|-------------|
| `CHAT_ID` | Yes | Unique ID for the chat file (e.g. `discussion-1681726800`) |
| `CHAT_FEISHU_ID` | Yes | Feishu group chat ID from step 2 (`oc_xxxxx`) |
| `CHAT_EXPIRES_AT` | Yes | UTC Z-suffix ISO 8601 expiry (default: 24h from now) |
| `CHAT_GROUP_NAME` | Yes | Group display name |
| `CHAT_MEMBERS` | Yes | JSON array of member open IDs |
| `CHAT_CONTEXT` | No | JSON object with discussion context |
| `CHAT_TRIGGER_MODE` | No | `'always'` (default) — bot responds to all messages |

### Step 4: Send Discussion Context

Send the initial context to the group via MCP tools. The message should include:

1. **Why this discussion was started** (brief, 1-2 sentences)
2. **The specific question or topic** to discuss
3. **Relevant background** (key facts, constraints, options)
4. **Call to action** (what kind of input is needed)

Use `send_interactive` for rich formatting or `send_text` for plain text:

```
send_interactive({
  chatId: "{oc_xxxxx}",
  message: "{formatted discussion context card}"
})
```

Or:

```
send_text({
  chatId: "{oc_xxxxx}",
  message: "{plain text discussion context}"
})
```

### Step 5: Return Immediately

After sending the context, return to the user with a confirmation:

```
✅ 已发起讨论: {topic}

讨论群已创建，上下文已发送。ChatAgent 将在新群聊中与用户讨论此话题。
讨论将在 {expiry_time} 后自动过期。
```

**Do NOT**:
- Wait for a response
- Poll the chat file
- Block the current conversation

The discussion result will be available later via the `chat` skill's query mechanism (`/chat query {id}`).

---

## Chat Agent Behavior

When the user responds in the discussion group, the system's ChatAgent handles the conversation naturally. The initial context you send in Step 4 becomes the ChatAgent's starting point for the discussion.

**Tips for effective context**:
- Be specific about what decision or input is needed
- Include relevant constraints or preferences
- Frame open-ended questions when possible
- Avoid yes/no questions — encourage discussion

---

## Discussion Context Template

Use this template for the initial message:

```markdown
## 📋 讨论邀请

**话题**: {topic}

### 背景
{2-3 sentences of context about why this discussion matters}

### 讨论要点
{1. Key point or question}
{2. Key point or question}
{3. Key point or question}

### 希望获得
{What kind of input is needed: decision, preference, feedback, etc.}

---
💬 请分享你的想法，ChatAgent 会引导讨论。
```

---

## Lifecycle Management

The discussion follows the standard chat lifecycle:

```
┌─────────────┐          ┌──────────┐
│   created   │ ────────>│  active  │
│  (by Skill) │          │ (disc.)  │
└─────────────┘          └────┬─────┘
                              │
              timeout / response received
                              │
                              ▼
                        ┌──────────┐
                        │ expired  │
                        │ (auto)   │
                        └──────────┘
```

| Component | Responsibility |
|-----------|---------------|
| **This Skill** | Creates group, registers chat, sends context |
| **ChatAgent** | Handles discussion in the group |
| **`chat-timeout` Skill** | Auto-expires and dissolves group |
| **`chat` Skill** | Query discussion status/results |

---

## Error Handling

| Scenario | Action |
|----------|--------|
| lark-cli not found | Report: "lark-cli not available, cannot start discussion" |
| Group creation fails | Report error, do not create chat file |
| Chat registration fails | Report error, group was created but won't auto-expire |
| MCP send fails | Report error, discussion started but context not delivered |
| Invalid member IDs | Report: "Invalid member format, expected ou_xxxxx" |

## DO NOT

- ❌ Wait for user response (non-blocking)
- ❌ Create groups via MCP tools (use lark-cli via Bash)
- ❌ Dissolve groups (handled by chat-timeout)
- ❌ Send multiple initial messages (one context message only)
- ❌ Use this for simple yes/no questions (use inline reply instead)
- ❌ Create discussions without a clear topic and context
- ❌ Set expiry shorter than 1 hour or longer than 48 hours
