---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Also supports direct user invocation via /chat create|query|list. Keywords: "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理".
allowed-tools: [Bash, Read, Write]
---

# Temporary Chat Lifecycle Management

Manage temporary Feishu chat groups for agent-to-user interactions. Supports creating groups for offline questions, tracking responses, and dissolving groups when done.

## Single Responsibility

- ✅ Create temporary chat groups via lark-cli
- ✅ Send context/questions to newly created groups via MCP tools
- ✅ Query and list active temporary chats
- ✅ Dissolve temporary chat groups via lark-cli
- ❌ DO NOT manage PR review groups (use pr-scanner skill)
- ❌ DO NOT use IPC Channel for group operations

## Commands

### `/chat create` — Create a temporary chat group

Create a new Feishu group, send the question/context, and return immediately (non-blocking).

**Parameters** (from `$ARGUMENTS`):

| Parameter | Required | Description |
|-----------|----------|-------------|
| Question/topic | Yes | The question or discussion topic |
| Timeout (hours) | No | Auto-expire time in hours (default: 24) |
| User IDs | No | Comma-separated open_id list to invite |

**Workflow**:

1. **Extract context** from the message:
   - `Chat ID`: The originating chat ID (from "**Chat ID:** xxx")
   - `Message ID`: The triggering message ID (from "**Message ID:** xxx")

2. **Create the group** using lark-cli:

```bash
# Generate a unique topic-based group name
GROUP_NAME="讨论 · {topic摘要前20字}"
lark-cli im +chat-create --name "$GROUP_NAME" --description "临时讨论群"
```

Parse the response to extract the new `chatId` (format: `oc_xxx`).

3. **Invite users** (if user IDs provided):

```bash
lark-cli im chat.members create \
  --params '{"chat_id":"{chatId}","member_id_type":"open_id","succeed_type":1}' \
  --data '{"id_list":["ou_xxx","ou_yyy"]}' --as user
```

4. **Record the mapping** in `workspace/bot-chat-mapping.json`:

Key format: `discussion-{chatId后6位}`

```json
{
  "discussion-{suffix}": {
    "chatId": "oc_xxx",
    "createdAt": "2026-05-01T12:00:00.000Z",
    "purpose": "discussion"
  }
}
```

Read the existing file, add the entry, write back atomically:

```bash
# Read existing
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
# Add entry using node/jq, then write back
```

5. **Create lifecycle record** in `workspace/schedules/.temp-chats/{chatId}.json`:

```json
{
  "chatId": "oc_xxx",
  "createdAt": "2026-05-01T12:00:00.000Z",
  "expiresAt": "2026-05-02T12:00:00.000Z",
  "creatorChatId": "oc_original",
  "context": {
    "question": "The original question or topic",
    "triggerMode": "always"
  }
}
```

Write the file:

```bash
mkdir -p workspace/schedules/.temp-chats
cat > "workspace/schedules/.temp-chats/oc_xxx.json" << 'EOF'
{...record JSON...}
EOF
```

6. **Send the question** to the new group via MCP tools:

Use `send_text` or `send_interactive` MCP tool to deliver the question/context to the new group. Include:
- The original question/topic
- Who asked it
- Expected response format (if applicable)

7. **Report back** to the originating chat:

Confirm group creation with the chat ID and expiration time. This response is non-blocking — the agent returns immediately while the new group's ChatAgent handles the discussion.

### `/chat query` — Query a temporary chat's status

Check whether a temporary chat has received responses.

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| Chat ID | Yes | The `oc_xxx` chat ID to query |

**Workflow**:

1. Read the lifecycle record:

```bash
cat "workspace/schedules/.temp-chats/{chatId}.json" 2>/dev/null
```

2. Report the status:
   - **No record**: Chat not found or already dissolved
   - **Has response**: Show response details (who responded, when, what value)
   - **Expired**: Show that the chat expired without response
   - **Active**: Show remaining time until expiration

### `/chat list` — List active temporary chats

List all temporary chats managed by this skill.

**Workflow**:

1. Read all records:

```bash
ls workspace/schedules/.temp-chats/*.json 2>/dev/null | while read f; do
  echo "=== $(basename "$f") ==="
  cat "$f"
done
```

2. Filter and display:
   - Show chat ID, creation time, expiration, response status
   - Group by status: active / responded / expired

### `/chat dissolve` — Dissolve a temporary chat group

Dissolve a Feishu group and clean up all associated records.

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| Chat ID | Yes | The `oc_xxx` chat ID to dissolve |

**Workflow**:

1. **Validate** the chat ID format (`oc_xxx`).

2. **Dissolve the group** via lark-cli:

```bash
lark-cli api DELETE "/open-apis/im/v1/chats/{chatId}"
```

3. **Remove the mapping** from `workspace/bot-chat-mapping.json`:

Read → find and remove entry with matching chatId → write back.

4. **Remove the lifecycle record**:

```bash
rm -f "workspace/schedules/.temp-chats/{chatId}.json"
```

5. **Report** the dissolution result.

## Context Variables

When invoked, you receive context in the system message:

- **Chat ID**: The Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: The message ID (from "**Message ID:** xxx" in the message header)
- **Sender Open ID**: The sender's open ID (from "**Sender Open ID:** xxx", if available)

Extract these values and use them for:
- `creatorChatId` in lifecycle records
- Sending messages to the correct groups
- Tracking which chat initiated the temporary group

## Architecture

```
Agent → Bash → lark-cli <command> → Feishu API   (group operations)
Agent → MCP → send_text/send_interactive          (message sending)
Agent → Read/Write → workspace/schedules/.temp-chats/ (lifecycle records)
Agent → Read/Write → workspace/bot-chat-mapping.json  (chatId mappings)
```

Group operations use **lark-cli** directly — NOT through IPC Channel. This follows the architecture established in #1912 (移除群组管理 MCP 工具).

## Error Handling

| Error | Action |
|-------|--------|
| lark-cli not found | Report installation instruction: `npm install -g @larksuite/cli` |
| Group creation fails | Report error, do NOT create lifecycle record |
| chatId format invalid | Reject with validation message |
| Lifecycle file write fails | Log warning, group is created but untracked |
| Dissolution fails | Remove local records anyway (group may already be gone) |
| Mapping file corrupted | Log warning, continue with in-memory operations |

## Safety Guarantees

- **Input validation**: Chat IDs must match `oc_xxx` format
- **Idempotent dissolve**: Dissolving an already-dissolved group is safe
- **Atomic writes**: Use write-to-temp-then-rename for JSON files
- **Non-blocking create**: Returns immediately after group creation
- **No auto-dissolve on expiry**: Expiration is tracked but dissolution is user-initiated

## Dependencies

- `lark-cli` (npm: `@larksuite/cli`) — Feishu official CLI
- `workspace/bot-chat-mapping.json` — BotChatMappingStore
- `workspace/schedules/.temp-chats/` — ChatStore

## Related

- Parent: #631 (离线提问 - Agent 不阻塞工作的留言机制)
- Infrastructure: #1912 (移除群组管理 MCP 工具, lark-cli 替代)
- Follow-up: #1228 (讨论焦点保持), #1229 (智能会话结束)
- Pattern: pr-scanner skill (group creation via lark-cli)
- Pattern: rename-group skill (lark-cli API calls)
