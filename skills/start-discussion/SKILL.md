---
name: start-discussion
description: Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'.
allowed-tools: send_text, send_interactive, push_to_agent, Read, Write, Bash, Glob, Grep
---

# Start Discussion

Non-blocking offline discussion initiator. Creates a Feishu group, injects initialization context into the group's agent, records the mapping, and returns immediately.

**适用于**: 发起讨论、离线提问、委托子问题 | **不适用于**: 解散群、管理成员、投票

## When to Use This Skill

**Use this skill when:**
- You identify a topic that needs deeper discussion but shouldn't block your current task
- You want to delegate a question to a specific user or group asynchronously
- A PR review, bug investigation, or design decision needs a dedicated discussion space
- You need to spawn a sub-agent conversation without blocking current work

**Keywords**: "发起讨论", "离线讨论", "留言", "start discussion", "leave note", "讨论群", "非阻塞", "讨论一下", "离线提问"

## Core Principle

**This skill is an orchestration guide.** It composes existing atomic tools:

| Tool | Purpose |
|------|---------|
| `Bash` (lark-cli) | Create Feishu group |
| `push_to_agent` | Inject initialization prompt into the new group's agent |
| `Read`/`Write` | Update `workspace/bot-chat-mapping.json` |
| `send_text` | Send confirmation to source group |

> Issue #1298: Business logic is NOT MCP scope. MCP tools expose atomic capabilities; orchestration is done by the Agent.

## Context Variables

When invoked, you receive:
- **Chat ID**: Current chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Workflow

### Step 1: Create Feishu Group via lark-cli

```bash
lark-cli im +chat-create --name "{discussion_topic}" --description "{brief_description}"
```

**Parameters**:
- `--name`: Discussion topic as group name (concise, max 50 chars)
- `--description`: Brief description of the discussion purpose
- Optionally add `--users` with open IDs to invite specific members

**Expected output**: A `chat_id` (oc_xxx format) for the newly created group.

**Error handling**: If lark-cli fails, report the error to the source group and stop.

### Step 2: Inject Initialization Prompt via push_to_agent

Use `push_to_agent` to send context to the new group's agent. The agent will be lazily created on first message.

```
push_to_agent({
  chatId: "{new_group_chat_id}",
  message: "{initialization_prompt}"
})
```

**Initialization prompt template**:
```
你是一个讨论群助手。以下是本次讨论的背景信息：

## 讨论主题
{topic}

## 背景
{why_this_discussion_is_needed}

## 关键信息
1. {point_1}
2. {point_2}

## 讨论要点
- {question_1}
- {question_2}

请向群成员介绍讨论背景，并引导讨论。
```

**Prompt packaging guidelines**:
- Be concise but informative — the ChatAgent needs enough context to facilitate discussion
- Frame questions as open-ended to encourage participation
- Include relevant data or findings that inform the discussion
- Suggest concrete actions so the discussion has clear outcomes

### Step 3: Record Mapping

Append the mapping entry to `workspace/bot-chat-mapping.json`:

```bash
# Read existing mapping
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Add a new entry with key `discussion-{identifier}`:

```json
{
  "discussion-{identifier}": {
    "chatId": "{new_group_chat_id}",
    "createdAt": "{ISO_timestamp}",
    "purpose": "discussion"
  }
}
```

Write the updated mapping atomically (write to temp file, then rename).

### Step 4: Return Confirmation to Source Group

```
send_text({
  text: "已创建讨论群「{topic}」，讨论将在新群中进行。Chat ID: {new_group_chat_id}",
  chatId: "{source_chat_id}"
})
```

**This is a non-blocking operation.** After sending confirmation:
- Return control to your current task immediately
- Do NOT wait for user responses
- The discussion continues asynchronously in the new group

---

## Error Handling

| Error | Action |
|-------|--------|
| lark-cli fails | Report error to source group, stop |
| push_to_agent fails | Group exists but agent not initialized. Record mapping anyway, send fallback message to new group via `send_text` |
| Mapping file write fails | Log error, continue (mapping is a cache, can be rebuilt) |
| lark-cli not installed | Report error: "lark-cli 未安装，请先运行 `npm install -g @larksuite/cli`" |

---

## Usage Scenarios

### Scenario 1: PR Discussion

Agent detects a complex PR during code scanning:

1. Create group: `lark-cli im +chat-create --name "PR #123 · Refactor auth module" --description "PR #123 review discussion"`
2. Inject prompt with PR details, key changes, and review questions
3. Record mapping: `discussion-pr-123` → `{chatId, purpose: "discussion"}`
4. Confirm in source group

### Scenario 2: Offline Question

Agent encounters a question that needs user input but shouldn't block:

1. Create group: `lark-cli im +chat-create --name "问题讨论 · API 设计方案" --description "API design decision"`
2. Inject prompt with the question, context, and options
3. Record mapping: `discussion-api-design` → `{chatId, purpose: "discussion"}`
4. Confirm in source group

### Scenario 3: Multi-user Decision

Agent identifies a decision needing multiple stakeholders:

1. Create group: `lark-cli im +chat-create --name "决策 · 技术选型" --description "Technology stack decision" --users "ou_xxx,ou_yyy"`
2. Inject prompt with decision context, pros/cons, and voting options
3. Record mapping
4. Confirm in source group

---

## DO NOT

- **Do NOT** manage agent message sending — disclaude handles this via system prompt
- **Do NOT** wait for user responses — this is non-blocking
- **Do NOT** dissolve groups — group lifecycle is user-driven
- **Do NOT** create duplicate groups — always check mapping first
- **Do NOT** embed complex business logic in the initialization prompt — keep it focused on discussion context

## Dependencies

`lark-cli` (Feishu official CLI) · `push_to_agent` MCP tool · `workspace/bot-chat-mapping.json` (BotChatMappingStore)

## Related

- Parent: #631
- Depends on: #3701 (push_to_agent MCP tool, merged)
- Related: #3283 (通用建群 Skill)
