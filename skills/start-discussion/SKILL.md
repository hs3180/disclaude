---
name: start-discussion
description: Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'.
allowed-tools: [Read, Write, Edit, Bash]
---

# Start Discussion — Non-blocking Discussion Launcher

Create a Feishu discussion group for a topic, send context, record the mapping, and return immediately. The current agent continues working without waiting for responses.

## Single Responsibility

- ✅ Create a Feishu group for discussion
- ✅ Send discussion context to the new group
- ✅ Record the group mapping in `workspace/bot-chat-mapping.json`
- ✅ Return immediately (non-blocking)
- ❌ DO NOT wait for responses from the discussion group
- ❌ DO NOT dissolve groups (use the `chat` skill or `lark-cli` directly)

## Input

You will receive:
- **Topic**: The discussion topic (from `$ARGUMENTS` or current conversation context)
- **Context**: Background information the discussion group needs
- **Source Chat ID**: The current chat ID (for mapping reference)
- **Participants**: Open IDs of users to add (optional; defaults to the requesting user)

## Workflow

### Step 1: Extract Topic and Context

**If arguments provided** (e.g. `/start-discussion Should we migrate to Bun?`):
- Use `$ARGUMENTS` as the topic
- Gather context from recent conversation history

**If invoked by the agent** (auto-triggered):
- Identify the discussion topic from the current task context
- Summarize the relevant background as context
- Determine which users should participate

### Step 2: Generate a Short ID

Create a short identifier for the discussion:

```bash
SHORT_ID=$(date +%s | tail -c 5)
```

### Step 3: Create the Discussion Group

```bash
GROUP_NAME="讨论 · $(echo '{topic}' | head -c 30)"
lark-cli im chat create --name "${GROUP_NAME}" --description "讨论: {topic}"
```

**Parse the response** to extract the new group's `chatId` (format: `oc_xxx`).

If `lark-cli` is not available, try the alternative command:

```bash
lark-cli im +chat-create --name "${GROUP_NAME}" --description "讨论: {topic}"
```

### Step 4: Add Participants (Optional)

If specific users should be in the group:

```bash
lark-cli im chat.members create \
  --params '{"chat_id":"{chatId}","member_id_type":"open_id","succeed_type":1}' \
  --data '{"id_list":["{ou_user1}","{ou_user2}"]}' --as user
```

If no specific participants are specified, skip this step. The requesting user will be added automatically by the group creation.

### Step 5: Send Discussion Context

Send the context to the new group using MCP messaging tools. Format the context as a clear, readable card:

**Option A: Interactive card** (preferred for structured context)

Use `send_interactive` with:
- **title**: `{topic}`
- **question**: Structured context including:
  - Background of the discussion
  - Specific questions to answer
  - Any constraints or preferences
  - Source chat reference
- **options**: Actionable buttons for common responses (e.g., "同意", "需要更多信息", "反对")

**Option B: Text message** (for simple context)

Use `send_text` with a formatted message containing the discussion context.

### Step 6: Record the Mapping

Write the mapping to `workspace/bot-chat-mapping.json`:

```bash
# Read existing mappings
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Update the JSON by adding a new entry:

```json
{
  "discussion-{SHORT_ID}": {
    "chatId": "{chatId}",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

Use atomic write (write to temp file, then rename):

```bash
cat > workspace/bot-chat-mapping.json.tmp << 'MAPPING_EOF'
{updated JSON content}
MAPPING_EOF
mv workspace/bot-chat-mapping.json.tmp workspace/bot-chat-mapping.json
```

### Step 7: Confirm and Return

Report back to the original chat:

```
✅ 讨论群已创建

📝 主题: {topic}
👥 群聊: {GROUP_NAME}
📋 映射: discussion-{SHORT_ID}

讨论群已收到背景信息，等待参与者回复。当前工作将继续进行。
```

**Return immediately.** Do NOT wait for responses from the discussion group.

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not found | Report: "lark-cli 未安装，请运行 `npm install -g @larksuite/cli`" |
| Group creation fails | Report error to user, do NOT create a mapping |
| MCP send fails | Report error but keep the mapping (group was created) |
| Mapping file write fails | Log warning, group is still functional |

## Data Structure

### Mapping Entry

```typescript
{
  "discussion-{shortId}": {
    "chatId": "oc_xxx",           // Feishu group chat ID
    "createdAt": "2026-05-15T...", // ISO timestamp
    "purpose": "discussion"        // Always "discussion"
  }
}
```

### Group Name Convention

- Format: `讨论 · {topic前30字}`
- Examples: `讨论 · 是否迁移到 Bun`, `讨论 · 定时任务架构改进`

## Context Variables

When invoked, you will receive context in the system message:

- **Chat ID**: The current Feishu chat ID (the source chat)
- **Message ID**: The message ID that triggered this skill
- **Sender Open ID**: The sender's open ID (to add to the discussion)

## Examples

### Example 1: User-initiated discussion

```
/start-discussion 前端框架选型
```

1. Topic: "前端框架选型"
2. Context: Gathered from recent conversation about frontend development
3. Create group: "讨论 · 前端框架选型"
4. Send context card with pros/cons of React, Vue, Svelte
5. Record mapping: `discussion-{id}` → `{chatId}`
6. Return to user with confirmation

### Example 2: Agent-initiated discussion

Agent detects a recurring issue and needs user input:

1. Topic: "重试机制超时问题"
2. Context: Summary of 3 recent timeout incidents, current retry config
3. Create group: "讨论 · 重试机制超时问题"
4. Add relevant users (those who reported the issues)
5. Send context card with incident details and proposed solutions
6. Return to current task without waiting

## DO NOT

- ❌ Wait for responses from the discussion group
- ❌ Dissolve groups automatically
- ❌ Create duplicate groups for the same topic (check mapping first)
- ❌ Include sensitive information (API keys, tokens) in discussion context
- ❌ Add more than 10 participants to a discussion group
- ❌ Block the current agent workflow

## Related

- `chat` skill — Group lifecycle management (create, list, query, dissolve)
- `chat-timeout` skill — Automatic session cleanup for temporary discussions
- BotChatMappingStore (`packages/core/src/scheduling/bot-chat-mapping.ts`)
- Issue #631 (parent), #3283 (group management), #1228 (focus keeping), #1229 (smart session end)
