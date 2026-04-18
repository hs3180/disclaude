---
name: start-discussion
description: Non-blocking discussion initiation — create a discussion group, send context, and return immediately. Use when agent identifies a topic needing user discussion (repeated commands, implicit complaints, costly decisions). Keywords: "讨论", "留言", "start discussion", "发起讨论", "离线提问", "offline question".
allowed-tools: [send_text, send_interactive, Read, Glob, Grep, Bash]
---

# Start Discussion

Initiate a non-blocking discussion with users in a Feishu group chat. The agent creates a discussion space, sends context, and returns immediately to continue its work.

## Single Responsibility

- ✅ Create a pending chat file for group creation
- ✅ Send discussion context to an existing group
- ✅ Return immediately (non-blocking)
- ❌ DO NOT wait for user responses (poll later)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT create groups directly (handled by `chats-activation` schedule via lark-cli)
- ❌ DO NOT execute downstream actions based on discussion results

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Modes

### Mode A: New Discussion Group

Create a new group for a topic that needs dedicated discussion space.

### Mode B: Existing Group

Send discussion context to an already-active group chat.

## Workflow

### Step 1: Determine Discussion Parameters

Before creating anything, identify:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `topic` | Yes | Discussion topic (short, descriptive) |
| `context` | Yes | Background information for the ChatAgent |
| `members` | Yes (Mode A) | Array of member open IDs (e.g. `["ou_xxx"]`) |
| `chatId` | Yes (Mode B) | Existing group chat ID (e.g. `oc_xxx`) |
| `expiresIn` | No | Discussion duration in hours (default: 24) |

**Topic selection guidelines**:
- Keep topics concise (max 64 chars, auto-truncated)
- Use format: "[subject]的[discussion type]"
- Examples: "需求分析", "PR #123 Review", "Bug修复讨论", "架构选择"

**Context formatting guidelines**:
- Include relevant background: what triggered this discussion, what decision is needed
- Include specific questions or options for the user
- Keep under 4096 bytes (CHAT_CONTEXT limit)
- Structure as key-value pairs for easy parsing

### Step 2: Execute Based on Mode

#### Mode A: Create New Group

Create a pending chat file. The `chats-activation` schedule will automatically create the Feishu group via lark-cli within 1 minute.

```bash
# Generate a unique chat ID
CHAT_ID="discuss-$(date +%s)" \
CHAT_EXPIRES_AT="$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)" \
CHAT_GROUP_NAME="讨论: [topic]" \
CHAT_MEMBERS='["ou_user1"]' \
CHAT_CONTEXT='{"topic":"...","trigger":"...","question":"..."}' \
npx tsx skills/chat/create.ts
```

**Important**: If `date -u -d` is not available (macOS), use:
```bash
# macOS compatible
CHAT_EXPIRES_AT=$(python3 -c "from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) + timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
```

Or hardcode a reasonable expiry:
```bash
# Replace with actual UTC timestamp 24 hours from now
CHAT_EXPIRES_AT="2026-04-19T10:00:00Z"
```

After successful creation, report:
```
📋 Discussion Created
> **Topic**: [topic]
> **Status**: Pending (group will be created automatically)
> **Chat ID**: discuss-[timestamp]
> **Expires**: [expiry time]

The discussion group will be created within 1 minute. Context will be available to the ChatAgent when it joins.
```

#### Mode B: Use Existing Group

Send context directly to an existing group chat via MCP tools.

1. Send the discussion context as a structured message using `send_text` or `send_interactive`:

```
Use send_text or send_interactive to send a message to chatId with the discussion context.
```

The message should include:
- Discussion topic as header
- Background context
- Specific questions for the user
- Any relevant options or action items

After sending, report:
```
📋 Discussion Started
> **Topic**: [topic]
> **Group**: [chatId]
> **Status**: Active (context sent)
```

### Step 3: Return Immediately

After creating the chat file (Mode A) or sending the context (Mode B), return immediately.

- **Do NOT** poll for responses
- **Do NOT** wait for the group to be created
- **Do NOT** block the current workflow

The discussion runs asynchronously. Results can be checked later by querying the chat file:
```bash
CHAT_ID="discuss-xxx" npx tsx skills/chat/query.ts
```

## When to Use

1. **Repeated user commands**: User gives the same instruction multiple times — start a discussion to clarify intent
2. **Implicit complaints**: User expresses frustration — start a discussion to address concerns
3. **Costly decisions**: Agent identifies work that may not be worth the effort — discuss before proceeding
4. **Ambiguous requirements**: Agent needs clarification but shouldn't block the current task
5. **Feature requests**: User suggests new functionality — discuss feasibility and priority

## Architecture

```
Agent (this skill)
  ├─ Mode A: chat/create.ts → workspace/chats/{id}.json (pending)
  │     └─ chats-activation schedule → lark-cli → Feishu group (active)
  │           └─ ChatAgent joins and handles discussion
  │
  └─ Mode B: send_text/send_interactive → existing Feishu group
        └─ ChatAgent in group handles discussion

Both modes return immediately — non-blocking.
```

Group operations use **lark-cli** (Feishu official CLI) through the `chats-activation` schedule, NOT through IPC Channel or MCP tools. This follows the established pattern:
- `chats-activation.ts` — group creation via lark-cli
- `chat-timeout.ts` — group dissolution via lark-cli
- `rename-group.ts` — group rename via lark-cli

## Lifecycle

```
                    ┌──────────────┐
                    │   pending    │  ← This skill creates
                    │ 等待创建群组  │
                    └──────┬───────┘
                           │ chats-activation schedule (≤1 min)
                           ▼
                    ┌──────────────┐
                    │   active     │  ← ChatAgent handles discussion
                    │  等待用户回复  │
                    └──────┬───────┘
                           │ user responds / timeout
                           ▼
                    ┌──────────────┐
                    │   expired    │  ← chat-timeout skill cleans up
                    │   讨论结束    │
                    └──────────────┘
```

## DO NOT

- ❌ Create groups directly via lark-cli (use chat/create.ts + schedule)
- ❌ Dissolve groups (handled by `chat-timeout` skill)
- ❌ Wait for user responses (return immediately)
- ❌ Execute downstream actions (consumer's responsibility)
- ❌ Use MCP create_chat/dissolve_chat (deprecated in favor of lark-cli)
- ❌ Send messages to pending groups (wait for activation first)

## Error Handling

| Scenario | Action |
|----------|--------|
| chat/create.ts fails | Report error, suggest retry with different chat ID |
| Chat ID already exists | Report "Discussion already exists", suggest different ID |
| Invalid member IDs | Report error with expected format (ou_xxxxx) |
| Group name too long | Auto-truncated to 64 chars |
| Context too large | Report error, suggest summarizing context |

## Example: Clarifying Repeated Commands

```
Agent notices user has given the same formatting instruction 3 times.
Agent invokes this skill:

CHAT_ID="discuss-1713446400" \
CHAT_EXPIRES_AT="2026-04-19T12:00:00Z" \
CHAT_GROUP_NAME="讨论: 代码格式化偏好" \
CHAT_MEMBERS='["ou_developer"]' \
CHAT_CONTEXT='{"trigger":"用户重复指定格式化规则3次","question":"是否需要创建永久的格式化配置文件？","options":["是，创建 .prettierrc","否，每次手动指定"],"related_files":["src/formatter.ts"]}' \
npx tsx skills/chat/create.ts

Agent reports creation and continues working.
```
