---
name: context-offload
description: Create a side group for long-form content delivery, keeping the main conversation clean. Use when user says keywords like "发到新群聊", "单独发", "创建群聊", "offload", "side group", "context offload". Also use when the agent generates content exceeding ~2000 characters that would clutter the main chat, especially in voice mode scenarios. Triggers on "context-offload", "offload content", "side group", "新群聊", "单独群".
allowed-tools: [Bash]
---

# Context Offload — Auto-create side group for long-form content delivery

Create a dedicated Feishu group, invite the requesting user, and deliver long-form content there. Reply in the main chat with a brief summary + group reference.

## Single Responsibility

- ✅ Create a side group via lark-cli
- ✅ Invite the requesting user to the new group
- ✅ Return the new group chatId for content delivery
- ❌ DO NOT send content to the side group (agent uses `send_text`/`send_card` MCP tools)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT determine what content to offload (the agent decides)

## When to Offload

### Explicit Intent
User explicitly requests content in a separate group:
- "发到新群聊里"
- "单独拉一个群"
- "创建群聊发给我"
- "offload to a new group"

### Implicit Intent (Voice Mode)
When the agent generates content that:
- Exceeds ~2000 characters of code/config
- Contains multiple files that would flood the main chat
- Is primarily reference material (configs, documentation, reports)

In voice mode, long text blocks are impossible to consume via TTS. Side groups act as persistent scratchpads.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx" in the message header)

Use the Sender Open ID as the member to invite to the new group.

## Usage

```bash
OFFLOAD_CHAT_ID="oc_xxxxx" \
OFFLOAD_SENDER_OPEN_ID="ou_xxxxx" \
OFFLOAD_GROUP_NAME="LiteLLM 配置方案 - 04/18" \
npx tsx skills/context-offload/context-offload.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OFFLOAD_CHAT_ID` | Yes | The parent (main) chat ID (oc_xxx format) |
| `OFFLOAD_SENDER_OPEN_ID` | Yes | Open ID of the user to invite to the side group (ou_xxx format) |
| `OFFLOAD_GROUP_NAME` | Yes | Display name for the new group (max 64 chars, auto-truncated) |
| `OFFLOAD_SKIP_LARK` | No | Set to '1' to skip lark-cli check (testing only) |

### Output

On success, outputs JSON to stdout:
```json
{
  "success": true,
  "chatId": "oc_new_group_id",
  "groupName": "LiteLLM 配置方案 - 04/18"
}
```

On failure:
```json
{
  "success": false,
  "error": "Error description"
}
```

## Execution Flow

```
1. Agent detects offload intent (explicit or implicit)
2. Agent invokes this skill → creates side group + invites user
3. Skill returns new group chatId
4. Agent uses send_text/send_card to deliver content to the new group
5. Agent replies in main chat with brief summary
```

### Example Agent Workflow

```
User: "帮我生成 LiteLLM 配置方案，发到新群聊里"

Agent:
1. Generates the configuration content
2. Invokes context-offload skill:
   OFFLOAD_CHAT_ID="oc_current_chat" \
   OFFLOAD_SENDER_OPEN_ID="ou_user123" \
   OFFLOAD_GROUP_NAME="LiteLLM 配置方案 - 04/18" \
   npx tsx skills/context-offload/context-offload.ts

3. Receives: {"success": true, "chatId": "oc_new123", ...}

4. Sends content to the new group:
   send_text({"text": "## LiteLLM 配置方案\n\n...", "chatId": "oc_new123"})

5. Replies in main chat:
   "✅ 已创建群聊「LiteLLM 配置方案 - 04/18」，内容已发送"
```

## Group Lifecycle

- **Creation**: Immediate via lark-cli (`lark-cli im +chat-create`)
- **Naming**: Auto-generated from context by the agent, auto-truncated to 64 chars
- **Tracking**: Use `register_temp_chat` MCP tool to register the new group for lifecycle management
- **Cleanup**: The `chat-timeout` schedule automatically dissolves expired groups

## Group Naming Guidelines

- Keep it descriptive and concise (max 64 chars, auto-truncated)
- Include the topic and optionally a date
- Examples: "LiteLLM 配置方案 - 04/18", "API 文档 - User Service", "周报 2026-W16"

## Architecture

Group creation uses **lark-cli** to call Feishu API directly — NOT through IPC Channel. This follows the same pattern as:
- `chats-activation.ts` (group creation via lark-cli)
- `chat-timeout.ts` (group dissolution via lark-cli)
- `rename-group.ts` (group rename via lark-cli)

## Safety Guarantees

- **Input validation**: Chat ID must match `oc_xxx` format, sender ID must match `ou_xxx` format
- **Name truncation**: Names exceeding 64 chars are truncated at character boundaries (CJK-safe)
- **No IPC**: Direct lark-cli call, no worker→primary message passing
- **Idempotent**: Creating a group with the same name creates a new group (Feishu allows duplicate names)

## DO NOT

- ❌ Send content to the side group (use `send_text`/`send_card` MCP tools instead)
- ❌ Dissolve groups (handled by `chat-timeout` skill)
- ❌ Create groups without a member (at least the requesting user must be invited)
- ❌ Use IPC Channel for group operations (use lark-cli directly)
