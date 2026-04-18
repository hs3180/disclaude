---
name: context-offload
description: Create a side group for long-form content delivery (Context Offloading). Automatically creates a temporary group, sends structured content there, and keeps the main conversation clean. Use when user says keywords like "发到新群聊", "单独发", "创建群聊", "发到侧边", "新群", "side group", "offload", "context offloading", or when generating long content (>2000 chars) that should be delivered separately.
allowed-tools: [Bash]
---

# Context Offload — Side Group Content Delivery

Create a dedicated side group for long-form content delivery, keeping the main conversation clean. This is especially useful for voice mode interactions and large generated content.

## Single Responsibility

- ✅ Create a temporary chat file for side group creation
- ✅ Return the chat ID and group name for downstream use
- ✅ Determine appropriate group name from content context
- ✅ Support explicit and automatic offload triggers
- ❌ DO NOT create groups directly (Schedule handles this via lark-cli)
- ❌ DO NOT send messages to the side group (agent uses MCP tools after creation)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)

## Invocation Modes

### Mode 1: Explicit User Request

User explicitly asks to deliver content to a new group:

```
User:  "生成 LiteLLM 配置方案，发到新群聊里"
→ Agent triggers context-offload skill
→ Skill creates pending chat file
→ Agent replies with brief confirmation in main chat
→ Schedule activates the group
→ Agent sends full content to the new group via send_text/send_card
```

### Mode 2: Automatic Offload (Agent Decision)

Agent detects that generated content is too long for comfortable consumption:

```
Agent generates 3000+ chars of code/config/docs
→ Agent decides to offload to side group
→ Triggers context-offload skill
→ Sends content to the new group after activation
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header) — this is the *parent* chat
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Usage

### Create a Side Group

```bash
OFFLOAD_PARENT_CHAT_ID="oc_xxxxx" \
OFFLOAD_GROUP_NAME="LiteLLM 配置方案" \
OFFLOAD_MEMBERS='["ou_xxxxx"]' \
OFFLOAD_CONTEXT='{"source": "voice-mode", "contentType": "config"}' \
OFFLOAD_EXPIRES_HOURS="24" \
npx tsx skills/context-offload/create-side-group.ts
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OFFLOAD_PARENT_CHAT_ID` | Yes | — | The parent chat ID where the request originated |
| `OFFLOAD_GROUP_NAME` | Yes | — | Display name for the side group (auto-truncated to 64 chars) |
| `OFFLOAD_MEMBERS` | Yes | — | JSON array of open IDs to invite (e.g. `["ou_xxx"]`) |
| `OFFLOAD_CONTEXT` | No | `{}` | Additional context data (JSON object) |
| `OFFLOAD_EXPIRES_HOURS` | No | `24` | Hours until the side group auto-expires |

### Output

On success, the script outputs:
```
OK: Side group chat created
CHAT_ID: offload-abc123
GROUP_NAME: LiteLLM 配置方案
STATUS: pending
```

The agent should then:
1. Reply in the parent chat with a brief confirmation: "✅ 已创建群聊「{GROUP_NAME}」，内容将在群创建后发送"
2. Poll or wait for the chat to be activated by the schedule
3. Once active, use `send_text` or `send_card` MCP tools to send content to the new group's chatId

## Chat ID Format

Side group chat IDs are prefixed with `offload-` followed by a short random suffix:
```
offload-a1b2c3
```

This distinguishes them from PR review chats (`pr-123`) and other temporary chats.

## Integration with Existing Components

| Component | Role |
|-----------|------|
| **This skill** | Creates the pending chat file for side group |
| `chats-activation` schedule | Creates the actual group via lark-cli |
| `chat-timeout` skill | Auto-expires and dissolves the group |
| `register_temp_chat` MCP tool | Registers the group for lifecycle tracking |
| Agent (via MCP tools) | Sends content to the activated group |

## Recommended Agent Flow

```
1. User requests long-form content → "发到新群聊" or content > 2000 chars
2. Agent determines group name from context
3. Agent invokes this skill to create pending chat
4. Agent confirms to user in main chat: "✅ 正在创建群聊..."
5. Schedule activates the group (typically within 1-5 minutes)
6. Agent uses send_text/send_card to deliver content to the new group
7. Agent notifies user with group link
8. Group auto-expires after OFFLOAD_EXPIRES_HOURS (default 24h)
```

## Group Naming Guidelines

- Auto-generate from content context: "{topic} - {date}"
- Keep concise (max 64 chars, auto-truncated)
- Examples: "LiteLLM 配置方案 - 04/19", "API 文档", "代码生成: Auth Module"

## Safety Guarantees

- **Chat ID validation**: Path traversal protection and format validation
- **File locking**: Exclusive lock during creation (TOCTOU-safe)
- **Atomic writes**: Write to temp file then rename
- **Idempotent**: Duplicate chat IDs are rejected
- **Input sanitization**: Group name and member validation before processing

## DO NOT

- ❌ Create or dissolve groups directly
- ❌ Send messages to the side group (use MCP tools after activation)
- ❌ Create groups without a valid parent chat ID
- ❌ Use this for real-time conversations (use `chat` skill instead)
- ❌ Delete chat files manually
