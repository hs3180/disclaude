---
name: create-side-group
description: Create a Feishu side group for long-form content delivery. Use when the bot needs to offload lengthy content (code, reports, configs) to a dedicated group, keeping the main chat clean. Keywords: "新群聊", "单独发", "创建群聊", "side group", "context offloading", "发到新群".
allowed-tools: [Bash, Read, Write]
---

# Create Side Group

Create a Feishu side group for delivering long-form content, keeping the main conversation clean. Especially valuable when generated content is too long for comfortable inline display.

## Single Responsibility

- ✅ Create a Feishu group via lark-cli
- ✅ Invite specified members to the new group
- ✅ Optionally register as a temp chat for lifecycle management (auto-dissolution)
- ✅ Return the new group's chat_id for subsequent messaging
- ❌ DO NOT send messages to the new group (agent handles via MCP tools: send_text, send_card)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT use IPC Channel for group operations

## Invocation

This skill is invoked by the agent when it detects that content should be delivered to a separate group. Typical triggers:

1. **Explicit request**: User says "发到新群聊", "单独拉一个群", "创建群聊发给我"
2. **Implicit (voice mode)**: Generated content exceeds a comfortable threshold and user is in voice mode
3. **Long-form content**: Code generation, reports, multi-file configs that would clutter the main chat

### Usage

```bash
SIDE_GROUP_NAME="LiteLLM 配置方案" \
SIDE_GROUP_MEMBERS='["ou_user1", "ou_user2"]' \
SIDE_GROUP_PARENT_CHAT_ID="oc_parent_chat" \
SIDE_GROUP_EXPIRES_HOURS="24" \
npx tsx skills/create-side-group/create-side-group.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SIDE_GROUP_NAME` | Yes | Group name (max 64 chars, auto-truncated) |
| `SIDE_GROUP_MEMBERS` | Yes | JSON array of member open IDs (e.g. `["ou_xxx"]`) |
| `SIDE_GROUP_PARENT_CHAT_ID` | No | Parent chat ID for tracking (oc_xxx format) |
| `SIDE_GROUP_EXPIRES_HOURS` | No | Auto-expiry in hours (default: 24). Set to `0` to disable. |
| `SIDE_GROUP_SKIP_LARK` | No | Set to `1` to skip lark-cli check (testing only) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

Use the **Sender Open ID** as the primary member. Use the **Chat ID** as `SIDE_GROUP_PARENT_CHAT_ID`.

## Execution Flow

```
1. Validate SIDE_GROUP_NAME (non-empty, safe characters)
2. Validate SIDE_GROUP_MEMBERS (non-empty JSON array of ou_xxx IDs)
3. Truncate name to 64 characters if needed
4. Check lark-cli availability
5. Call lark-cli im +chat-create --name ... --users ...
6. Parse chat_id from lark-cli response
7. Optionally register as temp chat via chat/create.ts (for lifecycle management)
8. Output result with chat_id for agent to use
```

## When to Use

### Scenario 1: Explicit Request

```
User:  "生成 LiteLLM 配置方案，发到新群聊里"
Agent: 1. Call this skill → create group → get chat_id
       2. Use send_text/send_card MCP tools to deliver content to new group
       3. Reply in main chat: "✅ 已创建群聊「LiteLLM 配置方案」，内容已发送"
```

### Scenario 2: Long-form Content Offloading

```
Agent generates 3 files of code + architecture docs (>2000 chars)
Agent: 1. Detect content is too long for inline display
       2. Call this skill → create side group
       3. Send structured content to side group via MCP tools
       4. Reply in main chat with brief summary + group name
```

## Output Format

On success, the script outputs:

```
OK: Side group created
CHAT_ID: oc_new_group_id
GROUP_NAME: Truncated Name (if truncated)
```

On failure:

```
ERROR: Description of what went wrong
```

The agent should:
1. Parse `CHAT_ID` from the output
2. Use `send_text` or `send_card` MCP tools to deliver content to the new group
3. Reply in the main chat with a brief confirmation

## Architecture

Group creation uses **lark-cli** to call Feishu API directly — NOT through IPC Channel. This follows the same pattern as:

- `skills/rename-group/` (group rename via lark-cli)
- `schedules/chats-activation.ts` (group creation via lark-cli)
- `skills/chat-timeout/` (group dissolution via lark-cli)

## Integration with Chat Lifecycle

When `SIDE_GROUP_EXPIRES_HOURS` is set (default: 24), the skill also creates a temp chat file via `skills/chat/create.ts`. This enables:

- **Auto-dissolution**: `chat-timeout` skill dissolves the group after expiry
- **Lifecycle tracking**: The temp chat file tracks the side group's lifecycle state
- **Parent linking**: The `context.parentChatId` field links back to the originating chat

## Safety Guarantees

- **Input validation**: Group name must be safe characters, members must be ou_xxx format
- **Name truncation**: Names exceeding 64 chars are truncated at character boundaries (CJK-safe)
- **Idempotent**: Creating a group with the same name creates a new group each time (Feishu behavior)
- **No IPC**: Direct lark-cli call, no worker→primary message passing
- **Graceful degradation**: If temp chat registration fails, group is still created (warning logged)
