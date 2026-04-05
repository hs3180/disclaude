---
name: start-discussion
description: Non-blocking offline discussion initiator - creates group chats for asynchronous discussions without blocking current work. Use when agent identifies a topic needing user discussion, such as ambiguous requirements, repeated corrections, costly decisions, or implicit complaints. Keywords: "发起讨论", "离线讨论", "讨论群", "offline discussion", "start discussion", "ask user", "讨论一下", "留言".
allowed-tools: [Bash, Read, Write, Glob, Grep, send_text, send_interactive]
---

# Start Discussion

Create a non-blocking discussion group for asynchronous user interaction. The agent creates the group, sends context, registers it for lifecycle tracking, and returns immediately.

## When to Use This Skill

**Use this skill when the agent detects:**
- Ambiguous requirements that need user clarification
- User repeatedly corrects agent's output (2+ times on same topic)
- Implicit or explicit user complaints or frustration
- A costly or risky decision needs user confirmation
- User explicitly requests a discussion ("发起讨论", "离线提问")
- A question that shouldn't block the current workflow

**Keywords**: "发起讨论", "离线讨论", "讨论群", "offline discussion", "start discussion", "ask user", "讨论一下"

## Core Principle

**Non-blocking by design**: Create the discussion group, send context, register for lifecycle tracking, and return immediately. The agent continues working while the discussion happens asynchronously in a separate group.

## Single Responsibility

- Create discussion groups via `lark-cli` (Bash)
- Send discussion context to the group (MCP tools)
- Register the discussion in the chat system for lifecycle tracking
- Return immediately (non-blocking)

**DO NOT**:
- Wait for user responses (non-blocking by design)
- Execute downstream actions based on assumed responses (consumer's responsibility)
- Create composite MCP tools that combine group creation + message sending (violates SRP)
- Dissolve groups (handled by `chat-timeout` skill)
- Modify chats created by other processes

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Discussion Triggers

The agent should proactively start a discussion when detecting these patterns:

| Pattern | Indicators | Example |
|---------|------------|---------|
| **Ambiguous Requirements** | Multiple valid interpretations | User says "fix it" without specifying which issue |
| **Repeated Corrections** | Same topic corrected 2+ times | "不对，应该是X" -> "还是不对" |
| **Costly Decision** | High-impact action without confirmation | Deleting data, deploying to production |
| **Implicit Complaint** | Frustration signals in messages | "又要手动做?", "怎么还不行" |
| **Scope Creep** | Requirements expanding beyond original scope | Task keeps getting new requirements |
| **Technical Trade-off** | Multiple approaches with different trade-offs | Performance vs maintainability |

## Operations

### 1. Create Discussion (Primary Operation)

Non-blocking: create group, send context, register, and return.

#### Step 1: Determine Discussion Parameters

Before creating the group, define:

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `topic` | Yes | Clear discussion topic | "Auth refactor approach" |
| `chat_id` | Yes | Unique chat ID (alphanumeric, hyphens, underscores) | `discuss-auth-refactor` |
| `members` | Yes | JSON array of member open IDs | `["ou_developer"]` |
| `context` | Yes | Discussion context and background | See format below |
| `expiry_hours` | No | Hours until expiration (default: 24) | `24` |
| `questions` | Yes | Specific questions for discussion | See format below |

#### Step 2: Create Group via lark-cli

```bash
# Create group chat via official Feishu CLI
result=$(timeout 30 lark-cli im +chat-create \
  --name "讨论: {topic_summary}" \
  --users "{members_json}" 2>/tmp/lark-cli-err-XXXXXX)

# Extract chat ID from response
chat_id=$(echo "$result" | jq -r '.data.chat_id // empty')
```

If `chat_id` is empty, the group creation failed. Report the error and abort (do not create a chat file).

#### Step 3: Send Discussion Context

Use `send_text` MCP tool to send the formatted context to the newly created group:

```
send_text({
  chatId: "{chatId from Step 2}",
  text: "{formatted_discussion_context}"
})
```

**Discussion Context Format**:

```markdown
## 讨论主题: {topic}

{background_and_context}

### 需要讨论的问题
1. {question_1}
2. {question_2}
3. {question_3}

### 相关材料
- {link_or_reference_1}
- {link_or_reference_2}

---
请在群聊中讨论后回复结论。本讨论将在 {expiry} 后自动超时。
```

#### Step 4: Register in Chat System

Create a chat file for lifecycle tracking (timeout, cleanup) with `status: "active"`:

```bash
# Create the chat directory
mkdir -p workspace/chats

# Write chat file directly (status=active since group already exists)
jq -n \
  --arg id "{chat_id}" \
  --arg chatId "{feishu_chat_id}" \
  --arg expires "{expires_at}" \
  --arg group_name "讨论: {topic_summary}" \
  --argjson members '{members_json}' \
  --argjson context '{"topic": "...", "source": "...", "trigger": "..."}' \
  '{
    id: $id,
    status: "active",
    chatId: $chatId,
    createdAt: (now | todate),
    activatedAt: (now | todate),
    expiresAt: $expires,
    createGroup: { name: $group_name, members: $members },
    context: $context,
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null
  }' > "workspace/chats/{chat_id}.json"
```

**Important**: Set `status: "active"` and `chatId` directly since the group is already created. Do NOT use `scripts/chat/create.sh` (it sets `status: "pending"` which would cause the chats-activation schedule to create a duplicate group).

#### Step 5: Return Immediately

Report the result and continue working:

```
✅ 讨论已发起: {topic}
> 群聊 ID: {chatId}
> Chat 文件: workspace/chats/{chat_id}.json
> 超时时间: {expires_at}
> 状态: 等待用户讨论
```

### 2. Check Discussion Status

Poll the chat file to check if the user has responded:

```bash
# Query chat status
CHAT_ID="{chat_id}" bash scripts/chat/query.sh
```

If the `response` field is populated, the user has responded:
- Read the response content
- Take appropriate downstream action
- The chat-timeout skill handles group cleanup

### 3. Handle Discussion Response

When a response is received, record it in the chat file:

```bash
CHAT_ID="{chat_id}" \
CHAT_RESPONSE="{user_response}" \
CHAT_RESPONDER="{responder_open_id}" \
bash scripts/chat/response.sh
```

## Chat ID Convention

Use descriptive IDs that indicate the discussion topic:

| Format | Example | Use Case |
|--------|---------|----------|
| `discuss-{topic}` | `discuss-auth-refactor` | Technical discussion |
| `ask-{topic}-{date}` | `ask-deploy-20260405` | Question for user |
| `review-{target}` | `review-pr-123` | Review discussion |

## Expiration

Default: **24 hours** from creation.

```bash
# Linux
date -u -d "+24 hours" +"%Y-%m-%dT%H:%M:%SZ"

# macOS
date -u -v+24H +"%Y-%m-%dT%H:%M:%SZ"
```

## Error Handling

| Scenario | Action |
|----------|--------|
| `lark-cli` not available | Report error, suggest `npm install -g @larksuite/cli` |
| Group creation fails (timeout/error) | Report error, do NOT create chat file |
| Context send fails | Log warning, chat file still created (discussion context can be resent later) |
| Chat file write fails | Report error, group already exists (manual cleanup if needed) |
| Duplicate chat ID | Report error, use a different ID |
| `jq` not available | Exit with error (required dependency) |

## Lifecycle

The discussion follows the chat system lifecycle:

```
                     start-discussion skill
                            │
                            ▼
┌─────────────┐         ┌─────────────┐
│   active    │ ──────> │   expired   │
│  讨论进行中  │  timeout │  已结束      │
└─────────────┘         └─────────────┘
       │
       │ user response recorded
       ▼
┌─────────────┐
│   expired   │
│  已结束      │
└─────────────┘
```

| Component | Responsibility |
|-----------|---------------|
| **This Skill** | Create group, send context, register in chat system |
| **Chat Agent** | Handle discussion in the group |
| **Consumer** | Poll for response, take downstream action |
| **chat-timeout** | Detect timeout, dissolve group, mark as expired |
| **chats-cleanup** | Remove expired chat files after retention period |

## DO NOT

- Wait for user response before returning (non-blocking by design)
- Execute downstream actions based on assumed responses
- Use `scripts/chat/create.sh` (it creates `pending` status, causing duplicate groups)
- Create composite MCP tools (violates SRP, per PR #1531 rejection)
- Dissolve groups (handled by `chat-timeout` skill)
- Start discussions for trivial matters that don't need user input
- Modify chats created by other processes
- Create discussions without a clear topic and specific questions
