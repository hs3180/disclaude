---
name: context-offload
description: Auto-create a side group for long-form content delivery, keeping the main conversation clean. Use when user says keywords like "发到新群聊", "单独发", "创建群聊发", "side group", "offload content", "context offload". Also suitable for voice mode when generated content exceeds a comfortable reading length.
allowed-tools: [Bash, Read, Write]
---

# Context Offload — Side Group for Long-Form Content

Automatically create a dedicated Feishu group and deliver long-form content there, keeping the main conversation clean.

## Single Responsibility

- ✅ Create a new Feishu group via lark-cli
- ✅ Invite the requesting user to the new group
- ✅ Return the new group's chat ID so the agent can send content via MCP tools
- ✅ Optionally register the group as a temporary chat for auto-cleanup
- ❌ DO NOT send content to the new group (agent uses MCP tools: send_text, send_card)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill if registered as temp chat)
- ❌ DO NOT decide when to offload (the agent decides based on content length or user request)

## Invocation

### Agent-Initiated (Primary)

The agent decides to offload content when:
1. **Explicit request**: User says "发到新群聊", "单独拉一个群", "创建群聊发给我"
2. **Long content**: Generated content exceeds ~2000 characters (especially in voice mode)
3. **Multi-file output**: Generating multiple files that benefit from a dedicated space

### Manual Invocation

```
/context-offload
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID of the current conversation (from "**Chat ID:** xxx")
- **Sender Open ID**: Open ID of the requesting user (from "**Sender Open ID:** xxx")

## Usage

### Step 1: Create Side Group

```bash
OFFLOAD_GROUP_NAME="LiteLLM 配置方案 - 04/22" \
OFFLOAD_USER_OPEN_ID="ou_xxxxx" \
OFFLOAD_PARENT_CHAT_ID="oc_xxxxx" \
npx tsx skills/context-offload/create-side-group.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OFFLOAD_GROUP_NAME` | Yes | Name for the new group (max 64 chars, auto-truncated) |
| `OFFLOAD_USER_OPEN_ID` | Yes | Open ID of the user to invite (ou_xxxxx format) |
| `OFFLOAD_PARENT_CHAT_ID` | Yes | The parent chat ID for reference |
| `OFFLOAD_SKIP_LARK` | No | Set to '1' to skip lark-cli calls (testing only) |

### Output

On success, the script outputs JSON to stdout:

```json
{
  "success": true,
  "chatId": "oc_new_group_id",
  "groupName": "LiteLLM 配置方案 - 04/22"
}
```

On failure:

```json
{
  "success": false,
  "error": "Error description"
}
```

### Step 2: Send Content to New Group

After creating the group, use the MCP tools to send content:

```
send_text({ text: "...long content...", chatId: "<new_group_chatId>" })
send_card({ card: {...}, chatId: "<new_group_chatId>" })
```

### Step 3: Notify User in Main Chat

Reply in the main chat with a brief summary:

```
send_text({
  text: "✅ 已创建群聊「{groupName}」，内容已发送",
  chatId: "<parent_chatId>"
})
```

### Step 4 (Optional): Register for Auto-Cleanup

If the side group should be temporary:

```
register_temp_chat({
  chatId: "<new_group_chatId>",
  expiresAt: "<24h from now>",
  creatorChatId: "<parent_chatId>",
  context: { type: "context-offload", parentChatId: "<parent_chatId>" }
})
```

## Complete Flow

```
Agent detects long content or user request
    ↓
1. Call create-side-group.ts → get new chatId
    ↓
2. Send structured content to new group via MCP tools
   (send_text, send_card for each section/file)
    ↓
3. Reply in main chat with brief summary + group name
    ↓
4. (Optional) register_temp_chat for auto-cleanup
    ↓
Main chat stays clean; side group holds the artifacts
```

## Group Naming Guidelines

Generate a descriptive name from context:
- Include the topic/task name
- Append date for uniqueness (MM/DD format)
- Max 64 characters (auto-truncated)
- Examples: "LiteLLM 配置方案 - 04/22", "PR Review Notes - 04/22", "项目架构文档 - 04/22"

## Safety Guarantees

- **Input validation**: Group name validated, user ID must be `ou_xxx` format
- **Name truncation**: Names exceeding 64 chars are truncated at character boundaries
- **Idempotent**: Creating a group with the same name creates a new group (Feishu allows duplicate names)
- **No IPC**: Direct lark-cli call, following the same pattern as `rename-group` and `chats-activation`
- **Error recovery**: Script outputs structured JSON for easy error handling

## Related Components

| Component | Role |
|-----------|------|
| **This skill** | Creates side group for content offloading |
| `send_text` / `send_card` MCP tools | Send content to the new group |
| `register_temp_chat` MCP tool | Register for auto-cleanup |
| `chat-timeout` skill | Auto-dissolve expired temporary groups |
| `chat` skill | General-purpose temporary chat lifecycle |

## DO NOT

- ❌ Send content to the new group (use MCP tools instead)
- ❌ Decide when to offload (agent decides based on context)
- ❌ Create groups without a user to invite
- ❌ Use IPC Channel for group creation (use lark-cli directly)
- ❌ Modify or delete groups created by other processes
